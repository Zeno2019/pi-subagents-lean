import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ChildDetails = { id?: string; sessionFile?: string };
export function wrap(pi: ExtensionAPI, upstream: (api: ExtensionAPI) => void) {
	const tools = new Map<string, ToolDefinition>();
	let latest: ChildDetails | undefined;
	upstream(
		new Proxy(pi, {
			get(target, key, receiver) {
				if (key === "registerTool")
					return (tool: ToolDefinition) => {
						tools.set(tool.name, tool);
						target.registerTool({
							...tool,
							execute: async (
								...args: Parameters<ToolDefinition["execute"]>
							) => {
								const result = await tool.execute(...args);
								if (tool.name === "subagent" || tool.name === "subagent_resume")
									latest = result.details as ChildDetails;
								return result;
							},
						});
					};
				const value = Reflect.get(target, key, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
	pi.registerTool({
		name: "probe_independent",
		label: "Independent work",
		description: "Offline fixture work.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text" as const, text: "INDEPENDENT_TOOL_DONE" }],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "probe_cancel",
		label: "Fixture cancel",
		description: "Cancel the synthetic child.",
		parameters: Type.Object({}),
		async execute(id, params, signal, update, ctx) {
			if (!latest?.id) throw new Error("No child id");
			return tools
				.get("subagent_kill")!
				.execute(id, { id: latest.id }, signal, update, ctx);
		},
	});
	pi.registerTool({
		name: "probe_resume",
		label: "Fixture resume",
		description: "Resume the synthetic child.",
		parameters: Type.Object({}),
		async execute(id, params, signal, update, ctx) {
			if (!latest?.sessionFile) throw new Error("No child session");
			await new Promise((resolve) => setTimeout(resolve, 100));
			const result = await tools
				.get("subagent_resume")!
				.execute(
					id,
					{
						sessionFile: latest.sessionFile,
						name: "resumed-fixture",
						agent: "fixture-worker",
						task: "DELAY=80 RESULT=RESUMED_CHILD",
					},
					signal,
					update,
					ctx,
				);
			latest = result.details as ChildDetails;
			return result;
		},
	});
}
