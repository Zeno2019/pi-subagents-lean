import { readFileSync } from "node:fs";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	getCompletedSubagentResultForTest,
	it,
	join,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	writeFileSync,
} from "../support/index.ts";

describe("subagent shutdown policy", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("awaits interactive surface closure during session shutdown", async () => {
		let closed = 0;
		const running = {
			id: "interactive-close",
			name: "Interactive child",
			task: "Close with parent",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/interactive-close.jsonl",
			abortController: new AbortController(),
			surfaceId: "pane:9",
		};

		const actions = await shutdownSubagentsForParentExit({
			runningSubagents: new Map([[running.id, running]]),
			completedSubagentResults: new Map(),
			parentCloseEscalationMs: 10,
			updateWidget() {},
			async closeRunningSurface(subagent) {
				assert.equal(subagent, running);
				await Promise.resolve();
				closed++;
			},
		});

		assert.deepEqual(actions, [
			{
				id: running.id,
				policy: "terminate",
				action: "terminate",
			},
		]);
		assert.equal(closed, 1);
	});

	it("honors parent close policies during session shutdown", async () => {
		const dir = createTestDir();
		const abandonSessionFile = join(dir, "abandon-child.jsonl");
		writeFileSync(abandonSessionFile, "");

		const terminateAbort = new AbortController();
		let terminateAbortCount = 0;
		terminateAbort.signal.addEventListener("abort", () => terminateAbortCount++);

		const terminate = {
			id: "child-close-1",
			name: "Terminate child",
			task: "Stop on shutdown",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "awaited" as const,
			parentClosePolicy: "terminate" as const,
			resultOwner: { kind: "wait" as const, ownerId: "wait:shutdown" },
			startTime: Date.now(),
			sessionFile: "/tmp/child-close-1.jsonl",
			abortController: terminateAbort,
		};
		const abandon = {
			id: "child-close-2",
			name: "Abandon child",
			task: "Keep running",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "awaited" as const,
			parentClosePolicy: "continue" as const,
			resultOwner: { kind: "wait" as const, ownerId: "wait:shutdown-2" },
			startTime: Date.now(),
			sessionFile: abandonSessionFile,
		};

		for (const running of [terminate, abandon]) {
			setRunningSubagentForTest(running);
		}

		const actions = await shutdownSubagentsForTest({
			escalationMs: 10,
		});

		assert.deepEqual(
			actions.map(({ id, action }) => `${id}:${action}`),
			["child-close-1:terminate", "child-close-2:continue"],
		);
		assert.equal(terminateAbortCount, 1);
		assert.equal((terminate as any).resultOwner, undefined);
		assert.equal((abandon as any).resultOwner, undefined);
		assert.equal(terminate.deliveryState, "detached");
		assert.equal(abandon.deliveryState, "detached");
		assert.equal((abandon as any).allowSteerDelivery, false);
		assert.equal(existsSync(abandon.sessionFile), true);

		const sent: Array<{ message: any; options: any }> = [];
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			abandon,
			{
				name: abandon.name,
				task: abandon.task,
				summary: "Finished after parent shutdown",
				sessionFile: abandon.sessionFile,
				exitCode: 0,
				elapsed: 4,
			},
		);

		assert.equal(sent.length, 0);
		assert.equal(getCompletedSubagentResultForTest(abandon.id), undefined);
	});
});


describe("shutdown evidence", () => {
	it("records cancellation for terminated children and preserves detached evidence for continued children", async () => {
		for (const policy of ["terminate", "continue"] as const) {
			const dir = createTestDir();
			const evidence = { runId: policy, activityFile: join(dir, "activity.jsonl"), resultFile: join(dir, "result.json") };
			const running: RunningSubagent = { id: policy, name: policy, task: "work", mode: "background", executionState: "running", deliveryState: "detached", parentClosePolicy: policy, startTime: Date.now(), sessionFile: join(dir, "session.jsonl"), evidence, abortController: new AbortController() };
			await shutdownSubagentsForParentExit({ runningSubagents: new Map([[policy, running]]), completedSubagentResults: new Map(), parentCloseEscalationMs: 1, updateWidget() {}, async closeRunningSurface() {} });
			buildCompletedSubagentResult(running, { name: policy, task: "work", summary: "watcher stopped", error: "cancelled", exitCode: 1, elapsed: 1 });
			const saved = JSON.parse(readFileSync(evidence.resultFile, "utf8"));
			assert.equal(saved.status, policy === "terminate" ? "cancelled" : "detached");
			assert.equal(saved.terminal, policy === "terminate");
		}
	});
});
