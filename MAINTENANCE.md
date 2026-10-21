# Maintenance

## Baseline

- Parent repository: `edxeth/pi-subagents`.
- Upstream release: 2.9.2, commit `cf6dbf41c17986f3882e6804a68e8fb8282d25e6`.
- Last upstream check: 2026-10-20; `main` still pointed to that commit.
- Development SDK and existing automated-test baseline: Pi 0.87.1. This records the test environment, not an exclusive compatibility range.
- This is the edxeth implementation with Markdown presets. It is distinct from lean wrappers for other packages also named pi-subagents.

## Patch ownership

`src/runtime/activity.ts` projects child extension events into bounded JSONL
activity records. The mandatory child helper installs it; child stdout and the
launch/notification lifecycle retain their existing roles. `activity-evidence.ts`
owns nonthrowing evidence creation and atomic outcome snapshots, using paths from
`artifact-storage.ts`. Launch and resume allocate distinct evidence identities;
timeout wrap-up reuses the run. The parent runtime remains authoritative for final
status, including failures that cannot emit child hooks. Detached observations are
nonterminal. Preserve this distinction when adding recovery or UI consumers.

Regression tests cover event projection, bounded files, outcome durability,
failure/cancel/ping delivery, and headless operation. Run the existing RPC suite as
well: evidence reads must not consume or duplicate completion delivery. Do not
change agent Todo allowlists or add a global task store as part of observability.

For live recorder verification, run `scripts/test-e2e-live-activity.mjs` with a
user-selected `PI_SUBAGENT_LIVE_MODEL=provider/model` (repeat for a second family).
The real SDK RPC parent uses synthetic responses and the child uses the live
model. The smoke checks in-flight output, public phases, an intentional tool
error, terminal evidence and one completion delivery. It copies auth/model config
to a private temporary directory and removes the entire test environment afterward.
It does not verify interactive mux rendering or detached-parent restart recovery.

`src/runtime/rpc-async.ts` defines the explicit RPC-only opt-in. The launch guard, coordinator stop policy, mixed-batch classifier and completion delivery share it. The switch does not override an agent's explicit synchronous setting. Resume uses the same launch guard. Keep print-mode children synchronous even when they inherit the environment variable.

`src/lean.ts` wraps upstream registration. `src/lean/metadata.ts` changes only known tool descriptions, schema descriptions, prompt snippets and roster prose. It retains schema fields and constraints, Typebox symbols, handlers, tool names and agent entries. Unknown roster rules pass through unchanged so a future upstream rule is not silently deleted. Upstream lifecycle instructions remain the source for mode-specific prompt text.

`src/agents/model-refs.ts` preserves exact model identities, including colon tags.
An exact registered ID wins over thinking-suffix syntax; only a final Pi thinking
level may be split otherwise. Launch and resume keep resolved identity and
thinking separate through allowlist checks, persisted metadata and child argv.
The roster displays the default model and thinking separately, alongside explicit
allowed overrides. Do not copy Pi's fuzzy matching or invalid-suffix fallback into
these exact model and allowlist paths.

`test/runtime/rpc-async.test.ts` locks the runtime policy. `test/lean/metadata.test.ts` locks the wrapper contract. `test/rpc/` runs real SDK RPC with local synthetic processes, without credentials or model requests. The small orchestrator fixture change supplies the normalized system-prompt fields expected by the development SDK.

Do not merge management tool names without reviewing spawning grants, denied tools, orchestrator allowlists, mixed-batch classification and historical session calls. Do not hide model choices or edit user Markdown presets as a prompt optimization.

## Validation and installation

Run typecheck, unit tests, the offline SDK RPC scenarios and metadata measurement when changing the fork. Compare inherited failures with a clean upstream checkout using the same dependencies; the inherited full suite has environment-dependent verifier and fixture failures and is not represented as fully green.

Load only this fork or the original package to avoid duplicate management tools. Preserve user Markdown definitions, tool allowlists and permission policy. Asynchronous background execution does not bypass authorization. Set `PI_SUBAGENT_RPC_ASYNC=1` only on a durable RPC host that continues receiving events after a parent turn finishes.

Offline synthetic tests verify runtime contracts without model requests. They do not establish instruction-following quality, host UI rendering or daemon restart recovery. Validate those capabilities separately when relevant to a host integration.

## Updating upstream

1. Fetch `upstream` and inspect release notes, SDK dependencies and APIs before merging. Do not upgrade the user's Pi runtime to satisfy a new upstream release.
2. Review host API requirements before adopting upstream changes; update compatibility declarations only with supporting evidence.
3. Recheck the registration/schema/roster mappings and RPC policy locations. Preserve unknown text unless its behavior is understood.
4. Run typecheck, unit tests, the RPC smoke and metadata measurement. Compare inherited test/lint findings with a clean upstream checkout using the same dependencies.
5. Treat any real-model or production/Paseo acceptance run separately from offline fixtures; report what actually ran.
