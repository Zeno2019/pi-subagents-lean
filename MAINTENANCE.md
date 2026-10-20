# Maintenance

## Baseline

- Parent repository: `edxeth/pi-subagents`.
- Upstream release: 2.9.2, commit `cf6dbf41c17986f3882e6804a68e8fb8282d25e6`.
- Last upstream check: 2026-10-20; `main` still pointed to that commit.
- Supported/tested host for this fork: Pi 0.87.1. The host peer and development SDK versions are pinned accordingly.
- This is the edxeth implementation with Markdown presets. It is distinct from lean wrappers for other packages also named pi-subagents.

## Patch ownership

`src/runtime/rpc-async.ts` defines the explicit RPC-only opt-in. The launch guard, coordinator stop policy, mixed-batch classifier and completion delivery share it. The switch does not override an agent's explicit synchronous setting. Resume uses the same launch guard. Keep print-mode children synchronous even when they inherit the environment variable.

`src/lean.ts` wraps upstream registration. `src/lean/metadata.ts` changes only known tool descriptions, schema descriptions, prompt snippets and roster prose. It retains schema fields and constraints, Typebox symbols, handlers, tool names and agent entries. Unknown roster rules pass through unchanged so a future upstream rule is not silently deleted. Upstream lifecycle instructions remain the source for mode-specific prompt text.

`test/runtime/rpc-async.test.ts` locks the runtime policy. `test/lean/metadata.test.ts` locks the wrapper contract. `test/rpc/` runs real SDK RPC with local synthetic processes, without credentials or model requests. The small orchestrator fixture change supplies Pi 0.87.1's normalized system-prompt fields.

Do not merge management tool names without reviewing spawning grants, denied tools, orchestrator allowlists, mixed-batch classification and historical session calls. Do not hide model choices or edit user Markdown presets as a prompt optimization.

## Validation on 2026-10-20

- 23 new RPC policy tests and 14 lean contract tests passed.
- Seven real Pi SDK RPC scenarios passed, including opt-out, idle/busy/fast completion, mixed tools and cancellation/resume.
- Typecheck, new-file Biome check and source/test size checks passed. Biome still reports non-failing style warnings in fixture code.
- Against the same Pi 0.87.1 dependencies, bounded upstream/core comparison passed 1,026 tests upstream and 1,063 in this fork: the 37 additions passed. The failed/cancelled test identities were unchanged. They concern macOS canonical-path expectations, unavailable skill fixtures and verifier dependencies/processes. One existing verifier assertion failed upstream and timed out in the fork run.
- The unfiltered upstream test attempt also failed on verifier environment setup. The suite is not represented as fully green.
- Knip findings match upstream: one unused file, one unused development dependency, 17 unused exports and seven unused exported types. No new finding was introduced.
- Character measurement using six local presets: tool metadata 8,779 → 2,929; roster 6,332 → 5,685; combined 15,111 → 8,614. This does not measure actual billed tokens or the whole session.

Paseo 0.12.0 source inspection confirms that its Pi launcher defaults to `--mode rpc`, so the opt-in argv check matches that host. Its persistent session subscription also survives the end of a foreground turn.

A real Paseo CLI/MCP acceptance subsequently passed with Pi 0.87.1 and GPT-6.1 Sol high for both parent and child. The launch returned `started`; the parent yielded before completion; one result arrived and triggered another parent response 28.682 seconds after the first response. The parent transcript contained only one user message. Paseo's activity stream included both responses and the result, and its final status was idle with no pending permissions. The test agent was archived. Computer Use was not used.

The real-model test loaded only this fork. A separate local combination check loads all 29 currently enabled extension entrypoints, including the global permission gate, retained UI extensions and BCP with delegation disabled. Its six Markdown preset checks preserve model choices, thinking and background/lineage-only policy. External MCP schemas come from the existing cache, network fetches are blocked, and responses are synthetic. This verifies local loading and tool policy, not external services or model behavior with that entire combination.

A combined lifecycle check also passed with those entrypoints: the real `subagent` handler started a local synthetic child process, returned `started`, let the parent finish, and delivered exactly one result that triggered a new parent response. The test UI answered `Allow Once` to the existing permission request. The fake model and child avoid external inference; this check complements the separate real Paseo test rather than replacing it.

BCP's actual compression kernel separately passed compression, persistent-session reopen, search for a detail absent from the summary, and byte-exact recall with delegation disabled. Only `compress` and `acp_context` remain registered.

No screenshot/rendering, daemon restart recovery, cross-model quality or live-model acceptance of the full extension combination is claimed. The RPC environment switch remains explicit and off by default.

## Local configuration migration

Before replacing an existing installation:

1. Load only this fork, removing the original package entry from the effective configuration.
2. Set `PI_SUBAGENT_RPC_ASYNC=1` in the actual durable RPC host environment.
3. If retiring BCP delegation, set its `delegate` option to `false`; retain the context extension.
4. Check Markdown tool allowlists against the installed tools. For the BCP lean surface, replace `decompress`, `search_context`, `acp_status` and `acp_cache` with `acp_context`, retaining `compress`.
5. If Hashline replaced the built-in editor, editing roles need `replace`, `insert` and `undo_last_change` instead of `edit`; search roles need `anchor_grep` instead of `grep`. Keep those editing tools out of read-only roles.
6. Preserve the user's permission policy. The local policy used in acceptance asks for approval before `subagent`; background execution does not grant permission to bypass that approval.

## Updating upstream

1. Fetch `upstream` and inspect release notes, SDK dependencies and APIs before merging. Do not upgrade the user's Pi runtime to satisfy a new upstream release.
2. Keep the current Pi 0.87.1 branch when newer upstream code requires a newer host.
3. Recheck the registration/schema/roster mappings and RPC policy locations. Preserve unknown text unless its behavior is understood.
4. Run typecheck, unit tests, the RPC smoke and metadata measurement. Compare inherited test/lint findings with a clean upstream checkout using the same dependencies.
5. Treat any real-model or production/Paseo acceptance run separately from offline fixtures; report what actually ran.
