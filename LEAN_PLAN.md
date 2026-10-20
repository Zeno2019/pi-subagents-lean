# Lean fork plan

## Baseline and scope

- Fork: `Zeno2019/pi-subagents-lean`, from `edxeth/pi-subagents`.
- Upstream `main` and release `v2.9.2` both point to `cf6dbf41c17986f3882e6804a68e8fb8282d25e6` on 2026-10-20. This is also the installed version.
- Target runtime: Pi 0.87.1. Keep production installation, settings, agent definitions and BCP delegate unchanged during development.
- Preserve Markdown discovery, model/allowed-models/thinking validation, child permissions, cancellation, resume and tool names.

## Changes

1. Add an explicit, default-off RPC background policy. Reuse upstream launch/watch/result handling. Keep print/json/startup prompt semantics synchronous. Route asynchronous completion through followUp and allow independent parent work.
2. Add a lean package entrypoint that wraps upstream registration. Shorten tool descriptions and parameter prose while preserving schema constraints, tools, handlers and authorization.
3. Shorten the ambient roster rules without dropping agent names, descriptions, routing choices, lifecycle limits or visibility filtering. Do not merge management tools in this first version; existing names participate in permission and lifecycle contracts.
4. Pin development verification to Pi 0.87.1, document maintenance, and record measured character savings separately from tokens.

## Validation

- Establish upstream test baseline before edits.
- Add regression coverage for explicit RPC opt-in and opt-out, print/json safety, mixed tool batches, idle/busy/fast completion, cancellation and resume.
- Compare upstream and lean registration: names, schema validation, execution and render handlers remain equivalent. Preserve the model roster data and ordering.
- Run unit tests, typecheck, scoped lint/static analysis and size checks. Compare pre-existing findings with baseline.
- Reuse the isolated real Pi RPC harness with synthetic model/child processes. Do not claim full Paseo UI acceptance from this harness.
- No live model calls, production replacement or BCP delegate removal in this phase.

## Delivery

Keep runtime-policy and lean-interface changes separately reviewable. Push tested commits to the new fork, retain `upstream` for future merges, and state remaining Paseo end-to-end validation explicitly.
