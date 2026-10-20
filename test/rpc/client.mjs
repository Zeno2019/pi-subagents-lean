import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export function createClient(scenario, env = {}) {
	const child = spawn(
		process.execPath,
		[join(here, "host.mjs"), "--mode", "rpc"],
		{
			env: {
				...process.env,
				...env,
				RPC_PROBE_SCENARIO: JSON.stringify(scenario),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const events = [];
	let pending = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		pending += d;
		const lines = pending.split("\n");
		pending = lines.pop();
		for (const l of lines)
			if (l) events.push({ received: Date.now(), ...JSON.parse(l) });
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	function send(cmd) {
		child.stdin.write(JSON.stringify(cmd) + "\n");
	}
	async function wait(predicate, ms = 5000) {
		const start = Date.now();
		while (!predicate(events)) {
			if (child.exitCode !== null)
				throw new Error(`RPC exited ${child.exitCode}: ${stderr}`);
			if (Date.now() - start > ms)
				throw new Error(
					`Timeout: ${JSON.stringify(events.slice(-5))}; stderr=${stderr}`,
				);
			await new Promise((r) => setTimeout(r, 10));
		}
	}
	return {
		child,
		events,
		send,
		wait,
		get stderr() {
			return stderr;
		},
		async close() {
			child.stdin.end();
			let timer;
			await Promise.race([
				exited,
				new Promise((resolve) => {
					timer = setTimeout(() => {
						child.kill("SIGTERM");
						resolve();
					}, 3000);
				}),
			]);
			clearTimeout(timer);
			await exited;
		},
	};
}
