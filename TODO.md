# Branch TODO

## Fix First: Blockers And Boundaries

- [x] Update server event ingestion for `provider/unhandled` and `item/toolCall/progress`
- [x] Prevent provider-audit fixture import path traversal from `corpusId`
- [x] Validate decoded thread event rows at the `core-ui` boundary with Zod instead of casts

## Next: Adapter Correctness

- [ ] Mark Claude and Pi file writes as `add` when there is no prior file content
- [ ] Preserve Claude web search result text on completed items
- [ ] Stop fabricating sentinel tool-call request ids in Claude and Codex
- [ ] Tighten `bashArgsSchema` to validate handled bash command payloads
- [ ] Record `startedAt` for streaming assistant and reasoning rows

## Next: Tests

- [ ] Replace silent early-return narrowing in `thread-detail-rows` tests with hard assertions
- [ ] Add Claude `thread/resume` options pass-through coverage
- [ ] Add adapter coverage for `thread/stop`

## Later: Guideline Cleanup

- [ ] Hide Claude `rate_limit_event` rows from CLI and React timelines
- [ ] Remove Pi `as never` / `as Model<any>` generic workarounds
- [ ] Replace brittle `resolveBridgePath()` `/src/` string hacks
- [ ] Reduce Codex handled-method duplication between schema and lookup list
