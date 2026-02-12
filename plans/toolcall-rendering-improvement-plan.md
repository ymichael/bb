# Toolcall Rendering Improvement Plan (Web)

## Goal
Implement terminal-style tool exploration summaries in the web transcript so tool activity renders as:
- `Exploring` / `Explored ...`
- `Searching the web` / `Searched ...`
- Coalesced, deterministic detail lines derived from parsed tool intents.

This plan uses the "Tool Exploration Summary Logic (Web Implementation Guide)" as source of truth.

## Current Gaps (in this repo)
1. Tool activity is currently collapsed into a generic turn-level summary (`"N tools and changes"`), not semantic exploration summaries.
2. `toUIMessages` projects `item/commandExecution/*` but does not currently build reducer-driven exploring/search cells.
3. Web transcript rows are grouped by turn boundaries, not by active-cell coalescing rules (exploring window flush rules).
4. Web search events (`web_search_begin` / `web_search_end`) are not rendered as dedicated searchable transcript cells.

## Scope
- `packages/core/src/ui-message.ts`
- `packages/core/src/to-ui-messages.ts`
- `packages/core/test/to-ui-messages.test.ts`
- `apps/web/src/views/threadDetailRows.ts`
- `apps/web/src/views/threadDetailRows.test.ts`
- `apps/web/src/views/ThreadDetailView.tsx`
- `apps/web/src/components/messages/ConversationEntry.tsx`
- `apps/web/src/components/messages/ConversationEntry.test.tsx`

## Design Direction
1. Keep parsing/intent extraction separate from rendering.
2. Build a reducer-driven cell model for tool activity (exec + web search), then render those cells in web.
3. Preserve deterministic ordering and first-seen semantics from the guide.
4. Support both event shapes while migrating:
   - Primary: `exec_command_begin/end`, `web_search_begin/end`
   - Compatibility: `item/started/completed` command execution payloads when needed.

## Phase 1 — Add a Semantic Tool Activity Model

### 1.1 Extend UI message model
- Add explicit tool-activity cell message variants (or equivalent row-level model) for:
  - `ExecExploringCell`
  - `ExecCommandCell` (non-exploring)
  - `WebSearchCell`
- Include per-call fields required by the guide:
  - `call_id`, `command`, `parsed_cmd`, `source`, completion fields (`exit_code`, output, duration).

### 1.2 Normalize command intents
- Introduce normalized intent types aligned with parsed command schema:
  - `Read { name, path, cmd }`
  - `ListFiles { path, cmd }`
  - `Search { query, path, cmd }`
  - `Unknown { cmd }`
- Add small compatibility normalizer for legacy `commandActions` from `item/commandExecution`.

### 1.3 Event typing compatibility
- Handle both normalized slash events and underscore events if present in persisted history.
- Ensure event-type normalization does not drop `exec_command_*`/`web_search_*` flows.

**Deliverable:** typed tool-activity model available to renderer.

## Phase 2 — Implement Reducer/Coalescing State Machine

### 2.1 Reducer state
- Add reducer state exactly as guide recommends:
  - `runningCallsById`
  - `activeCell`
  - `historyCells`

### 2.2 Exec lifecycle behavior
- `onExecBegin`:
  - register running call
  - append to active exploring cell only if both are exploring and compatible
  - otherwise flush and start new exec cell
- `onExecEnd`:
  - complete call from running metadata
  - ensure active cell exists (fallback create)
  - flush immediately only for completed non-exploring cell
  - keep exploring cell active for further coalescing

### 2.3 Web search lifecycle
- `onWebSearchBegin`: flush active and start web-search active cell (`Searching the web`)
- `onWebSearchEnd`: complete active matching call or append completed fallback cell (`Searched ...`)

### 2.4 Flush boundaries
- Flush active exploring cell when:
  - incompatible active cell begins, or
  - any visible non-tool history cell is inserted.

**Deliverable:** deterministic cell history with terminal-equivalent coalescing behavior.

## Phase 3 — Implement Exploring Detail Rendering

### 3.1 Header rendering
- Active exploring cell: `Exploring`
- Completed exploring cell: `Explored`
- Active web search: `Searching the web`
- Completed web search: `Searched ...`

### 3.2 Detail algorithm (exact parity)
- Iterate calls in execution order.
- Merge contiguous read-only calls.
- For each merged read-only group:
  - dedupe `Read.name` in first-seen order
  - render one line: `Read a, b, c`
- For non-read-only calls, render parsed items in order:
  - `Read <name>`
  - `List <path|cmd>`
  - `Search` formatting:
    - `<query> in <path>`
    - `<query>`
    - fallback `<cmd>`

### 3.3 Formatting rules
- Keep tree/continuation alignment semantics from guide.
- In web, render as semantic line list with matching indentation behavior.

**Deliverable:** detailed exploring/search summaries replacing generic `"N tools and changes"`.

## Phase 4 — Optional Count Summary Mode

### 4.1 Count helper
- Add `summarizeExploringCounts(calls)`:
  - `filesRead`: unique read names
  - `searches`: number of search intents
  - `listings`: number of list intents

### 4.2 Presentation mode
- Optional summary string:
  - `Explored {files} file(s), {searches} search(es), {listings} listing(s)`
- Optional secondary detail line(s):
  - `Read ...`
  - `Searched for ...`

### 4.3 Rollout toggle
- Gate behind a small feature flag or UI toggle to compare detailed vs count modes.

**Deliverable:** switchable detailed/count rendering without duplicating logic.

## Phase 5 — Integrate into Thread Detail Rows

### 5.1 Row builder updates
- Replace or augment current turn-level tool-group collapse in `apps/web/src/views/threadDetailRows.ts`:
  - preserve existing assistant/user/message ordering
  - insert tool activity cells from reducer output at correct transcript boundaries

### 5.2 Component updates
- Add dedicated renderers for new tool activity rows in `apps/web/src/views/ThreadDetailView.tsx` and/or `apps/web/src/components/messages/ConversationEntry.tsx`.
- Keep existing command/file-edit expanded body views available where useful, but summary header should come from new cell model.

### 5.3 Backward compatibility
- If parsed intents are missing, degrade gracefully to existing `Ran <command>` behavior.

**Deliverable:** web transcript shows terminal-style tool exploration summaries end-to-end.

## Testing Plan

## Core reducer tests
1. Coalesces consecutive exploring exec begins into one active exploring cell.
2. Non-exploring exec cells flush immediately on completion.
3. Exploring cells stay active across completed calls until incompatible flush boundary.
4. Web search begin/end creates correct searching/searched cells.
5. Fallback behavior works when end arrives without matching begin metadata.

## Rendering tests
1. Contiguous read-only calls merge into one `Read a, b`.
2. Read dedupe preserves first-seen order.
3. Search formatting covers query+path, query-only, and fallback cmd.
4. Count summary math excludes unknown intents.

## Integration tests (web rows)
1. Mixed sequence (exploring, web search, assistant text) flushes cells at correct boundaries.
2. Existing user/assistant/file-edit rows remain ordered and visible.
3. Pending active labels (`Exploring`, `Searching the web`) update to completed labels after end events.

## PR Slices
1. Core types + event normalization for exec/web-search intents.
2. Reducer and coalescing helpers with unit tests.
3. Exploring/search detail rendering helpers + tests.
4. Thread row integration and UI components.
5. Optional count-mode toggle and polish.

## Risks / Watchouts
1. Event contract drift between notification stream (`item/commandExecution`) and newer event-msg stream (`exec_command_*`).
2. Double-rendering if both legacy and new exec events are present for same call id.
3. Flush semantics around non-tool events can cause subtle ordering regressions without fixture coverage.

## Acceptance Checklist
- [ ] Exploring exec calls coalesce into one `Exploring`/`Explored` cell with semantic details.
- [ ] Non-exploring exec calls render as standalone command cells and flush immediately when completed.
- [ ] Web search renders as dedicated searching/searched cells.
- [ ] Detail lines and ordering match source guide semantics.
- [ ] Optional count mode uses same parsed/coalesced model.
- [ ] Existing transcript message ordering remains stable.
