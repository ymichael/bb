# Provider Audit TODO

## Fixed

- `agent-runtime` now exposes a capture hook that records raw provider events, translated thread events, tool-call exchanges, stderr, and process lifecycle events.
- The provider audit package now tracks only raw fixture inputs in git: `manifest.json`, `client-requests.json`, and `raw-provider-events.json`.
- Fixture replay is now reproducible offline. The package can regenerate thread events, `ViewMessage`s, timeline rows, CLI text, and audit summaries without live provider usage.
- Empty Codex `item/commandExecution/terminalInteraction` stdin events are treated as non-user-visible lifecycle noise instead of unexplained translation misses.
- Shell-style repo exploration now keeps command/tool identity and carries parsed activity intents, so shared timeline formatting can summarize read/search/file-discovery work without erasing the underlying shell command.
- Claude `Agent` tool results are now compact summaries instead of dumping the subagent's full report inline in the main thread timeline.
- Provider audit replay now writes `timeline.txt` in the CLI's default minimal format and keeps `timeline.verbose.txt` for deeper inspection.
- Provider-agnostic thread events and projected `ViewMessage`s now preserve optional `parentToolCallId` linkage where the provider emits it.
- The view layer now has first-class `tasks` and `delegation` message kinds instead of forcing plan/todo/subagent activity through `operation` or generic `tool-call`.
- Codex `turn/plan/updated` and Claude `TodoWrite` now normalize into the same `tasks` concept.
- Low-value `TodoRead` churn is now suppressed instead of leaking into the rendered timeline.
- The app and CLI timeline renderers now understand `tasks` and `delegation`, and recursive nested activity rendering is supported when parent-child linkage is present.
- The shared thread timeline React renderer now lives in `@bb/ui-core`, so `apps/app` and offline audits use the same presentation path.
- `@bb/agent-provider-audit` now has a fixture-backed Ladle loop that renders the Excalidraw corpus through the shared React timeline components.
- The shared React timeline has now been audited in a real browser across all 18 checked-in Excalidraw fixtures, so app-side coverage is no longer inferred only from CLI text output.
- Realistic Claude delegated child activity now nests under the parent `Agent` row because the adapter preserves `sdk/message.message.parent_tool_use_id` from the raw fixture corpus.
- Claude assistant messages now preserve the provider's real message ids instead of reusing one synthetic id per turn, so separate narration steps no longer collapse into corrupted run-on text in the final timeline.
- Projection can now infer delegated child nesting from provider child thread ids plus collab-tool `receiverThreadIds`, so Codex-style child-thread activity can attach under a parent delegation without widening the stored thread-event model.
- Tool projection no longer drops an unrelated active tool cell when a later terminal tool event arrives. This keeps delegated exploration plus follow-up child interactions visible in the same nested subtree.
- `@bb/thread-view` now collapses consecutive work runs for shared CLI/audit formatting, so post-assistant validation/probe churn shows up as one summary row instead of a wall of sibling entries.

## Open

- The checked-in Excalidraw Codex corpus still does not exercise `collabAgentToolCall`, so realistic fixture-backed Codex child-thread validation remains open even though projection is ready to use `receiverThreadIds` when those events appear.
- Claude feature and bug-fix traces now render the provider's intermediate narration as distinct assistant rows instead of one corrupted blob. This is more faithful, but it may still be worth compacting some of that narration if we can do it without hiding useful steering context.
- Repeated single-call probe churn still leaks through more than it should. Failed probes should remain visible, but we may still want a compact summary treatment for fallback-heavy validation attempts that do not naturally form multi-message runs.
- We still do not have a first-class model for delegation/subagent progress beyond the parent row and nested child messages.
- Streaming fidelity still trails final-timeline fidelity. The current focus remains the final rendered timeline.
- Some environment-probe noise still remains in the Excalidraw corpus, especially fallback package-manager checks around validation commands. Failed probes should remain visible, but repeated fallback churn may still need better compaction.

## Next Fixes

- Extend fixture coverage so Codex collaboration events can be validated from realistic raw traces instead of only protocol research plus synthetic tests.
- Decide how to compact repeated fallback/probe sequences without hiding failed probes that may help users steer the agent.
- Keep extending the corpus when a real provider behavior cannot be judged well from the current Excalidraw fixtures.
