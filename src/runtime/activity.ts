import {
	appendFileSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ACTIVITY_FILE_ENV = "PI_SUBAGENT_ACTIVITY_FILE";
export const ACTIVITY_RUN_ENV = "PI_SUBAGENT_RUN_ID";
const ACTIVITY_MAX_BYTES = 1024 * 1024;
const TEXT_LIMIT = 4000;
const MAX_TRACKED_TOOLS = 128;

export interface ActivityRecord {
	version: 1;
	runId: string;
	at: string;
	kind: string;
	toolCallId?: string;
	tool?: string;
	args?: string;
	text?: string;
	isError?: boolean;
	tasks?: Array<{
		id?: number;
		subject: string;
		status: string;
		activeForm?: string;
	}>;
}

interface OutputSnapshot {
	length: number;
	tail: string;
}
export interface ActivityState {
	toolOutputs: ReadonlyMap<string, OutputSnapshot>;
	reply: string;
	lastReplyAt: number;
}

export function createActivityState(): ActivityState {
	return { toolOutputs: new Map(), reply: "", lastReplyAt: 0 };
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function clipped(value: unknown, limit = TEXT_LIMIT): string {
	const text = typeof value === "string" ? value : "";
	return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function contentText(value: unknown): string {
	const content = object(value).content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((item) => object(item).type === "text")
				.map((item) => object(item).text ?? "")
				.join("\n")
		: "";
}

function formatArgs(value: unknown): string {
	try {
		return clipped(
			JSON.stringify(value, (key, item) =>
				/^(authorization|cookie|password|secret|api[_-]?key|access[_-]?token)$/i.test(
					key,
				)
					? "[redacted]"
					: item,
			),
		);
	} catch {
		return "[unserializable arguments]";
	}
}

/** Only public text and tool evidence enter the projection; thinking/image payloads do not. */
export function reduceActivity(
	state: ActivityState,
	input: unknown,
	runId: string,
	now = Date.now(),
): { state: ActivityState; records: ActivityRecord[] } {
	const event = object(input);
	const records: ActivityRecord[] = [];
	let next = state;
	const add = (kind: string, fields: Partial<ActivityRecord> = {}) => {
		records.push({
			version: 1,
			runId,
			at: new Date(now).toISOString(),
			kind,
			...fields,
		});
	};
	const tool = typeof event.toolName === "string" ? event.toolName : undefined;
	const toolCallId =
		typeof event.toolCallId === "string" ? event.toolCallId : undefined;
	switch (event.type) {
		case "session_start":
		case "agent_start":
		case "agent_settled":
		case "session_shutdown":
			add(event.type);
			break;
		case "turn_start":
			add("turn_start", { text: `Turn ${event.turnIndex ?? "?"}` });
			break;
		case "ui_prompt_start":
		case "ui_prompt_end":
			add(event.type, { text: clipped(event.title, 500) });
			break;
		case "message_start":
			if (object(event.message).role === "assistant")
				next = { ...state, reply: "", lastReplyAt: 0 };
			break;
		case "message_update": {
			const delta = object(event.assistantMessageEvent);
			if (delta.type !== "text_delta") break;
			const reply = clipped(
				state.reply + (typeof delta.delta === "string" ? delta.delta : ""),
			);
			const emit = reply.trim() && now - state.lastReplyAt >= 1000;
			next = { ...state, reply, lastReplyAt: emit ? now : state.lastReplyAt };
			if (emit) add("progress", { text: reply });
			break;
		}
		case "message_end": {
			const message = object(event.message);
			if (message.role !== "assistant") break;
			const text = clipped(contentText(message));
			if (text) add("progress", { text });
			if (message.stopReason === "error" || message.errorMessage) {
				add("agent_error", {
					text:
						clipped(message.errorMessage) || "Assistant stopped with an error",
					isError: true,
				});
			} else if (message.stopReason === "aborted") add("agent_interrupted");
			next = { ...state, reply: "", lastReplyAt: 0 };
			break;
		}
		case "tool_execution_start":
			add("tool_start", { tool, toolCallId, args: formatArgs(event.args) });
			break;
		case "tool_execution_update": {
			const text = contentText(event.partialResult);
			if (!toolCallId || !text) break;
			const previous = state.toolOutputs.get(toolCallId);
			const extendsPrevious =
				previous &&
				text.length >= previous.length &&
				text.slice(previous.length - previous.tail.length, previous.length) ===
					previous.tail;
			const addition = extendsPrevious ? text.slice(previous.length) : text;
			const toolOutputs = new Map(state.toolOutputs);
			toolOutputs.set(toolCallId, {
				length: text.length,
				tail: text.slice(-TEXT_LIMIT),
			});
			if (toolOutputs.size > MAX_TRACKED_TOOLS) {
				const oldest = toolOutputs.keys().next().value;
				if (oldest !== undefined) toolOutputs.delete(oldest);
			}
			next = { ...state, toolOutputs };
			if (addition)
				add("tool_output", { tool, toolCallId, text: clipped(addition) });
			break;
		}
		case "tool_execution_end": {
			const toolOutputs = new Map(state.toolOutputs);
			if (toolCallId) toolOutputs.delete(toolCallId);
			next = { ...state, toolOutputs };
			add("tool_end", {
				tool,
				toolCallId,
				text: clipped(contentText(event.result)),
				isError: event.isError === true,
			});
			if (tool === "todo") {
				const tasks = object(object(event.result).details).tasks;
				if (Array.isArray(tasks)) {
					const active = tasks
						.map(object)
						.filter((task) => task.status === "in_progress")
						.slice(0, 8);
					add("task_progress", {
						tasks: active.map((task) => ({
							id: typeof task.id === "number" ? task.id : undefined,
							subject: clipped(task.subject, 300),
							status: "in_progress",
							activeForm: clipped(task.activeForm, 300) || undefined,
						})),
					});
				}
			}
			break;
		}
	}
	return { state: next, records };
}

/** Synchronous bounded writes preserve evidence even when the helper exits without draining timers. */
export function createActivityWriter(
	file: string,
	maxBytes = ACTIVITY_MAX_BYTES,
) {
	let size: number | undefined;
	return (records: ActivityRecord[]): void => {
		if (!records.length) return;
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		if (size === undefined) {
			try {
				size = statSync(file).size;
			} catch {
				size = 0;
			}
		}
		const text = records
			.map((record) => `${JSON.stringify(record)}\n`)
			.join("");
		const bytes = Buffer.byteLength(text);
		if (size > 0 && size + bytes > maxBytes) {
			rmSync(`${file}.previous`, { force: true });
			renameSync(file, `${file}.previous`);
			size = 0;
		}
		appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
		size += bytes;
	};
}

export function installActivityRecorder(
	pi: Pick<ExtensionAPI, "on">,
	env = process.env,
): () => void {
	const file = env[ACTIVITY_FILE_ENV];
	const runId = env[ACTIVITY_RUN_ENV];
	if (!file || !runId) return () => {};
	let state = createActivityState();
	let warned = false;
	const write = createActivityWriter(file);
	const record = (event: unknown) => {
		try {
			const reduced = reduceActivity(state, event, runId);
			state = reduced.state;
			write(reduced.records);
		} catch (error) {
			if (!warned)
				process.stderr.write(
					`[subagent activity unavailable] ${String(error)}\n`,
				);
			warned = true;
		}
	};
	const unsubscribe = [
		pi.on("session_start", record),
		pi.on("session_shutdown", record),
		pi.on("agent_start", record),
		pi.on("agent_settled", record),
		pi.on("turn_start", record),
		pi.on("message_start", record),
		pi.on("message_update", record),
		pi.on("message_end", record),
		pi.on("tool_execution_start", record),
		pi.on("tool_execution_update", record),
		pi.on("tool_execution_end", record),
		pi.on("ui_prompt_start", record),
		pi.on("ui_prompt_end", record),
	];
	return () => {
		for (const off of unsubscribe) if (typeof off === "function") off();
	};
}
