import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// Pi exposes the level type, but no public runtime syntax predicate. Keep this
// exhaustive so SDK additions require an explicit update during type checking.
const thinkingLevels: Record<ModelThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

export interface ModelRefRegistry {
	getAvailable(): Array<{ provider: string; id: string }>;
}

export interface ResolvedModelRef {
	model: string;
	thinking?: string;
}

type ModelRefInput = string | ResolvedModelRef;

function modelRefText(ref: ModelRefInput): string {
	return typeof ref === "string" ? ref : `${ref.model}${ref.thinking ? `:${ref.thinking}` : ""}`;
}

export function parseAllowedModels(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Exact full model identities win; only a recognized final level is syntax. */
export function splitModelRef(ref: string, registry?: ModelRefRegistry): {
	model: string;
	thinking?: string;
} {
	if (registry?.getAvailable().some((model) => ref === `${model.provider}/${model.id}` || ref === model.id)) {
		return { model: ref };
	}
	const idx = ref.lastIndexOf(":");
	if (idx === -1 || !Object.hasOwn(thinkingLevels, ref.slice(idx + 1))) return { model: ref };
	return { model: ref.slice(0, idx), thinking: ref.slice(idx + 1) };
}

/**
 * Combine a model and a separate thinking level into one ref. If the model
 * string already carries a valid thinking suffix, it wins and `thinking` is
 * ignored. Returns undefined when no model is given.
 */
export function buildModelRef(model: string | undefined, thinking: string | undefined, registry?: ModelRefRegistry): string | undefined {
	const trimmedModel = model?.trim();
	if (!trimmedModel) return undefined;
	if (splitModelRef(trimmedModel, registry).thinking) return trimmedModel;
	const trimmedThinking = thinking?.trim();
	return trimmedThinking ? `${trimmedModel}:${trimmedThinking}` : trimmedModel;
}

function isModelAllowed(effectiveModelRef: ModelRefInput, allowedModelRef: ModelRefInput, registry?: ModelRefRegistry): boolean {
	const effective = typeof effectiveModelRef === "string" ? splitModelRef(effectiveModelRef, registry) : effectiveModelRef;
	const allowed = typeof allowedModelRef === "string" ? splitModelRef(allowedModelRef, registry) : allowedModelRef;
	if (allowed.model !== effective.model) return false;
	return !allowed.thinking || allowed.thinking === effective.thinking;
}

export function assertModelAllowed(
	effectiveModelRef: ModelRefInput | undefined,
	allowedModelsRaw: string | undefined,
	agentName: string | undefined,
	implicitAllowedModelRefs: ModelRefInput[] = [],
	registry?: ModelRefRegistry,
): void {
	const explicitAllowedModels = parseAllowedModels(allowedModelsRaw);
	if (explicitAllowedModels.length === 0) return;
	const allowedModels = [...implicitAllowedModelRefs.filter(Boolean), ...explicitAllowedModels];
	if (!effectiveModelRef) {
		throw new Error(`Agent '${agentName ?? "subagent"}' defines allowed-models but no model was resolved.`);
	}
	if (allowedModels.some((entry) => isModelAllowed(effectiveModelRef, entry, registry))) return;
	throw new Error(
		`Model '${modelRefText(effectiveModelRef)}' is not allowed for agent '${agentName ?? "subagent"}'. ` +
			`Allowed models: ${allowedModels.map(modelRefText).join(", ")}.`,
	);
}
