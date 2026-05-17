# Pi Bridge Parity

Status: Phases 1–4 shipped. Remaining work is Phase 5 (re-capture fixtures + close out documentation). See "Shipped" below.

## Shipped

- `instructionMode` contract on `PiInstructionCommand` (`"append" | "replace"`) resolved at the adapter boundary in `packages/agent-runtime/src/pi/adapter.ts` (`resolvePiInstructionOverrides`).
- Default is `"append"` (`packages/agent-runtime/src/pi/runtime.ts`). Worker threads append; explicit managers opt into `"replace"` via `packages/agent-runtime/src/pi/thread-runtime-config.ts`.
- `packages/agent-runtime/src/pi/bridge/sdk-session.ts` now uses `appendSystemPromptOverride` on the append path. The destructive `systemPrompt + noExtensions/noSkills/noPromptTemplates/noThemes` loader path is reached only on explicit `"replace"`.
- Net effect: a normal bb Pi session preserves Pi defaults (extensions, skills, templates, themes) and layers bb's instructions on top, matching native `pi` behavior. The previous "stripped custom mode" is now opt-in, not the default.

## Goal

Make the bb Pi bridge behave as closely as practical to a normal Pi coding
session, unless we intentionally opt into a different mode and document that
difference.

## Why This Matters

The provider audit showed a persistent behavior gap:

- direct Pi sessions default to the coding tool set `read`, `bash`, `edit`,
  `write`
- `grep`, `find`, and `ls` are real first-class Pi tools, but they are opt-in
- when those extra tools are not enabled, Pi usually routes that work through
  `bash`

That part is expected. The parity risk was that bb used to start Pi in
something closer to a custom stripped-down session than to a normal Pi session.
That has been fixed via the `instructionMode` change above.

## Original Evidence (pre-fix; kept for context)

### Direct Pi CLI behavior

- `pi --help` reports the default coding tools as `read,bash,edit,write`
- direct `pi --mode json` runs still prefer `bash` even when prompted to use
  `ls`, `find`, and `grep`
- direct `pi --mode json --tools read,bash,edit,write,grep,find,ls ...` emits
  real `ls` and `find` tool calls

### bb bridge behavior (pre-fix)

- `packages/agent-runtime/src/pi/adapter.ts` always sent `baseInstructions` on `thread/start`
- `packages/agent-runtime/src/pi/bridge/sdk-session.ts` took a custom `DefaultResourceLoader` path whenever a system prompt was present
- that loader path set:
  - `noExtensions: true`
  - `noSkills: true`
  - `noPromptTemplates: true`
  - `noThemes: true`

This was closer to running Pi with a custom system prompt plus
`--no-extensions --no-skills --no-prompt-templates --no-themes` than to a plain
interactive Pi session.

## Questions To Answer

1. Does bb need parity with a normal Pi session, or do we intentionally want a
   stripped custom mode?
2. If parity is the goal, should bb append its instructions to Pi defaults
   rather than replacing loader behavior?
3. Which Pi-native surfaces are currently lost or changed by the custom loader
   path?
4. Are there tool-discovery differences beyond `grep` / `find` / `ls`, such as
   extensions, helper tools, prompt templates, or system behavior?

## Proposed Work

### Phase 1: Reproduce the gap cleanly — DONE

- captured tool-surface comparison across direct `pi`, `pi --mode json`, and the bb bridge.

### Phase 2: Audit the bridge startup path — DONE

- traced session-option construction; root cause was `systemPrompt` forcing the destructive loader path.

### Phase 3: Design the parity target — DONE

- decision: preserve Pi defaults and **append** bb instructions by default; allow explicit `"replace"` opt-in for managers that need a fully custom prompt surface.

### Phase 4: Implement parity changes — DONE

- `instructionMode` plumbed through `PiInstructionCommand`; adapter resolves to `appendSystemPrompt` (default) or `baseInstructions` (replace).
- `sdk-session.ts` uses `appendSystemPromptOverride` on the append path; the `noExtensions/noSkills/noPromptTemplates/noThemes` loader is reached only on explicit replace.

### Phase 5: Re-capture and compare fixtures — REMAINING

- replay at least one targeted Pi fixture under the new append-default path.
- compare raw tool names, event shapes, and rendered output against pre-fix captures.
- Note: `packages/agent-provider-audit` was removed; audit/replay work now lives in `packages/replay-capture` and `packages/agent-fixtures`. Retarget any "audit doc" updates there.

## Exit Criteria

Closing this plan requires:

- a Pi fixture re-captured under append-default and compared end to end (Phase 5).
- any remaining intentional differences between bb Pi sessions and direct Pi documented in the relevant package README under `packages/replay-capture/` or `packages/agent-fixtures/` (the old `packages/agent-provider-audit/README.md` no longer exists).

Already satisfied:

- bb Pi session intent (append by default, replace opt-in) is encoded in code at `pi/adapter.ts`, `pi/runtime.ts`, `pi/thread-runtime-config.ts`, and `pi/bridge/sdk-session.ts`.
- the bridge startup path matches that intent.

## Validation

### Automated

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`
- (the old `@bb/agent-provider-audit` filter no longer exists)

### Manual

- run the same prompt directly in native Pi and through bb against the same repo
  checkout
- inspect raw provider events for tool-name and event-shape differences
- inspect the CLI timeline text for the updated Pi fixture
- inspect the React/Ladle timeline for the updated Pi fixture
- explicitly ask Pi what tools it believes it has in both environments

### Comparison Checklist

- same or intentionally different advertised tool surface
- same or intentionally different emitted tool names
- same or intentionally different helper/custom tool availability
- no accidental loss of extensions, skills, templates, or themes unless that is
  the chosen product behavior
