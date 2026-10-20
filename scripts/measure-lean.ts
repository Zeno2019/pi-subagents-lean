import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import upstream from "../src/index.ts";
import {
	compactRosterReminder,
	compactToolDefinition,
} from "../src/lean/metadata.ts";
import {
	getAgentListEntriesForTest,
	renderAgentListReminderForTest,
} from "../src/testing/test-helpers.ts";
import { isHeadlessLaunchSession } from "../src/tools/subagent-tools.ts";

const tools: ToolDefinition[] = [];
const api = {
	on() {},
	registerTool(tool: ToolDefinition) {
		tools.push(tool);
	},
	registerCommand() {},
	registerShortcut() {},
	registerMessageRenderer() {},
} as unknown as ExtensionAPI;
upstream(api);

function visible(tool: ToolDefinition): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
	});
}
const entries = getAgentListEntriesForTest();
const roster = renderAgentListReminderForTest(entries, {
	awaitAllLaunches: isHeadlessLaunchSession(true),
});
const beforeTools = tools.reduce((sum, tool) => sum + visible(tool).length, 0);
const afterTools = tools.reduce(
	(sum, tool) => sum + visible(compactToolDefinition(tool)).length,
	0,
);
const before = beforeTools + roster.length;
const after = afterTools + compactRosterReminder(roster).length;
console.log(
	JSON.stringify(
		{
			unit: "characters, not tokens",
			tools: tools.map((tool) => tool.name),
			agents: entries.length,
			toolMetadata: { before: beforeTools, after: afterTools },
			roster: {
				before: roster.length,
				after: compactRosterReminder(roster).length,
			},
			combined: {
				before,
				after,
				saved: before - after,
				reductionPercent: Number(
					(((before - after) / before) * 100).toFixed(2),
				),
			},
		},
		null,
		2,
	),
);
