# Thread Event Contract

This document defines the persisted thread-event taxonomy and payload typing strategy.

## Pipeline Boundary

Target pipeline implemented in Phase 5:

1. Provider-specific notifications (`open_external`)
2. Normalization to persisted event envelope
3. UI projection (`toUIMessages`) from normalized payload
4. Rendering from `UIMessage` model

## Persisted Provider Envelope (`open_external`)

Provider notifications are persisted as:

```ts
{
  __bb_provider_event: {
    schema: "bb/provider-event-envelope";
    version: 1;
    providerId: string;
    method: string;
    observedAt: number;
  };
  payload: unknown;
}
```

Notes:

- `type` column still stores the event type string used for routing/indexing.
- Envelope `method` is the canonical source method when replaying/normalizing.
- `payload` remains tolerant to provider evolution.

## App-Defined Events (`closed_internal`)

- `client/thread/start` -> `ClientOutboundStartEventData`
- `client/turn/start` -> `ClientOutboundStartEventData`
- `system/error` -> `SystemErrorEventData`
- `system/thread-title/updated` -> `SystemThreadTitleUpdatedEventData`
- `system/thread_operation` -> `SystemThreadOperationEventData`
- `system/primary_checkout/updated` -> `SystemPrimaryCheckoutUpdatedEventData`
- `system/worktree/commit` -> `SystemWorktreeCommitEventData`
- `system/worktree/squash_merge` -> `SystemWorktreeSquashMergeEventData`
- `system/provisioning/started` -> `SystemProvisioningStartedEventData`
- `system/provisioning/progress` -> `SystemProvisioningProgressEventData`
- `system/provisioning/env_setup` -> `SystemProvisioningEnvSetupEventData`
- `system/provisioning/fallback` -> `SystemProvisioningFallbackEventData`
- `system/provisioning/completed` -> `SystemProvisioningCompletedEventData`
- `system/provisioning/cleanup_failed` -> `SystemProvisioningCleanupFailedEventData`

These are BB-owned and must stay exhaustively handled.

## Provider Notification Methods (Current Generated Set)

From `ServerNotification["method"]` in generated codex schema (`packages/core/src/generated/codex-app-server/schema/ServerNotification.ts`):

- `error`
- `thread/started`
- `thread/name/updated`
- `thread/tokenUsage/updated`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `item/started`
- `item/completed`
- `rawResponseItem/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/mcpToolCall/progress`
- `mcpServer/oauthLogin/completed`
- `account/updated`
- `account/rateLimits/updated`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `thread/compacted`
- `deprecationNotice`
- `configWarning`
- `windows/worldWritableWarning`
- `account/login/completed`
- `authStatusChange`
- `loginChatGptComplete`
- `sessionConfigured`

## Decoder Strategy

- Closed internal payloads: strict typed decode and exhaustive union handling.
- Open external payloads: tolerant parsing by helper utilities and UI projection fallbacks.
- Lookup extraction helpers:
  - `extractTurnIdFromPersistedEventData`
  - `extractProviderThreadIdFromPersistedEventData`

## DB Lookup Semantics

`events` rows persist derived lookup fields:

- `norm_type`: normalized event type string
- `turn_id`: extracted turn identity
- `provider_thread_id`: extracted provider thread identity
- `is_turn_lifecycle`: turn lifecycle classification
- `is_thread_identity`: provider-thread identity classification

These fields support fast boot reconciliation and active-turn restoration without replaying full payload parsing logic.
