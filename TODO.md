# Branch TODO

## Fix First: Blockers And Boundaries

- [x] Update server event ingestion for `provider/unhandled` and `item/toolCall/progress`
- [x] Prevent provider-audit fixture import path traversal from `corpusId`
- [x] Validate decoded thread event rows at the `core-ui` boundary with Zod instead of casts

## Next: Adapter Correctness

- [x] Mark Claude and Pi file writes as `add` when there is no prior file content
- [x] Preserve Claude web search result text on completed items
- [x] Stop fabricating sentinel tool-call request ids in Claude and Codex
- [x] Tighten `bashArgsSchema` to validate handled bash command payloads
- [x] Record `startedAt` for streaming assistant and reasoning rows

## Next: Tests

- [x] Replace silent early-return narrowing in `thread-detail-rows` tests with hard assertions
- [x] Add Claude `thread/resume` options pass-through coverage
- [x] Add adapter coverage for `thread/stop`

## Later: Guideline Cleanup

- [x] Hide Claude `rate_limit_event` rows from CLI and React timelines
- [x] Remove Pi `as never` / `as Model<any>` generic workarounds
- [x] Replace brittle `resolveBridgePath()` `/src/` string hacks
- [x] Reduce Codex handled-method duplication between schema and lookup list
