import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ACTIVITY_FILE_ENV,
	ACTIVITY_RUN_ENV,
	type ActivityRecord,
	createActivityState,
	createActivityWriter,
	installActivityRecorder,
	reduceActivity,
} from "../../src/runtime/activity.ts";
import { assert, describe, it } from "../support/index.ts";

const runId = "run-activity";

function reduce(
	state: ReturnType<typeof createActivityState>,
	event: unknown,
	now = 10_000,
) {
	return reduceActivity(state, event, runId, now);
}

function records(file: string): ActivityRecord[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	return {
		pi: {
			on(name: string, handler: (event: unknown) => void) {
				const subscribed = handlers.get(name) ?? [];
				subscribed.push(handler);
				handlers.set(name, subscribed);
				return () =>
					handlers.set(
						name,
						(handlers.get(name) ?? []).filter((item) => item !== handler),
					);
			},
		} as unknown as Pick<ExtensionAPI, "on">,
		emit(name: string, event: unknown) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
		handlers,
	};
}

describe("activity projection", () => {
	it("records public assistant text deltas in event order", () => {
		let state = createActivityState();
		const start = reduce(state, { type: "session_start" });
		state = start.state;
		const delta = reduce(
			state,
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Located root cause.",
				},
			},
			11_000,
		);

		assert.deepEqual(
			[...start.records, ...delta.records].map((record) => [
				record.kind,
				record.text,
			]),
			[
				["session_start", undefined],
				["progress", "Located root cause."],
			],
		);
	});

	it("does not persist thinking or image assistant updates", () => {
		const state = createActivityState();
		const thinking = reduce(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "private" },
		});
		const image = reduce(thinking.state, {
			type: "message_update",
			assistantMessageEvent: { type: "image_delta", delta: "encoded" },
		});

		assert.deepEqual([...thinking.records, ...image.records], []);
	});

	it("resets assistant progress when a new assistant message starts", () => {
		let state = createActivityState();
		state = reduce(
			state,
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Old phase" },
			},
			10_000,
		).state;
		state = reduce(state, {
			type: "message_start",
			message: { role: "assistant" },
		}).state;
		const next = reduce(
			state,
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "New phase" },
			},
			12_000,
		);

		assert.equal(next.records[0]?.text, "New phase");
	});

	it("writes only the unseen suffix from cumulative tool output", () => {
		let state = createActivityState();
		const first = reduce(state, {
			type: "tool_execution_update",
			toolName: "bash",
			toolCallId: "tool-1",
			partialResult: { content: "line one" },
		});
		state = first.state;
		const second = reduce(state, {
			type: "tool_execution_update",
			toolName: "bash",
			toolCallId: "tool-1",
			partialResult: { content: "line one\nline two" },
		});

		assert.deepEqual(
			[...first.records, ...second.records].map((record) => record.text),
			["line one", "\nline two"],
		);
	});

	it("starts a new tool output record when a partial result resets", () => {
		let state = createActivityState();
		state = reduce(state, {
			type: "tool_execution_update",
			toolName: "bash",
			toolCallId: "tool-1",
			partialResult: { content: "long previous output" },
		}).state;
		const reset = reduce(state, {
			type: "tool_execution_update",
			toolName: "bash",
			toolCallId: "tool-1",
			partialResult: { content: "retry output" },
		});

		assert.equal(reset.records[0]?.text, "retry output");
	});

	it("keeps parallel tool output deduplication isolated by tool call id", () => {
		let state = createActivityState();
		state = reduce(state, {
			type: "tool_execution_update",
			toolName: "bash",
			toolCallId: "a",
			partialResult: { content: "same" },
		}).state;
		const other = reduce(state, {
			type: "tool_execution_update",
			toolName: "read",
			toolCallId: "b",
			partialResult: { content: "same" },
		});

		assert.equal(other.records[0]?.text, "same");
	});

	it("retains a tool failure result even when no partial update arrived", () => {
		const ended = reduce(createActivityState(), {
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tool-1",
			isError: true,
			result: { content: "command exited 1" },
		});

		assert.deepEqual(ended.records[0], {
			version: 1,
			runId,
			at: new Date(10_000).toISOString(),
			kind: "tool_end",
			tool: "bash",
			toolCallId: "tool-1",
			text: "command exited 1",
			isError: true,
		});
	});

	it("extracts in-progress todo tasks without changing the todo result", () => {
		const result = {
			content: "todos updated",
			details: {
				tasks: [
					{ id: 1, subject: "Investigate", status: "completed" },
					{
						id: 2,
						subject: "Verify",
						status: "in_progress",
						activeForm: "Verifying",
					},
				],
			},
		};
		const ended = reduce(createActivityState(), {
			type: "tool_execution_end",
			toolName: "todo",
			toolCallId: "todo-1",
			result,
		});

		assert.deepEqual(ended.records[1]?.tasks, [
			{
				id: 2,
				subject: "Verify",
				status: "in_progress",
				activeForm: "Verifying",
			},
		]);
		assert.equal(result.details.tasks[1]?.status, "in_progress");
	});
});

describe("activity recorder", () => {
	it("does not subscribe or create files when the child evidence environment is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-activity-"));
		try {
			const fake = fakePi();
			installActivityRecorder(fake.pi, {});
			fake.emit("session_start", { type: "session_start" });

			assert.equal(fake.handlers.size, 0);
			assert.equal(existsSync(join(dir, "activity.jsonl")), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes hook events and unsubscribes every listener on disposal", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-activity-"));
		const file = join(dir, "activity.jsonl");
		try {
			const fake = fakePi();
			const dispose = installActivityRecorder(fake.pi, {
				[ACTIVITY_FILE_ENV]: file,
				[ACTIVITY_RUN_ENV]: runId,
			});
			fake.emit("session_start", { type: "session_start" });
			dispose();
			fake.emit("session_shutdown", { type: "session_shutdown" });

			assert.deepEqual(
				records(file).map((record) => record.kind),
				["session_start"],
			);
			assert.ok(
				[...fake.handlers.values()].every(
					(subscribed) => subscribed.length === 0,
				),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rotates bounded activity logs before appending more evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-activity-"));
		const file = join(dir, "activity.jsonl");
		try {
			const write = createActivityWriter(file, 140);
			write([
				{
					version: 1,
					runId,
					at: "2026-01-01T00:00:00.000Z",
					kind: "progress",
					text: "a".repeat(70),
				},
			]);
			write([
				{
					version: 1,
					runId,
					at: "2026-01-01T00:00:01.000Z",
					kind: "progress",
					text: "b".repeat(70),
				},
			]);

			assert.equal(existsSync(`${file}.previous`), true);
			assert.equal(records(file)[0]?.text, "b".repeat(70));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not throw from a recorder event when its activity path cannot be written", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-activity-"));
		try {
			const fake = fakePi();
			installActivityRecorder(fake.pi, {
				[ACTIVITY_FILE_ENV]: join(dir, "missing", "activity.jsonl"),
				[ACTIVITY_RUN_ENV]: runId,
			});
			rmSync(join(dir, "missing"), { recursive: true, force: true });
			assert.doesNotThrow(() =>
				fake.emit("session_start", { type: "session_start" }),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
