import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import upstreamExtension from "./index.ts";
import {
	compactBeforeAgentStartResult,
	compactToolDefinition,
} from "./lean/metadata.ts";

/** Adapt registration metadata while upstream retains execution and authorization. */
export function createLeanApi(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) =>
					target.registerTool(compactToolDefinition(tool));
			}
			if (key === "on") {
				return (event: string, handler: (...args: unknown[]) => unknown) => {
					if (event !== "before_agent_start")
						return target.on(event as never, handler as never);
					return target.on(event, function (this: unknown, ...args: unknown[]) {
						const result = handler.apply(this, args);
						if (
							result &&
							typeof result === "object" &&
							"then" in result &&
							typeof result.then === "function"
						) {
							return Promise.resolve(result).then(
								compactBeforeAgentStartResult,
							);
						}
						return compactBeforeAgentStartResult(result);
					} as never);
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export default function leanExtension(pi: ExtensionAPI): void {
	upstreamExtension(createLeanApi(pi));
}
