import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const text = (e) => JSON.stringify(e);
const scenarios = [
	{ name: "upstream-entry-sync", baseline: true, enabled: false, delay: 300 },
	{ name: "lean-opt-out-sync", enabled: false, delay: 300 },
	{ name: "idle-async", delay: 500 },
	{ name: "busy-async", delay: 60, busy: true },
	{ name: "fast-async", delay: 0 },
	{ name: "mixed-tools-async", delay: 500, mixed: true },
	{ name: "cancel-resume", delay: 4000, cancel: true },
];
const results = [];
const runRoot = fs.mkdtempSync(join(tmpdir(), "pi-subagents-rpc-"));
for (const s of scenarios) {
	const root = join(runRoot, s.name);
	fs.mkdirSync(join(root, "agent/agents"), { recursive: true });
	fs.writeFileSync(
		join(root, "agent/agents/fixture-worker.md"),
		"---\nname: fixture-worker\ndescription: Synthetic offline worker.\nmode: background\nsession-mode: lineage-only\nauto-exit: true\nasync: true\nthinking: off\n---\nOnly run the local synthetic task.\n",
	);
	const responses = [
		{
			tool: "subagent",
			args: {
				agent: "fixture-worker",
				name: "fixture-worker",
				title: "Offline synthetic task",
				task: `DELAY=${s.delay} RESULT=CHILD_DONE`,
			},
		},
	];
	if (s.mixed)
		responses[0] = {
			tools: [responses[0], { tool: "probe_independent", args: {} }],
		};
	if (s.cancel)
		responses.push(
			{ tool: "probe_cancel", args: {} },
			{ tool: "probe_resume", args: {} },
		);
	responses.push(
		{ text: "PARENT_INDEPENDENT_WORK_DONE", delayMs: s.busy ? 300 : 0 },
		{ text: "PARENT_RESUMED_FROM_CHILD" },
		{ text: "PARENT_FINAL" },
	);
	const env = {
		RPC_PROBE_ROOT: root,
		RPC_PROBE_PERSISTENT: "1",
		RPC_PROBE_RESPONSES: JSON.stringify(responses),
		RPC_PROBE_EXTENSION: join(
			here,
			s.baseline ? "upstream-entry.ts" : "lean-entry.ts",
		),
		PI_SUBAGENT_RPC_ASYNC: s.enabled === false ? "0" : "1",
		PI_SUBAGENT_PI_COMMAND: `"${process.execPath}" "${join(here, "fake-child.mjs")}"`,
		RPC_SUBAGENT_TEST_ROOT: root,
		PI_ARTIFACT_PROJECT_ROOT: join(root, "artifacts"),
	};
	const client = createClient({ busy: false }, env);
	try {
		client.send({
			id: "start",
			type: "prompt",
			message: "Perform the synthetic local fixture.",
		});
		await client.wait(
			(es) =>
				es.some(
					(e) => e.type === "tool_execution_end" && e.toolName === "subagent",
				),
			10000,
		);
		const launch = client.events.find(
			(e) => e.type === "tool_execution_end" && e.toolName === "subagent",
		);
		assert.equal(launch.isError, false, text(launch));
		const evidence = launch.result.details.evidence;
		assert.ok(
			evidence?.activityFile && evidence?.resultFile,
			"launch exposes evidence paths",
		);
		assert.ok(launch.result.content[0].text.includes(evidence.activityFile));
		assert.ok(launch.result.content[0].text.includes(evidence.resultFile));
		const sync = s.baseline || s.enabled === false;
		if (sync) {
			assert.equal(launch.result.details.status, "completed", text(launch));
			assert.ok(text(launch.result).includes("CHILD_DONE"));
			await client.wait((es) => es.some((e) => e.type === "agent_end"), 5000);
		} else {
			assert.equal(launch.result.details.status, "started", text(launch));
			assert.equal(launch.result.details.async, true);
			assert.ok(!launch.result.terminate);
			await client.wait(
				(es) =>
					es.some(
						(e) =>
							e.type === "message_end" &&
							e.message?.customType === "subagent_result" &&
							(!s.cancel || e.message?.details?.status === "completed"),
					),
				10000,
			);
			await client.wait(
				(es) =>
					es.some(
						(e) =>
							e.type === "message_end" &&
							e.message?.role === "assistant" &&
							text(e.message).includes("PARENT_RESUMED_FROM_CHILD"),
					),
				5000,
			);
			if (s.mixed)
				assert.ok(
					client.events.some(
						(e) =>
							e.type === "tool_execution_end" &&
							e.toolName === "probe_independent" &&
							!e.isError,
					),
					"independent work ran",
				);
			if (s.cancel) {
				assert.equal(
					client.events.find(
						(e) =>
							e.type === "tool_execution_end" && e.toolName === "probe_cancel",
					).result.details.status,
					"stopping",
				);
				assert.equal(
					client.events.find(
						(e) =>
							e.type === "tool_execution_end" && e.toolName === "probe_resume",
					).result.details.status,
					"started",
				);
				assert.ok(
					client.events.some(
						(e) =>
							e.type === "message_end" &&
							e.message?.customType === "subagent_result" &&
							text(e.message).includes("RESUMED_CHILD"),
					),
				);
			}
			const delivered = client.events.filter(
				(e) =>
					e.type === "message_end" &&
					e.message?.customType === "subagent_result",
			);
			const ids = delivered.map((e) => e.message.details.id);
			assert.equal(new Set(ids).size, ids.length, "duplicate delivery");
		}
		const messages = client.events.filter(
			(e) =>
				e.type === "message_end" && e.message?.customType === "subagent_result",
		);
		const outcome = JSON.parse(fs.readFileSync(evidence.resultFile, "utf8"));
		assert.equal(outcome.status, s.cancel ? "cancelled" : "completed");
		assert.equal(outcome.terminal, true);
		if (s.cancel) {
			const resumed = client.events.find(
				(e) => e.type === "tool_execution_end" && e.toolName === "probe_resume",
			).result;
			assert.notEqual(resumed.details.evidence.runId, evidence.runId);
			assert.ok(
				resumed.content[0].text.includes(resumed.details.evidence.activityFile),
			);
			const resumedOutcome = JSON.parse(
				fs.readFileSync(resumed.details.evidence.resultFile, "utf8"),
			);
			assert.equal(resumedOutcome.status, "completed");
		}
		results.push({
			name: s.name,
			passed: true,
			launchStatus: launch.result.details.status,
			agentStarts: client.events.filter((e) => e.type === "agent_start").length,
			deliveredResults: messages.length,
		});
		fs.writeFileSync(
			join(root, "events.json"),
			JSON.stringify(client.events, null, 2),
		);
	} catch (error) {
		fs.writeFileSync(
			join(root, "events.failed.json"),
			JSON.stringify(client.events, null, 2),
		);
		fs.writeFileSync(join(root, "stderr.log"), client.stderr);
		throw error;
	} finally {
		await client.close();
		const pidsFile = join(root, "child-pids.jsonl");
		if (fs.existsSync(pidsFile))
			for (const line of fs.readFileSync(pidsFile, "utf8").trim().split("\n")) {
				const { pid } = JSON.parse(line);
				try {
					process.kill(pid, 0);
					process.kill(-pid, "SIGTERM");
				} catch {}
			}
	}
}
const summary = {
	passed: true,
	scenarios: results,
	networkCalls: 0,
	modelCalls: 0,
};
if (process.env.RPC_TEST_REPORT)
	fs.writeFileSync(
		process.env.RPC_TEST_REPORT,
		JSON.stringify(summary, null, 2),
	);
console.log(JSON.stringify(summary, null, 2));
fs.rmSync(runRoot, { recursive: true, force: true });
