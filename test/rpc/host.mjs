import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(
	dirname(
		fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
	),
);
const here = dirname(fileURLToPath(import.meta.url));
globalThis.fetch = async () => {
	throw new Error("NETWORK_FORBIDDEN");
};
const sdk = await import(pathToFileURL(join(root, "dist/index.js")));
sdk.initTheme("dark", false);
const ai = await import("@earendil-works/pi-ai");
const { runRpcMode } = await import(
	pathToFileURL(join(root, "dist/modes/rpc/rpc-mode.js"))
);
const scenario = JSON.parse(process.env.RPC_PROBE_SCENARIO);
const probeRoot = process.env.RPC_PROBE_ROOT || here;
const cwd = join(probeRoot, "workspace");
const agentDir = join(probeRoot, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const faux = ai.fauxProvider({
	provider: "rpc-offline-probe",
	tokensPerSecond: 100000,
});
const responses = process.env.RPC_PROBE_RESPONSES
	? JSON.parse(process.env.RPC_PROBE_RESPONSES).map((step) => async () => {
			if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
			return ai.fauxAssistantMessage(
				step.tools
					? step.tools.map((t) => ai.fauxToolCall(t.tool, t.args || {}))
					: step.tool
						? ai.fauxToolCall(step.tool, step.args || {})
						: step.text,
			);
		})
	: [
			ai.fauxAssistantMessage(
				ai.fauxToolCall(
					process.env.RPC_PROBE_TOOL || "launch_background",
					JSON.parse(process.env.RPC_PROBE_ARGS || "{}"),
				),
			),
			async () => {
				if (scenario.busy) await new Promise((r) => setTimeout(r, 150));
				return ai.fauxAssistantMessage("PARENT_INDEPENDENT_WORK_DONE");
			},
			ai.fauxAssistantMessage("PARENT_RESUMED_FROM_CHILD"),
		];
faux.appendResponses(responses);
const modelRuntime = await sdk.ModelRuntime.create({
	credentials: new ai.InMemoryCredentialStore(),
	modelsStore: new ai.InMemoryModelsStore(),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
modelRuntime.registerNativeProvider(faux.provider);
const settingsManager = sdk.SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
	cacheWarming: "off",
});
const loader = new sdk.DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	additionalExtensionPaths: [
		process.env.RPC_PROBE_EXTENSION || join(here, "fixture.mjs"),
	],
});
await loader.reload();
if (loader.getExtensions().errors.length)
	throw new Error(JSON.stringify(loader.getExtensions().errors));
const sessionManager =
	process.env.RPC_PROBE_PERSISTENT === "1"
		? sdk.SessionManager.create(cwd, join(probeRoot, "sessions"))
		: sdk.SessionManager.inMemory(cwd);
const { session } = await sdk.createAgentSession({
	cwd,
	agentDir,
	resourceLoader: loader,
	modelRuntime,
	model: faux.getModel(),
	thinkingLevel: "off",
	sessionManager,
	settingsManager,
});
await runRpcMode({
	session,
	setRebindSession() {},
	async dispose() {
		session.dispose();
	},
});
