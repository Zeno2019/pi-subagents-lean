import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertModelAllowed, buildModelRef, splitModelRef } from "../../src/agents/model-refs.ts";
import { renderAgentListReminder } from "../../src/agents/agent-list.ts";
import { buildChildLaunchPlan, normalizeModelRef } from "../../src/launch/child-launch-plan.ts";
import { getPreparedModelArgs, getPersistedSessionParityArgs } from "../../src/launch/prep.ts";
import { resolveResumeLaunchMetadataForInvocation } from "../../src/runtime/resume-service.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { createTestDir } from "../support/index.ts";

const modelRegistry = {
	getAvailable: () => ["engine", "engine:1017", "engine:latest", "engine:group:1017", "engine:high", "engine-extra"].map(id => ({
		provider: "synthetic", id, reasoning: true,
	})),
};

describe("tagged model references", () => {
	it("keeps non-thinking tags and splits only a valid final thinking suffix", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.deepEqual(splitModelRef(`synthetic/engine:1017:${level}`), { model: "synthetic/engine:1017", thinking: level });
		}
		for (const tag of ["1017", "latest", "group:1017", "unknown"]) {
			const model = `synthetic/engine:${tag}`;
			assert.deepEqual(splitModelRef(model), { model });
			assert.deepEqual(splitModelRef(`${model}:high`), { model, thinking: "high" });
			assert.equal(buildModelRef(model, "high"), `${model}:high`);
			assert.equal(normalizeModelRef(model, "high").effectiveModel, model);
		}
		assert.equal(buildModelRef("synthetic/engine:1017:low", "high"), "synthetic/engine:1017:low");
	});

	it("preserves tags through launch, defaults, exact allowlists and explicit suffix precedence", async () => {
		const cwd = createTestDir();
		const launch = (model: string | undefined, thinking = "high", allowedModels = "synthetic/engine:1017") => buildChildLaunchPlan({
			params: { name: "tag-check", agent: "tags", task: "check", title: "Tags", model, thinking },
			agentDefs: { model: "synthetic/engine:latest", thinking: "low", allowedModels, extensions: "none", skills: "none" },
			parentCwd: cwd, parentSessionDir: cwd, modelRegistry,
		});
		for (const model of ["synthetic/engine:1017", "engine:1017"]) {
			const plan = await launch(model);
			assert.equal(plan.effectiveModel, "synthetic/engine:1017");
			assert.equal(plan.effectiveThinking, "high");
			assert.equal(plan.effectiveModelRef, "synthetic/engine:1017:high");
		}
		assert.equal((await launch("synthetic/engine:1017:low")).effectiveThinking, "low");
		assert.equal((await launch(undefined, "low")).effectiveModelRef, "synthetic/engine:latest:low");
		await assert.rejects(launch("synthetic/engine:1017", "high", "synthetic/engine:1017:low"), /not allowed/);
		await assert.rejects(launch("synthetic/engine:unknown"), /Unknown model override/);
		await assert.rejects(launch("synthetic/eng"), /Unknown model override/);
		assert.throws(() => assertModelAllowed("synthetic/engine:latest:high", "synthetic/engine:1017", "test"), /not allowed/);
	});

	it("gives a registered complete id priority even when it ends with a thinking word", async () => {
		const cwd = createTestDir();
		const plan = await buildChildLaunchPlan({
			params: { name: "tag-check", agent: "tags", task: "check", title: "Tags", model: "synthetic/engine:high", thinking: "low" },
			agentDefs: { allowedModels: "synthetic/engine:high", extensions: "none", skills: "none" },
			parentCwd: cwd, parentSessionDir: cwd, modelRegistry,
		});
		assert.equal(plan.effectiveModel, "synthetic/engine:high");
		assert.equal(plan.effectiveModelRef, "synthetic/engine:high:low");
		assert.deepEqual(splitModelRef("synthetic/engine:high", modelRegistry), { model: "synthetic/engine:high" });
		assert.equal(buildModelRef("synthetic/engine:high", "low", modelRegistry), "synthetic/engine:high:low");
		assert.equal(normalizeModelRef("synthetic/engine:high", "low").effectiveModel, "synthetic/engine:high");
		assert.throws(() => assertModelAllowed("synthetic/engine:high:low", "synthetic/engine", "tags", [], modelRegistry), /not allowed/);
	});

	it("does not strip a second colon segment when rebuilding without a registry", async () => {
		const cwd = createTestDir();
		const plan = await buildChildLaunchPlan({
			params: { name: "tag-check", agent: "tags", task: "check", title: "Tags" },
			agentDefs: { model: "synthetic/engine:high:low", extensions: "none", skills: "none" },
			parentCwd: cwd, parentSessionDir: cwd,
		});
		assert.equal(plan.effectiveModel, "synthetic/engine:high");
		assert.equal(plan.effectiveThinking, "low");
		assert.equal(plan.effectiveModelRef, "synthetic/engine:high:low");
	});

	it("checks resolved identities before ambiguous refs are serialized", async () => {
		const cwd = createTestDir();
		const launch = (allowedModels: string) => buildChildLaunchPlan({
			params: { name: "tag-check", agent: "tags", task: "check", title: "Tags", model: "synthetic/engine", thinking: "high" },
			agentDefs: { allowedModels, extensions: "none", skills: "none" },
			parentCwd: cwd, parentSessionDir: cwd, modelRegistry,
		});
		const plan = await launch("synthetic/engine");
		assert.deepEqual(getPreparedModelArgs(plan), ["--model", "synthetic/engine", "--thinking", "high"]);
		await assert.rejects(launch("synthetic/engine:high"), /not allowed/);
		assert.throws(() => assertModelAllowed("synthetic/engine:high:low", "synthetic/engine:1017", "tags", [], modelRegistry), /not allowed/);
	});

	it("preserves tagged identity and allowlist authority on resume", async () => {
		const metadata: PersistedSubagentLaunchMetadata = {
			version: 1, timestamp: "2026-01-01T00:00:00Z", name: "tags", mode: "background", sessionMode: "lineage-only",
			parentClosePolicy: "continue", async: true, model: "synthetic/engine:latest", thinking: "low",
			modelRef: "synthetic/engine:latest:low", definitionModel: "synthetic/engine:latest", definitionThinking: "low",
			allowedModels: "synthetic/engine:1017,synthetic/engine:high", denyTools: [], noContextFiles: false,
			noSession: false, agentConfigDir: "/tmp", cwd: "/tmp", boundarySystemPrompt: true,
		};
		for (const model of ["synthetic/engine:1017", "synthetic/engine:high"]) {
			const resumed = resolveResumeLaunchMetadataForInvocation(metadata, model, "low", modelRegistry);
			assert.equal(resumed?.model, model);
			assert.equal(resumed?.modelRef, `${model}:low`);
		}
		assert.equal(resolveResumeLaunchMetadataForInvocation(metadata, undefined, "low", modelRegistry)?.modelRef, metadata.modelRef);
		assert.equal(resolveResumeLaunchMetadataForInvocation(metadata, "synthetic/engine:1017:high", "low", modelRegistry)?.modelRef, "synthetic/engine:1017:high");
		assert.throws(() => resolveResumeLaunchMetadataForInvocation(metadata, "synthetic/engine:unknown", "low", modelRegistry), /Unknown model override/);
		assert.throws(() => resolveResumeLaunchMetadataForInvocation(metadata, "synthetic/engine", "low", modelRegistry), /not allowed/);
		const frozen = resolveResumeLaunchMetadataForInvocation({ ...metadata, allowModelOverride: false }, "synthetic/engine:1017", "high", modelRegistry);
		assert.equal(frozen?.modelRef, metadata.modelRef);
		assert.equal(frozen?.ignoredModelOverride, "synthetic/engine:1017");
		const collision = { ...metadata, model: "synthetic/engine", modelRef: "synthetic/engine:high", thinking: "high", definitionModel: "synthetic/engine", definitionThinking: "high" };
		const resumed = resolveResumeLaunchMetadataForInvocation(collision, undefined, "high", modelRegistry);
		assert.equal(resumed?.model, "synthetic/engine");
		assert.deepEqual((await getPersistedSessionParityArgs(resumed)).slice(0, 4), ["--model", "synthetic/engine", "--thinking", "high"]);
		assert.deepEqual((await getPersistedSessionParityArgs({ ...metadata, model: undefined })).slice(0, 2), ["--model", metadata.modelRef]);
	});

	it("shows tagged model plus separate thinking consistently in roster metadata", () => {
		for (const tag of ["1017", "high"]) {
			const roster = renderAgentListReminder([{
				name: "tags", source: "project", description: "Check tags", sessionMode: "standalone", spawning: false,
				visibleTo: ["all"], model: `synthetic/engine:${tag}`, thinking: "high", allowedModels: "synthetic/engine:latest",
			}], { modelRegistry });
			assert.ok(roster.includes(`default_model: synthetic/engine:${tag}\n  default_thinking: high`));
			assert.ok(roster.includes("models: synthetic/engine:latest"));
		}
	});
});
