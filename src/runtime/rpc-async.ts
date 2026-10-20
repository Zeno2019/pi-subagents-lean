/** Opt in only a durable RPC host; print/JSON and normal TUI launches keep upstream policy. */
export function isRpcAsyncHost(argv = process.argv): boolean {
	if (process.env.PI_SUBAGENT_RPC_ASYNC !== "1") return false;
	if (argv.includes("-p") || argv.includes("--print")) return false;
	const index = argv.lastIndexOf("--mode");
	return index >= 2 && argv[index + 1] === "rpc";
}
