# Goal

Audit BB-owned internal protocol and persistence normalization paths for permissive compatibility decoding, then tighten them so internal code only accepts canonical shapes.

# Scope

- BB-owned event envelopes, adapter request/result decoding, orchestration payloads, server-to-CLI/server-to-app protocol shapes, and normalization helpers.
- Mixed boundary decoders that currently accept multiple field spellings or fallback internal identifiers across distinct identity domains.
- Explicitly out of scope for the first pass: truly provider-owned payload variants and DB column naming, as long as they normalize once at the boundary.

# Implementation Steps

1. Inventory candidate slop sites with targeted searches for:
   - snake_case and camelCase acceptance in the same decoder
   - tolerant `threadId`/`providerThreadId` fallback chains
   - repeated `toRecord(...)` plus ad hoc field extraction for BB-owned shapes
2. Classify each site as `closed_internal` or `open_external`, and record the owning boundary where normalization should happen.
3. For `closed_internal` sites, replace permissive decode logic with canonical field access or a strict typed helper.
4. For `open_external` sites, keep tolerance only at the boundary helper and add a short comment explaining why unknown or alternate shapes are intentional.
5. Add or tighten regression tests around each cleanup so internal payload regressions fail fast.
6. Sweep call sites for duplicated decode snippets and consolidate them into typed helpers where practical.

# Validation

- Run targeted package tests for each touched area.
- Run package-scoped typechecks with `pnpm exec turbo run typecheck --filter=@bb/<pkg>`.
- For event/persistence changes, verify provider-thread lookup behavior against in-memory DB tests and one focused manual flow where identity routing matters.

# Open Questions/Risks

- Some permissive decoders may still be covering historical persisted rows; tightening them may require a one-time boundary compatibility helper or data migration.
- A few helpers may currently mix provider-owned and BB-owned fields in one function; splitting those boundaries cleanly could touch multiple packages.
- The audit should avoid turning DB snake_case column names into false positives; the target is runtime payload shape slop, not SQL naming conventions.
