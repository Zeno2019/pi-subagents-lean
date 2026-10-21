#!/usr/bin/env node
// The parent uses the real SDK RPC loop with a synthetic provider; only the
// delegated child uses the explicitly selected live model. No installed presets
// or extensions are changed, and credentials stay in a temporary private folder.
import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../test/rpc/client.mjs";

const model = process.env.PI_SUBAGENT_LIVE_MODEL;
if (!model)
	throw new Error(
		"Set PI_SUBAGENT_LIVE_MODEL to a user-selected provider/model reference.",
	);
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-live-activity-"));
const agentDir = join(root, "agent");
const source =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const records = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line)];
					} catch {
						return [];
					}
				})
		: [];
let client;
try {
	mkdirSync(join(agentDir, "agents"), { recursive: true, mode: 0o700 });
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		if (!existsSync(join(source, file))) continue;
		copyFileSync(join(source, file), join(agentDir, file));
		chmodSync(join(agentDir, file), 0o600);
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
	);
	writeFileSync(
		join(agentDir, "agents/activity-probe.md"),
		[
			"---",
			"name: activity-probe",
			"description: Isolated live activity recorder smoke.",
			"mode: background",
			"session-mode: lineage-only",
			"auto-exit: true",
			"async: true",
			`model: ${model}`,
			"thinking: high",
			"tools: bash",
			"extensions: none",
			"skills: none",
			"no-context-files: true",
			"timeout: 180",
			"---",
			"Follow the diagnostic task exactly.",
			"",
		].join("\n"),
	);
	const task = [
		"This is an isolated diagnostics test. Do not inspect any files or use the network.",
		"First state PHASE_DIAGNOSE in public text, then call bash exactly once with:",
		"printf 'ACTIVITY_RUNNING\\n'; sleep 3; printf 'EXPECTED_TOOL_FAILURE\\n' >&2; exit 7",
		"The nonzero exit is intentional. Do not retry or fix it.",
		"Then state PHASE_WRAP_UP publicly and finish with ACTIVITY_SMOKE_DONE and the observed error.",
	].join("\n");
	client = createClient(
		{},
		{
			RPC_PROBE_ROOT: root,
			RPC_PROBE_PERSISTENT: "1",
			RPC_PROBE_EXTENSION: join(here, "../test/rpc/lean-entry.ts"),
			RPC_PROBE_RESPONSES: JSON.stringify([
				{
					tool: "subagent",
					args: {
						agent: "activity-probe",
						name: "activity-probe",
						title: "Live activity diagnostics",
						task,
					},
				},
				{ text: "PARENT_INDEPENDENT_WORK_DONE" },
				{ text: "PARENT_RESUMED_FROM_CHILD" },
			]),
			PI_SUBAGENT_RPC_ASYNC: "1",
			PI_SUBAGENT_PI_COMMAND: process.env.PI_SUBAGENT_PI_COMMAND || "pi",
			PI_ARTIFACT_PROJECT_ROOT: join(root, "artifacts"),
		},
	);
	client.send({
		id: "start",
		type: "prompt",
		message: "Run the isolated child diagnostics test.",
	});
	await client.wait(
		(events) =>
			events.some(
				(e) => e.type === "tool_execution_end" && e.toolName === "subagent",
			),
		15000,
	);
	const launched = client.events.find(
		(e) => e.type === "tool_execution_end" && e.toolName === "subagent",
	);
	assert.equal(launched.isError, false, JSON.stringify(launched));
	assert.equal(launched.result.details.status, "started");
	const evidence = launched.result.details.evidence;
	assert.ok(launched.result.content[0].text.includes(evidence.activityFile));
	assert.ok(launched.result.content[0].text.includes(evidence.resultFile));
	let observedInFlight = false;
	await client.wait(() => {
		const activity = records(evidence.activityFile);
		const current = JSON.parse(readFileSync(evidence.resultFile, "utf8"));
		if (
			activity.some(
				(e) => e.kind === "tool_output" && e.text.includes("ACTIVITY_RUNNING"),
			) &&
			!activity.some((e) => e.kind === "tool_end" && e.tool === "bash") &&
			!current.terminal
		)
			observedInFlight = true;
		return current.terminal;
	}, 210000);
	const result = JSON.parse(readFileSync(evidence.resultFile, "utf8"));
	const activity = records(evidence.activityFile);
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.ok(
		observedInFlight,
		"No streamed output was readable while the bash call was still running",
	);
	assert.ok(
		activity.some(
			(e) =>
				e.kind === "tool_end" &&
				e.isError &&
				e.text.includes("EXPECTED_TOOL_FAILURE"),
		),
	);
	assert.ok(
		activity.some(
			(e) => e.kind === "progress" && e.text.includes("PHASE_DIAGNOSE"),
		),
	);
	assert.ok(
		activity.some(
			(e) => e.kind === "progress" && e.text.includes("PHASE_WRAP_UP"),
		),
	);
	assert.ok(result.summary.includes("ACTIVITY_SMOKE_DONE"));
	assert.ok(result.sessionFile && existsSync(result.sessionFile));
	assert.ok(result.recentActivity.length > 0);
	assert.ok(activity.every((e) => e.runId === evidence.runId));
	await client.wait((events) =>
		events.some(
			(e) =>
				e.type === "message_end" && e.message?.customType === "subagent_result",
		),
	);
	const summary = {
		passed: true,
		model,
		outcome: "clean_yield",
		observedInFlight,
		toolErrorRecorded: true,
		phasesRecorded: true,
		resultStatus: result.status,
		deliveredResults: client.events.filter(
			(e) =>
				e.type === "message_end" && e.message?.customType === "subagent_result",
		).length,
		activityKinds: [...new Set(activity.map((e) => e.kind))],
	};
	assert.equal(summary.deliveredResults, 1);
	if (process.env.PI_SUBAGENT_LIVE_REPORT)
		writeFileSync(
			process.env.PI_SUBAGENT_LIVE_REPORT,
			JSON.stringify(summary, null, 2),
		);
	console.log(JSON.stringify(summary, null, 2));
} finally {
	await client?.close();
	rmSync(root, { recursive: true, force: true });
}
