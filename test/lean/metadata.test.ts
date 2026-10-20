import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	type AgentListEntry,
	renderAgentListReminder,
} from "../../src/agents/agent-list.ts";
import upstreamExtension from "../../src/index.ts";
import {
	compactBeforeAgentStartResult,
	compactRosterReminder,
	compactToolDefinition,
} from "../../src/lean/metadata.ts";
import leanExtension, { createLeanApi } from "../../src/lean.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { registerSubagentCoreTools } from "../../src/tools/subagent-tools.ts";
import {
	createTestDir,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

const savedArgv = [...process.argv];
const savedRpc = process.env.PI_SUBAGENT_RPC_ASYNC;
const savedCoordinator = process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
const savedDir = process.env.PI_CODING_AGENT_DIR;
const savedDeny = process.env.PI_DENY_TOOLS;
const savedCwd = process.cwd();

function stripDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripDescriptions);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<PropertyKey, unknown>;
	return Object.fromEntries(
		Reflect.ownKeys(record)
			.filter((key) => key !== "description" || typeof record[key] !== "string")
			.map((key) => [key, stripDescriptions(record[key])]),
	);
}

function captureTools() {
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	registerSubagentCoreTools(pi, () => true, {} as never);
	registerSubagentResumeTool(pi, () => true, {} as never);
	return tools;
}

function rosterBlock(content: string): string | undefined {
	return content.match(/<subagent-roster>[\s\S]*?<\/subagent-roster>/)?.[0];
}

const entries: AgentListEntry[] = [
	{
		name: "worker",
		description: "Worker <literal> text",
		source: "global",
		mode: "background",
		sessionMode: "lineage-only",
		async: true,
		autoExit: true,
		spawning: ["scout"],
		visibleTo: ["all"],
		model: "example/main",
		thinking: "high",
		allowedModels: "example/fallback:low,example/second:medium",
		spawnDepth: 2,
		spawnWidth: 3,
		timeout: 60,
		idleTimeout: 30,
		contextWarnThreshold: "80%",
		reportContextUsage: false,
		llmAsVerifier: true,
	},
];

describe("lean metadata contract", () => {
	afterEach(() => {
		process.argv = [...savedArgv];
		process.chdir(savedCwd);
		const env: [string, string | undefined][] = [
			["PI_SUBAGENT_RPC_ASYNC", savedRpc],
			["PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN", savedCoordinator],
			["PI_CODING_AGENT_DIR", savedDir],
			["PI_DENY_TOOLS", savedDeny],
		];
		for (const [key, value] of env) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("preserves all original schemas and handlers except their prose", () => {
		for (const tool of captureTools().values()) {
			const lean = compactToolDefinition(tool);
			assert.equal(lean.name, tool.name);
			assert.deepEqual(
				stripDescriptions(lean.parameters),
				stripDescriptions(tool.parameters),
			);
			for (const key of Reflect.ownKeys(tool).filter(
				(key) =>
					!["parameters", "description", "promptSnippet"].includes(String(key)),
			)) {
				assert.equal(lean[key], tool[key]);
			}
			assert.ok(lean.description.length <= tool.description.length);
			assert.ok(
				lean.promptSnippet.length < tool.promptSnippet.length,
				tool.name,
			);
		}
	});

	it("preserves symbols, named description fields, literals, enums and validation boundaries", () => {
		const marker = Symbol("schema-contract");
		const parameters = Type.Object(
			{
				description: Type.String({
					minLength: 2,
					maxLength: 4,
					description: "User-facing field.",
				}),
				choice: Type.Union([Type.Literal("first"), Type.Literal("second")], {
					description: "A choice.",
				}),
				optional: Type.Optional(
					Type.Number({
						minimum: 1,
						maximum: 3,
						description: "Optional count.",
					}),
				),
			},
			{ additionalProperties: false, description: "Schema prose." },
		);
		Object.defineProperty(parameters, marker, {
			value: "symbol-value",
			enumerable: false,
		});
		const lean = compactToolDefinition({
			name: "subagent",
			parameters,
			description: "Long description",
			promptSnippet: "Long snippet",
		});
		assert.equal(Reflect.get(lean.parameters, marker), "symbol-value");
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(lean.parameters, marker),
			Object.getOwnPropertyDescriptor(parameters, marker),
		);
		assert.equal(lean.parameters.properties.description.type, "string");
		assert.deepEqual(lean.parameters.required, parameters.required);
		for (const value of [
			{ description: "ok", choice: "first" },
			{ description: "ok", choice: "second", optional: 2 },
			{ choice: "first" },
			{ description: "x", choice: "first" },
			{ description: "12345", choice: "first" },
			{ description: "ok", choice: "bad" },
			{ description: "ok", choice: "first", optional: 0 },
			{ description: "ok", choice: "first", extra: true },
		])
			assert.equal(Check(lean.parameters, value), Check(parameters, value));
		assert.equal(
			Reflect.get(parameters, "description"),
			"Schema prose.",
			"upstream schema remains untouched",
		);
	});

	it("leaves unrelated tools and enum/const payload objects unchanged", () => {
		const tool = {
			name: "other",
			parameters: Type.String({ description: "Keep me." }),
		};
		assert.equal(compactToolDefinition(tool), tool);
		const payload = { description: "Literal data, not schema prose." };
		const schema = {
			type: "object",
			const: payload,
			description: "Schema prose.",
		};
		const lean = compactToolDefinition({
			name: "subagent",
			parameters: schema,
		});
		assert.equal(lean.parameters.const, payload);
		assert.deepEqual(lean.parameters.const, {
			description: "Literal data, not schema prose.",
		});
	});

	for (const mode of ["rpc", "json", "tui"]) {
		it(`keeps launch and resume instructions aligned with ${mode} policy`, () => {
			process.argv = [
				"node",
				"pi",
				...(mode === "tui" ? [] : ["--mode", mode]),
			];
			process.env.PI_SUBAGENT_RPC_ASYNC = "1";
			delete process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
			for (const name of ["subagent", "subagent_resume"]) {
				const lean = compactToolDefinition(captureTools().get(name));
				if (mode === "json")
					assert.match(lean.promptSnippet, /every launch waits/i);
				else
					assert.match(
						lean.promptSnippet,
						mode === "rpc" ? /follow-up/ : /steer/,
					);
				assert.match(lean.promptSnippet, /model.*thinking|model\/thinking/);
			}
		});
	}

	it("keeps print children synchronous even if RPC opt-in is inherited", () => {
		process.argv = ["node", "pi", "--mode", "rpc", "-p"];
		process.env.PI_SUBAGENT_RPC_ASYNC = "1";
		assert.match(
			compactToolDefinition(captureTools().get("subagent")).promptSnippet,
			/every launch waits/i,
		);
	});

	for (const awaitAllLaunches of [false, true]) {
		it(`keeps the entire roster byte-identical (awaitAll=${awaitAllLaunches})`, () => {
			const source = renderAgentListReminder(entries, { awaitAllLaunches });
			const lean = compactRosterReminder(source);
			assert.equal(rosterBlock(lean), rosterBlock(source));
			assert.ok(lean.length < source.length);
			assert.match(lean, /ignores model.*thinking|no.*models.*ignores/i);
			assert.match(lean, /unlisted|listed models|explicit list/);
		});
	}

	it("preserves unknown rules, descriptions and other result fields", () => {
		const source = renderAgentListReminder(entries).replace(
			"</subagent-rules>",
			"- Future rule with exact formatting.\n</subagent-rules>",
		);
		const details = { entries, signature: "signature", supersedes: true };
		const input = {
			message: {
				customType: "subagent_roster",
				content: source,
				details,
				display: false,
			},
			systemPrompt: "Keep the rest verbatim",
			extra: {},
		};
		const result = compactBeforeAgentStartResult(input);
		assert.match(
			result.message.content,
			/- Future rule with exact formatting\.\n/,
		);
		assert.equal(rosterBlock(result.message.content), rosterBlock(source));
		assert.equal(result.message.details, details);
		assert.equal(result.systemPrompt, input.systemPrompt);
		assert.equal(result.extra, input.extra);
		assert.equal(compactBeforeAgentStartResult(undefined), undefined);
		const other = { message: { customType: "other", content: source } };
		assert.equal(compactBeforeAgentStartResult(other), other);
		assert.equal(
			compactRosterReminder("Unknown future content"),
			"Unknown future content",
		);
	});

	it("passes API calls, tool handler arguments, and sync/async hook results through", async () => {
		let registered: any;
		const hooks: any[] = [];
		const target = {
			registerTool(tool: unknown) {
				assert.equal(this, target);
				registered = tool;
			},
			on(...args: unknown[]) {
				hooks.push(args);
			},
			other(...args: unknown[]) {
				assert.equal(this, target);
				return args;
			},
		};
		const api = createLeanApi(target as unknown as ExtensionAPI) as any;
		const args = [{ secret: "opaque" }, "id", 2];
		const execute = (...received: unknown[]) => received;
		api.registerTool({
			name: "subagent",
			parameters: Type.Object({}),
			execute,
		});
		assert.equal(registered.execute, execute);
		assert.deepEqual(registered.execute(...args), args);
		assert.deepEqual(api.other(...args), args);
		const result = {
			message: {
				customType: "subagent_roster",
				content: renderAgentListReminder(entries),
			},
		};
		api.on("before_agent_start", (...received: unknown[]) => {
			assert.deepEqual(received, args);
			return result;
		});
		assert.equal(
			typeof hooks[0][1](...args)?.then,
			"undefined",
			"sync handlers stay synchronous",
		);
		assert.equal(
			rosterBlock(hooks[0][1](...args).message.content),
			rosterBlock(result.message.content),
		);
		api.on("before_agent_start", async () => result);
		assert.equal(
			rosterBlock((await hooks[1][1]()).message.content),
			rosterBlock(result.message.content),
		);
		const ordinary = () => result;
		api.on("agent_end", ordinary);
		assert.equal(hooks[2][1], ordinary);
	});

	for (const [agents, denied] of [
		[false, ""],
		[true, ""],
		[true, "subagent,subagent_resume"],
	] as const) {
		it(`preserves upstream registration gating (agents=${agents}, denied=${denied})`, () => {
			const dir = createTestDir();
			process.env.PI_CODING_AGENT_DIR = join(dir, "config");
			process.env.PI_DENY_TOOLS = denied;
			mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "agents"), {
				recursive: true,
			});
			process.chdir(dir);
			if (agents)
				writeFileSync(
					join(process.env.PI_CODING_AGENT_DIR, "agents", "worker.md"),
					"---\nname: worker\ndescription: Worker\n---\nWorker body",
				);
			function capture(extension: (pi: ExtensionAPI) => void) {
				const registrations: string[] = [];
				const api = {
					registerTool: (tool: { name: string }) =>
						registrations.push(`tool:${tool.name}`),
					on: (event: string) => registrations.push(`on:${event}`),
					registerCommand: (name: string) =>
						registrations.push(`command:${name}`),
					registerShortcut: (name: string) =>
						registrations.push(`shortcut:${name}`),
					registerMessageRenderer: (name: string) =>
						registrations.push(`renderer:${name}`),
				};
				extension(api as unknown as ExtensionAPI);
				return registrations;
			}
			const lean = capture(leanExtension);
			assert.deepEqual(lean, capture(upstreamExtension));
			if (denied) {
				assert.equal(lean.includes("tool:subagent"), false);
				assert.equal(lean.includes("tool:subagent_resume"), false);
			}
			if (!agents) assert.deepEqual(capture(leanExtension), []);
		});
	}
});
