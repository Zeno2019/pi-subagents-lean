import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { classifyAssistantMessageForMixedBatch } from "../../src/runtime/batch-classifier.ts";
import { deliverCompletedSubagentResult } from "../../src/runtime/result-router.ts";
import { isRpcAsyncHost } from "../../src/runtime/rpc-async.ts";
import { shouldAwaitSubagentLaunch } from "../../src/runtime/running-registry.ts";
import {
	buildCompletedSubagentResult,
	getCoordinatorOnlyTurnPrompt,
	getSubagentBatchStopMetadata,
	isSubagentBatchBlocking,
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
} from "../../src/runtime/state.ts";
import { applySynchronousLaunchPolicy } from "../../src/tools/policy.ts";
import {
	isHeadlessLaunchSession,
	registerSubagentCoreTools,
	shouldForceSynchronousLaunch,
} from "../../src/tools/subagent-tools.ts";
import type { SubagentParamsInput } from "../../src/types.ts";

const savedArgv = [...process.argv];
const keys = [
	"PI_SUBAGENT_RPC_ASYNC",
	"PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN",
	"PI_SUBAGENT_AUTO_EXIT",
];
const savedEnv = new Map(keys.map((key) => [key, process.env[key]]));

function configure(args: string[], enabled?: string): void {
	process.argv = ["node", "pi", ...args];
	for (const key of keys) delete process.env[key];
	if (enabled !== undefined) process.env.PI_SUBAGENT_RPC_ASYNC = enabled;
	resetSubagentBatchStopRequest();
}

function deliveryMode(): unknown {
	let sentOptions: unknown;
	const completed = buildCompletedSubagentResult(
		{
			id: "rpc-child",
			name: "rpc-child",
			task: "test",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/rpc-child.jsonl",
		},
		{
			name: "rpc-child",
			task: "test",
			summary: "Done",
			exitCode: 0,
			elapsed: 0,
		},
	);
	deliverCompletedSubagentResult(
		{
			sendMessage: (_message, options) => {
				sentOptions = options;
			},
		},
		completed,
		String,
	);
	return sentOptions;
}

describe("explicit RPC background policy", () => {
	afterEach(() => {
		process.argv = [...savedArgv];
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentBatchStopRequest();
	});

	for (const enabled of [undefined, "0", "true", ""]) {
		it(`keeps RPC synchronous without exact opt-in (${String(enabled)})`, () => {
			configure(["--mode", "rpc"], enabled);
			assert.equal(shouldForceSynchronousLaunch(false), true);
			requestSubagentBatchStop();
			assert.deepEqual(getSubagentBatchStopMetadata(), { terminate: true });
			assert.deepEqual(deliveryMode(), {
				triggerTurn: true,
				deliverAs: "nextTurn",
			});
		});
	}

	it("allows an explicitly opted-in RPC host without a UI to stay asynchronous", () => {
		configure(["--mode", "rpc"], "1");
		assert.equal(isHeadlessLaunchSession(false), false);
		assert.equal(shouldForceSynchronousLaunch(false), false);
		requestSubagentBatchStop();
		assert.deepEqual(getSubagentBatchStopMetadata(), {});
		assert.match(
			getCoordinatorOnlyTurnPrompt(),
			/may continue with non-overlapping work/,
		);
		assert.deepEqual(deliveryMode(), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("keeps the opted-in RPC parent running after launching a child", () => {
		configure(["--mode", "rpc"], "1");
		requestSubagentBatchStop();
		assert.deepEqual(getSubagentBatchStopMetadata(), {});
		assert.match(
			getCoordinatorOnlyTurnPrompt(),
			/may continue with non-overlapping work/,
		);
	});

	it("delivers opted-in RPC results with a triggered follow-up", () => {
		configure(["--mode", "rpc"], "1");
		assert.deepEqual(deliveryMode(), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	for (const enabled of [undefined, "1"]) {
		it(`describes the actual RPC delivery policy (opt-in ${String(enabled)})`, () => {
			configure(["--mode", "rpc"], enabled);
			let snippet = "";
			registerSubagentCoreTools(
				{
					registerTool: (tool: { name: string; promptSnippet: string }) => {
						if (tool.name === "subagent") snippet = tool.promptSnippet;
					},
				} as never,
				(name) => name === "subagent",
				{} as never,
			);
			if (enabled === "1") {
				assert.match(snippet, /follow-up message/);
				assert.doesNotMatch(snippet, /every launch waits/);
			} else {
				assert.match(snippet, /every launch waits/);
			}
		});
	}

	for (const args of [
		["-p", "--mode", "rpc"],
		["--mode", "rpc", "--print"],
		["--mode", "json"],
		["--mode=rpc"],
		["--mode"],
		[],
	]) {
		it(`does not enable background RPC for ${JSON.stringify(args)}`, () => {
			configure(args, "1");
			assert.equal(shouldForceSynchronousLaunch(false), true);
			requestSubagentBatchStop();
			assert.deepEqual(getSubagentBatchStopMetadata(), { terminate: true });
		});
	}

	it("requires a complete RPC mode argument after the executable and script", () => {
		configure([], "1");
		for (const args of [
			["--mode", "rpc"],
			["node", "--mode", "rpc"],
			["node", "pi", "--mode"],
			["node", "pi", "--mode", "rpc", "--mode", "json"],
		]) {
			assert.equal(isRpcAsyncHost(args), false);
		}
		assert.equal(isRpcAsyncHost(["node", "pi", "--mode", "rpc"]), true);
	});

	it("keeps interactive startup prompts synchronous and ordinary TUI asynchronous", () => {
		configure([], "1");
		assert.equal(
			shouldForceSynchronousLaunch(true, ["node", "pi", "do work"]),
			true,
		);
		assert.equal(shouldForceSynchronousLaunch(true, ["node", "pi"]), false);
	});

	it("does not treat the existing coordinator opt-out as RPC async support", () => {
		configure(["--mode", "rpc"]);
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		assert.equal(shouldForceSynchronousLaunch(false), true);
		requestSubagentBatchStop();
		assert.deepEqual(getSubagentBatchStopMetadata(), {});
		assert.deepEqual(deliveryMode(), { triggerTurn: true, deliverAs: "steer" });
	});

	it("does not override explicit synchronous child policy", () => {
		configure(["--mode", "rpc"], "1");
		const params = {
			name: "sync-child",
			task: "test",
			async: false,
			blocking: true,
		} as SubagentParamsInput;
		applySynchronousLaunchPolicy(
			params,
			{ async: false } as AgentDefaults,
			true,
			shouldForceSynchronousLaunch(false),
		);
		assert.equal(params.async, false);
		assert.equal(params.blocking, true);
		assert.equal(shouldAwaitSubagentLaunch(params), true);
	});

	it("retains a barrier established by a synchronous sibling", () => {
		configure(["--mode", "rpc"], "1");
		markSubagentBatchBlocking();
		assert.equal(
			shouldAwaitSubagentLaunch({ async: true, blocking: false }),
			true,
		);
	});

	for (const name of ["subagent", "subagent_resume"]) {
		it(`allows independent sibling tools alongside opted-in ${name}`, () => {
			configure(["--mode", "rpc"], "1");
			classifyAssistantMessageForMixedBatch(
				{
					role: "assistant",
					content: [
						{ type: "toolCall", name, arguments: { agent: "worker" } },
						{ type: "toolCall", name: "bash", arguments: { command: "pwd" } },
					],
				},
				() => ({ name: "worker", async: true }) as AgentDefaults,
			);
			assert.equal(isSubagentBatchBlocking(), false);
			assert.equal(
				shouldAwaitSubagentLaunch({ async: true, blocking: false }),
				false,
			);
		});
	}

	it("keeps the mixed async batch barrier when RPC opt-in is absent", () => {
		configure(["--mode", "rpc"]);
		classifyAssistantMessageForMixedBatch(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "subagent",
						arguments: { agent: "worker" },
					},
					{ type: "toolCall", name: "bash", arguments: {} },
				],
			},
			() => ({ name: "worker", async: true }) as AgentDefaults,
		);
		assert.equal(isSubagentBatchBlocking(), true);
	});
});
