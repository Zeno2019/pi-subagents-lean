import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const testRoot = resolve(process.env.RPC_SUBAGENT_TEST_ROOT);
if (!session || !resolve(session).startsWith(testRoot + "/"))
	throw new Error("Unexpected session path");
fs.appendFileSync(
	resolve(testRoot, "child-pids.jsonl"),
	JSON.stringify({ pid: process.pid, session }) + "\n",
);
const text = args
	.map((a) =>
		a.startsWith("@") && fs.existsSync(a.slice(1))
			? fs.readFileSync(a.slice(1), "utf8")
			: a,
	)
	.join("\n");
const delay = Number(text.match(/DELAY=(\d+)/)?.[1] ?? 100);
const marker = text.match(/RESULT=([A-Z_]+)/)?.[1] ?? "CHILD_DONE";
setTimeout(() => {
	const entries = fs
		.readFileSync(session, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);
	const message = {
		type: "message",
		id: randomUUID().slice(0, 8),
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: marker }],
			api: "test",
			provider: "local-fixture",
			model: "no-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
	fs.appendFileSync(session, JSON.stringify(message) + "\n");
	process.stdout.write(marker + "\n");
}, delay);
