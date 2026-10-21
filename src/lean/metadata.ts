import { getAfterLaunchPrompt } from "../tools/subagent-tools.ts";

type ToolMetadata = {
	name: string;
	description?: string;
	promptSnippet?: string;
	parameters?: unknown;
};

const DESCRIPTIONS: Record<string, string> = {
	subagent:
		"Launch named helpers from Markdown presets; batch parallel tasks with children.",
	subagent_resume:
		"Continue an earlier helper session; optionally add a follow-up task.",
	subagent_kill: "Stop a running helper by id or display name.",
};

const AFTER_LAUNCH_RULES = new Map([
	[
		"- In this session every launch waits for the helper and returns its report as the tool result. Read the report and continue; do not redo delegated work.",
		"- Every launch waits; read the tool report and continue without repeating delegated work.",
	],
	[
		"- If a helper returns later, continue only with clearly independent work. Do not redo delegated work and do not claim the helper's findings before its later message appears.",
		"- With detached helpers, do independent work only; wait for reports before claiming findings.",
	],
	[
		"- If no safe independent work is clear, stop your response and wait for the later helper message.",
		"- If no independent work remains, end your response and await the report.",
	],
	[
		"- Ask the user only when there is a plausible next step but ownership is ambiguous.",
		"- Ask only if the next step's ownership is unclear.",
	],
	[
		"Results arrive automatically as a steer message that starts a new turn. Read the returned activity and run-evidence files on demand for progress or failure diagnosis; do not repeatedly poll for completion.",
		"Results arrive automatically by steer; inspect returned evidence on demand, without polling for completion.",
	],
	[
		"Results arrive automatically as a follow-up message that starts a new turn. Read the returned activity and run-evidence files on demand for progress or failure diagnosis; do not repeatedly poll for completion.",
		"Results arrive automatically by follow-up; inspect returned evidence on demand, without polling for completion.",
	],
	[
		"You may continue with non-overlapping work after launching a tool_return=later_message helper. Do not redo delegated work or claim results before the later report appears.",
		"Independent work may continue; avoid duplicating helpers or claiming unread results.",
	],
	[
		"For helpers with tool_return=later_message, the runtime may stop after this tool batch so the helper's later report can be inserted into this chat. Do not redo delegated work or claim results before the later report appears.",
		"The runtime may end this tool batch to deliver helper reports; do not duplicate their work.",
	],
]);

function compactAfterLaunchPrompt(): string {
	return getAfterLaunchPrompt()
		.split("\n")
		.map((line) => AFTER_LAUNCH_RULES.get(line) ?? line)
		.join("\n");
}

function toolSnippet(name: string): string {
	if (name === "subagent_kill")
		return "Stop a running helper by id or display name.";
	const routing =
		"Set model/thinking only when the user named concrete values; otherwise keep preset defaults. ";
	if (name === "subagent_resume") {
		return (
			"Use sessionFile from earlier output; task adds an instruction, agent keeps its original name, name sets its display label. " +
			"Saved metadata controls launch mode; mode is only a fallback. " +
			routing +
			compactAfterLaunchPrompt()
		);
	}
	return (
		"Use an exact roster agent with name/title/task; batch parallel tasks in children, each requested agent once. " +
		"name: lower-kebab scope-role, 2–4 words, ≤32 chars; title: sentence case, 3–8 words, task-focused. " +
		"Give fresh-context helpers a self-contained brief (goal/files/constraints/output); keep parallel scopes separate. " +
		"Copy model refs intact, preserving tags such as :latest; use thinking separately when needed. " +
		routing +
		compactAfterLaunchPrompt()
	);
}

const SCHEMA_MAPS = [
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
];
const SCHEMA_CHILDREN = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
	"contentSchema",
];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];

function compactSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema))
		return schema;
	const descriptors = Object.getOwnPropertyDescriptors(schema);
	if (typeof descriptors.description?.value === "string")
		delete descriptors.description;
	for (const key of SCHEMA_MAPS) {
		const map = descriptors[key]?.value;
		if (!map || typeof map !== "object" || Array.isArray(map)) continue;
		const children = Object.getOwnPropertyDescriptors(map);
		for (const name of Object.keys(children)) {
			if ("value" in children[name])
				children[name].value = compactSchema(children[name].value);
		}
		descriptors[key].value = Object.create(
			Object.getPrototypeOf(map),
			children,
		);
	}
	for (const key of [...SCHEMA_CHILDREN, ...SCHEMA_ARRAYS]) {
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) continue;
		descriptor.value = Array.isArray(descriptor.value)
			? descriptor.value.map(compactSchema)
			: compactSchema(descriptor.value);
	}
	return Object.create(Object.getPrototypeOf(schema), descriptors);
}

export function compactToolDefinition<T extends ToolMetadata>(tool: T): T {
	if (!Object.hasOwn(DESCRIPTIONS, tool.name)) return tool;
	return {
		...tool,
		description: DESCRIPTIONS[tool.name],
		promptSnippet: toolSnippet(tool.name),
		...(tool.parameters === undefined
			? {}
			: { parameters: compactSchema(tool.parameters) }),
	};
}

const ROSTER_INTRO =
	"You can launch separate helper agents with the subagent tool. Use this roster to choose exact agent names and to understand how each launched agent behaves.";
const ROSTER_RULES = new Map([
	[
		"- Agent names are exact values for subagent.agent or children[].agent.",
		"- Use exact agent names in subagent.agent or children[].agent.",
	],
	[
		"- tool_return=wait_here means the subagent tool call waits until the helper finishes.",
		"- wait_here: wait for the helper's tool result.",
	],
	[
		"- tool_return=wait_here means the subagent tool call waits until the helper finishes. In this session every launch waits, so read the report in the tool result and continue.",
		"- wait_here: every launch waits; read its tool report and continue.",
	],
	[
		"- tool_return=later_message means the tool call starts the helper and returns before the work is done; do not invent its findings.",
		"- later_message: launch returns before completion; await the later report.",
	],
	[
		"- runs_as=visible_terminal means a human can watch or type into the helper session. runs_as=hidden_process means no visible terminal is opened.",
		"- visible_terminal: human-visible/input; hidden_process: no terminal.",
	],
	[
		"- context=fresh_chat_needs_full_brief means write a self-contained task with objective, files, constraints, and expected output.",
		"- fresh_chat_needs_full_brief: provide goal, files, constraints and output.",
	],
	[
		"- context=copy_of_this_chat means the helper starts from this conversation; give scope, boundary, and expected output without repeating all background.",
		"- copy_of_this_chat: inherits conversation; specify scope, boundaries and output.",
	],
	[
		"- completion=exits_automatically means the helper should finish and close itself. completion=human_or_agent_must_finish means the session stays open until the human or helper explicitly completes it.",
		"- exits_automatically: closes itself; human_or_agent_must_finish: stays open until explicitly finished.",
	],
	[
		"- `default_model:` and `default_thinking:` run when model/thinking are omitted; this default combination is always allowed. `models:` lists additional accepted overrides; `models: any model ref` accepts any available model. An agent with no `models:` line ignores model and thinking overrides. Copy a listed ref intact into model; preserve model tags such as :latest and use thinking separately when needed. Never use an unlisted override when an explicit list is present.",
		"- default_model/default_thinking apply when omitted; the default combination is always allowed. models lists additional overrides; 'any model ref' allows available models. No models line ignores model/thinking overrides. Copy listed refs intact into model, preserving tags; use thinking separately. Never use an unlisted override with an explicit list.",
	],
	[
		"- `context-warn: Y%` makes this agent wrap up and report before its own context window fills, so its work is not lost to compaction. When a result says the agent stopped early, the stop saved the report. Do not resume an agent that stopped this way. Start a new agent for the unfinished work.",
		"- context-warn: wraps up before context fills; an early-stop report is intentional. Start a fresh helper for remaining work; do not resume it.",
	],
	[
		"- A `copy_of_this_chat` agent with `context-warn` starts with this conversation already using part of its window, so it has less room for its own work.",
		"- Forked context-warn helpers start with inherited context and less room.",
	],
	[
		"- `report-context-usage: false` hides the token counts in the result. When this agent stops early, the result still reports it.",
		"- report-context-usage:false hides token counts, not early-stop notices.",
	],
	[
		"- `llm-as-a-verifier: true` means one launch runs several independent attempts of the task and an LLM verifier picks the best one; you receive exactly one result. Wait for that result before you launch this agent again. It needs a clean Git tree — the launch fails immediately otherwise.",
		"- llm-as-a-verifier: multiple attempts, one chosen result; await it before relaunching. Requires a clean Git tree.",
	],
	[
		"- If the user names an agent that is not listed, say it was not found and stop; do not suggest a different listed agent.",
		"- If a requested agent is missing, report that and stop; do not substitute.",
	],
]);

for (const idleNote of ["", " A steer you send is not its output."]) {
	ROSTER_RULES.set(
		"- `timeout: X` stops this agent when its whole run reaches X. `idle-timeout: X` stops it when it makes no output for X." +
			idleNote +
			" A stop is not a failure. The result holds the partial work, or it says that the agent made no output. Read the result text. It tells you what to do next.",
		"- timeout caps the run; idle-timeout caps time without child output." +
			(idleNote ? " Parent steers are not child output." : "") +
			" A stop is intentional; read partial output and follow the result's next-step guidance.",
	);
}

export function compactRosterReminder(content: string): string {
	const start = content.indexOf("<subagent-roster>");
	const end = content.indexOf("</subagent-roster>", start);
	if (start === -1 || end === -1) return content;
	const afterRoster = end + "</subagent-roster>".length;
	const prefix = content
		.slice(0, start)
		.replace(ROSTER_INTRO, "Named helper roster (use subagent):");
	const suffix = content.slice(afterRoster).replace(
		/<subagent-rules>([\s\S]*?)<\/subagent-rules>/,
		(_match, rules: string) =>
			`<subagent-rules>${rules
				.split("\n")
				.map((line) => ROSTER_RULES.get(line) ?? line)
				.join("\n")}</subagent-rules>`,
	);
	return prefix + content.slice(start, afterRoster) + suffix;
}

export function compactBeforeAgentStartResult<T>(result: T): T {
	if (!result || typeof result !== "object" || !("message" in result))
		return result;
	const message = result.message;
	if (
		!message ||
		typeof message !== "object" ||
		!("customType" in message) ||
		message.customType !== "subagent_roster" ||
		!("content" in message) ||
		typeof message.content !== "string"
	)
		return result;
	return {
		...result,
		message: { ...message, content: compactRosterReminder(message.content) },
	};
}
