import type { TimelineRow } from "@bb/server-contract";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline";
import { usePreferredTheme } from "@/hooks/useTheme";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/File Change",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  threadRuntimeDisplayStatus: "idle" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
  workspaceRootPath: "/Users/michael/.bb-dev/worktrees/env_story/bb",
};

// Story-only wrapper — pulls the active theme from ladle so the diff body's
// syntax highlighting flips with the toolbar toggle. Without this each
// ThreadTimelineRows render would default to themeType="light" regardless
// of the page theme.
type ThemedTimelineRowsProps = Omit<
  ThreadTimelineRowsProps,
  "themeType"
> &
  Partial<Pick<ThreadTimelineRowsProps, "themeType">>;

function ThemedTimelineRows(props: ThemedTimelineRowsProps) {
  const themeType = usePreferredTheme();
  return <ThreadTimelineRows themeType={themeType} {...props} />;
}

// ---------------------------------------------------------------------------
// Real file-change rows pulled from live threads in ~/.bb-dev/bb.db.
//
// fileChange items have three real `kind` values in the projection: "add",
// "update", and "delete". For "update" the `diff` is unified-diff text; for
// "add" and "delete" it's the raw file contents (counted as plain lines for
// diffStats — see packages/thread-view/src/file-change-summary.ts).
//
// diffStats counts here are computed by getFileChangeDiffStats against the
// real diff strings, so they match what the server would project.
// ---------------------------------------------------------------------------

// thr_uphts6irka, sequence 436 — adds pagination cursor + page metadata
// schemas to api-types.ts. Small unified diff, single hunk + small tail.
const updateApiTypes: TimelineRow = {
  "id": "thr_uphts6irka:file-change:call_tzoOVFps3qEslIAKn7T2Q3Vx:0",
  "threadId": "thr_uphts6irka",
  "turnId": "019df6bc-b889-73a1-8ce6-749c358a8f70",
  "sourceSeqStart": 434,
  "sourceSeqEnd": 436,
  "startedAt": 1777961335114,
  "createdAt": 1777961335129,
  "kind": "work",
  "workKind": "file-change",
  "status": "completed",
  "callId": "call_tzoOVFps3qEslIAKn7T2Q3Vx",
  "change": {
    "path": "/Users/michael/.bb-dev/worktrees/env_story/bb/packages/server-contract/src/api-types.ts",
    "kind": "update",
    "movePath": null,
    "diff": "@@ -525,2 +525,25 @@\n \n+export const THREAD_TIMELINE_DEFAULT_TOP_LEVEL_LIMIT = 100;\n+\n+export const timelinePaginationCursorSchema = z\n+  .object({\n+    topLevelSortSeq: z.number().int().nonnegative(),\n+    rowId: z.string().min(1),\n+  })\n+  .strict();\n+export type TimelinePaginationCursor = z.infer<\n+  typeof timelinePaginationCursorSchema\n+>;\n+\n+export const timelinePageMetadataSchema = z\n+  .object({\n+    kind: z.enum([\"latest\", \"older\"]),\n+    topLevelLimit: z.number().int().positive(),\n+    returnedOlderTopLevelRowCount: z.number().int().nonnegative(),\n+    hasOlderRows: z.boolean(),\n+    olderCursor: timelinePaginationCursorSchema.nullable(),\n+  })\n+  .strict();\n+export type TimelinePageMetadata = z.infer<typeof timelinePageMetadataSchema>;\n+\n export const threadTimelineQuerySchema = z\n@@ -529,4 +552,22 @@\n     includeNestedRows: z.enum([\"true\", \"false\"]),\n+    topLevelLimit: z.string().regex(/^\\d+$/),\n+    beforeTopLevelSortSeq: z.string().regex(/^\\d+$/),\n+    beforeRowId: z.string().min(1),\n   })\n-  .partial();\n+  .partial()\n+  .superRefine((query, context) => {\n+    const hasBeforeTopLevelSortSeq =\n+      query.beforeTopLevelSortSeq !== undefined;\n+    const hasBeforeRowId = query.beforeRowId !== undefined;\n+\n+    if (hasBeforeTopLevelSortSeq === hasBeforeRowId) {\n+      return;\n+    }\n+\n+    context.addIssue({\n+      code: z.ZodIssueCode.custom,\n+      message:\n+        \"beforeTopLevelSortSeq and beforeRowId must be provided together\",\n+    });\n+  });\n export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;\n@@ -945,2 +986,3 @@\n   contextWindowUsage: threadContextWindowUsageSchema.optional(),\n+  timelinePage: timelinePageMetadataSchema,\n });\n",
    "diffStats": { "added": 43, "removed": 1 },
  },
  "stdout": null,
  "stderr": null,
  "approvalStatus": null,
};

// thr_jb5xwguekp, sequence 33995 — agent created
// packages/thread-view/test/format-helpers.test.ts. Real new-file content; no
// `+`/`-` prefixes, so diffStats counts plain non-empty content lines.
const addFormatHelpersTest: TimelineRow = {
  "id": "thr_jb5xwguekp:file-change:call_7OKBsczb0xrotVbyKMY39CRj:0",
  "threadId": "thr_jb5xwguekp",
  "turnId": "019ded48-07f6-76d3-aa26-7bc77841bf6b",
  "sourceSeqStart": 33993,
  "sourceSeqEnd": 33995,
  "startedAt": 1777802451595,
  "createdAt": 1777802451638,
  "kind": "work",
  "workKind": "file-change",
  "status": "completed",
  "callId": "call_7OKBsczb0xrotVbyKMY39CRj",
  "change": {
    "path": "/Users/michael/.bb-dev/worktrees/env_story/bb/packages/thread-view/test/format-helpers.test.ts",
    "kind": "add",
    "movePath": null,
    "diff": "import { describe, expect, it } from \"vitest\";\nimport {\n  capitalize,\n  durationToCompactString,\n  getFirstStringField,\n  messageId,\n  plural,\n} from \"../src/format-helpers.js\";\n\ndescribe(\"durationToCompactString\", () => {\n  it(\"returns undefined for undefined input\", () => {\n    expect(durationToCompactString(undefined)).toBeUndefined();\n  });\n\n  it(\"formats invalid durations as zero seconds\", () => {\n    expect(durationToCompactString(Number.NaN)).toBe(\"0s\");\n    expect(durationToCompactString(-1)).toBe(\"0s\");\n  });\n\n  it(\"formats sub-second durations as milliseconds\", () => {\n    expect(durationToCompactString(0)).toBe(\"0ms\");\n    expect(durationToCompactString(50)).toBe(\"50ms\");\n    expect(durationToCompactString(999)).toBe(\"999ms\");\n  });\n\n  it(\"rounds seconds to whole seconds\", () => {\n    expect(durationToCompactString(1_499)).toBe(\"1s\");\n    expect(durationToCompactString(1_500)).toBe(\"2s\");\n    expect(durationToCompactString(59_499)).toBe(\"59s\");\n  });\n\n  it(\"formats durations over 60 seconds as minutes and seconds\", () => {\n    expect(durationToCompactString(60_000)).toBe(\"1m\");\n    expect(durationToCompactString(89_600)).toBe(\"1m 30s\");\n    expect(durationToCompactString(125_000)).toBe(\"2m 5s\");\n  });\n});\n\ndescribe(\"plural\", () => {\n  it(\"uses singular and plural labels\", () => {\n    expect(plural(1, \"file\")).toBe(\"1 file\");\n    expect(plural(2, \"file\")).toBe(\"2 files\");\n    expect(plural(2, \"search\", \"searches\")).toBe(\"2 searches\");\n  });\n});\n\ndescribe(\"messageId\", () => {\n  it(\"joins message id segments with colons\", () => {\n    expect(messageId(\"thread-1\", \"tool\", \"call-1\")).toBe(\n      \"thread-1:tool:call-1\",\n    );\n  });\n});\n\ndescribe(\"capitalize\", () => {\n  it(\"capitalizes only the first character\", () => {\n    expect(capitalize(\"hello\")).toBe(\"Hello\");\n    expect(capitalize(\"a\")).toBe(\"A\");\n    expect(capitalize(\"\")).toBe(\"\");\n    expect(capitalize(\"Hello\")).toBe(\"Hello\");\n  });\n});\n\ndescribe(\"getFirstStringField\", () => {\n  it(\"returns the first non-empty string field\", () => {\n    expect(\n      getFirstStringField(\n        { first: \"\", second: \"value\", third: \"ignored\" },\n        [\"first\", \"second\", \"third\"],\n      ),\n    ).toBe(\"value\");\n  });\n\n  it(\"ignores missing, empty, and non-string values\", () => {\n    expect(\n      getFirstStringField(\n        { first: 1, second: \"\", third: null },\n        [\"first\", \"second\", \"third\"],\n      ),\n    ).toBeUndefined();\n    expect(getFirstStringField(null, [\"first\"])).toBeUndefined();\n  });\n});\n",
    "diffStats": { "added": 73, "removed": 0 },
  },
  "stdout": null,
  "stderr": null,
  "approvalStatus": null,
};

// thr_zeb7z9afmw, sequence 7834 — agent deleted
// packages/core-ui/src/active-thinking.ts. The projection stores the deleted
// file's full prior contents (no `-` prefixes), so diffStats falls back to
// counting plain lines as `removed`.
const deleteActiveThinking: TimelineRow = {
  "id": "thr_zeb7z9afmw:file-change:call_gV1Y8zJp5ADwT0Rq9j4TGiqj:0",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019db687-acc3-7ce2-8adc-70e67c34c403",
  "sourceSeqStart": 7832,
  "sourceSeqEnd": 7834,
  "startedAt": 1776884335315,
  "createdAt": 1776884335454,
  "kind": "work",
  "workKind": "file-change",
  "status": "completed",
  "callId": "call_gV1Y8zJp5ADwT0Rq9j4TGiqj",
  "change": {
    "path": "/Users/michael/.bb-dev/worktrees/env_story/bb/packages/core-ui/src/active-thinking.ts",
    "kind": "delete",
    "movePath": null,
    "diff": "import type { TimelineActiveThinking, ViewMessage } from \"@bb/domain\";\nimport { isTerminalBufferedTextFlushEvent } from \"./assistant-buffering.js\";\nimport type { ThreadEventWithMeta } from \"./build-view-projection.js\";\nimport { flattenViewMessagesDeep } from \"./projection-flatten.js\";\n\ntype ViewAssistantReasoningMessage = Extract<\n  ViewMessage,\n  { kind: \"assistant-reasoning\" }\n>;\n\ninterface ActiveReasoningLifecycle {\n  id: string;\n  startedAt: number;\n  updatedAt: number;\n  updatedSeq: number;\n}\n\ninterface ExtractActiveThinkingArgs {\n  events: readonly ThreadEventWithMeta[];\n  messages: readonly ViewMessage[];\n}\n\nfunction isStreamingReasoningMessage(\n  message: ViewMessage,\n): message is ViewAssistantReasoningMessage {\n  return (\n    message.kind === \"assistant-reasoning\" && message.status === \"streaming\"\n  );\n}\n\nfunction isNewerReasoningMessage(\n  candidate: ViewAssistantReasoningMessage,\n  current: ViewAssistantReasoningMessage,\n): boolean {\n  if (candidate.sourceSeqEnd !== current.sourceSeqEnd) {\n    return candidate.sourceSeqEnd > current.sourceSeqEnd;\n  }\n  return candidate.createdAt > current.createdAt;\n}\n\nfunction toTimelineActiveThinking(\n  message: ViewAssistantReasoningMessage,\n): TimelineActiveThinking {\n  return {\n    id: message.id,\n    text: message.text,\n    startedAt: message.startedAt ?? message.createdAt,\n    updatedAt: message.createdAt,\n  };\n}\n\nfunction extractVisibleActiveThinking(\n  messages: readonly ViewMessage[],\n): ViewAssistantReasoningMessage | null {\n  let activeReasoning: ViewAssistantReasoningMessage | null = null;\n  for (const message of flattenViewMessagesDeep(messages)) {\n    if (!isStreamingReasoningMessage(message)) {\n      continue;\n    }\n    if (!activeReasoning || isNewerReasoningMessage(message, activeReasoning)) {\n      activeReasoning = message;\n    }\n  }\n\n  return activeReasoning;\n}\n\nfunction upsertActiveReasoningLifecycle(\n  openReasoningById: Map<string, ActiveReasoningLifecycle>,\n  itemId: string,\n  meta: ThreadEventWithMeta[\"meta\"],\n): void {\n  const existing = openReasoningById.get(itemId);\n  if (existing) {\n    existing.updatedAt = meta.createdAt;\n    existing.updatedSeq = meta.seq;\n    return;\n  }\n\n  openReasoningById.set(itemId, {\n    id: itemId,\n    startedAt: meta.createdAt,\n    updatedAt: meta.createdAt,\n    updatedSeq: meta.seq,\n  });\n}\n\nfunction extractActiveReasoningLifecycle(\n  events: readonly ThreadEventWithMeta[],\n): ActiveReasoningLifecycle | null {\n  const openReasoningById = new Map<string, ActiveReasoningLifecycle>();\n\n  for (const { event, meta } of events) {\n    if (isTerminalBufferedTextFlushEvent(event.type)) {\n      openReasoningById.clear();\n      continue;\n    }\n\n    if (\n      (event.type === \"item/started\" || event.type === \"item/completed\") &&\n      event.item.type === \"reasoning\"\n    ) {\n      if (event.type === \"item/started\") {\n        upsertActiveReasoningLifecycle(openReasoningById, event.item.id, meta);\n      } else {\n        openReasoningById.delete(event.item.id);\n      }\n      continue;\n    }\n\n    if (\n      event.type === \"item/reasoning/summaryTextDelta\" ||\n      event.type === \"item/reasoning/textDelta\"\n    ) {\n      upsertActiveReasoningLifecycle(openReasoningById, event.itemId, meta);\n    }\n  }\n\n  let latestOpenReasoning: ActiveReasoningLifecycle | null = null;\n  for (const candidate of openReasoningById.values()) {\n    if (\n      !latestOpenReasoning ||\n      candidate.updatedSeq > latestOpenReasoning.updatedSeq\n    ) {\n      latestOpenReasoning = candidate;\n    }\n  }\n\n  return latestOpenReasoning;\n}\n\nexport function extractActiveThinking(\n  args: ExtractActiveThinkingArgs,\n): TimelineActiveThinking | null {\n  const lifecycle = extractActiveReasoningLifecycle(args.events);\n  if (!lifecycle) {\n    return null;\n  }\n\n  const visibleThinking = extractVisibleActiveThinking(args.messages);\n  const visibleThinkingMatchesLifecycle =\n    visibleThinking !== null && visibleThinking.sourceItemId === lifecycle.id;\n  const matchedVisibleThinking = visibleThinkingMatchesLifecycle\n    ? toTimelineActiveThinking(visibleThinking)\n    : null;\n\n  return {\n    id: lifecycle.id,\n    text: matchedVisibleThinking?.text ?? \"\",\n    startedAt: lifecycle.startedAt,\n    updatedAt: Math.max(\n      lifecycle.updatedAt,\n      matchedVisibleThinking?.updatedAt ?? lifecycle.updatedAt,\n    ),\n  };\n}\n",
    "diffStats": { "added": 0, "removed": 137 },
  },
  "stdout": null,
  "stderr": null,
  "approvalStatus": null,
};

// thr_4gfmxbsa64, sequence 1910 — large refactor of ThreadFollowUpComposer.tsx
// (extract QueuedMessageItem into a memoized component). Real unified diff
// across multiple hunks with substantial added + removed line counts.
const largeRefactorComposer: TimelineRow = {
  "id": "thr_4gfmxbsa64:file-change:call_xFKgOuQKzQxP1vthvrxyx9PS:0",
  "threadId": "thr_4gfmxbsa64",
  "turnId": "019ddce4-45da-70e3-bdf3-e9cd141b653a",
  "sourceSeqStart": 1908,
  "sourceSeqEnd": 1910,
  "startedAt": 1777528569582,
  "createdAt": 1777528569827,
  "kind": "work",
  "workKind": "file-change",
  "status": "completed",
  "callId": "call_xFKgOuQKzQxP1vthvrxyx9PS",
  "change": {
    "path": "/Users/michael/.bb-dev/worktrees/env_story/bb/apps/app/src/views/ThreadFollowUpComposer.tsx",
    "kind": "update",
    "movePath": null,
    "diff": "@@ -1,2 +1,7 @@\n-import { type ComponentProps, type ComponentType, type ReactNode } from \"react\";\n+import {\n+  memo,\n+  type ComponentProps,\n+  type ComponentType,\n+  type ReactNode,\n+} from \"react\";\n import { useAtom } from \"jotai\";\n@@ -51,2 +56,13 @@\n \n+interface QueuedMessageItemProps {\n+  actionDisabled: boolean;\n+  index: number;\n+  isProcessing: boolean;\n+  onDelete: (id: string) => void;\n+  onEdit: (id: string) => void;\n+  onSendImmediately: (id: string) => void;\n+  queuedMessage: ThreadQueuedMessage;\n+  sendDisabled: boolean;\n+}\n+\n function PromptBoxWithScrollAnchor({\n@@ -63,2 +79,87 @@\n \n+const QueuedMessageItem = memo(function QueuedMessageItem({\n+  actionDisabled,\n+  index,\n+  isProcessing,\n+  onDelete,\n+  onEdit,\n+  onSendImmediately,\n+  queuedMessage,\n+  sendDisabled,\n+}: QueuedMessageItemProps) {\n+  const preview = formatQueuedMessagePreview(queuedMessage.content);\n+  const attachmentCount = countQueuedMessageAttachments(queuedMessage.content);\n+\n+  return (\n+    <li className=\"px-2.5 py-0.5\">\n+      <div className=\"flex items-center gap-1.5\">\n+        <div className=\"p-0.5 text-muted-foreground\">\n+          <CornerDownRight className=\"size-3.5\" />\n+        </div>\n+        <div className=\"min-w-0 flex-1\">\n+          <div className=\"flex min-w-0 items-center gap-1 text-xs leading-4\">\n+            <p className=\"min-w-0 truncate text-foreground\" title={preview}>\n+              {preview}\n+            </p>\n+            {attachmentCount > 0 ? (\n+              <>\n+                <span className=\"shrink-0 text-muted-foreground\">.</span>\n+                <span className=\"shrink-0 text-muted-foreground\">\n+                  {attachmentCount === 1\n+                    ? \"1 attachment\"\n+                    : `${attachmentCount} attachments`}\n+                </span>\n+              </>\n+            ) : null}\n+            {isProcessing ? (\n+              <>\n+                <span className=\"shrink-0 text-muted-foreground\">.</span>\n+                <span className=\"shrink-0 text-muted-foreground\">\n+                  Sending...\n+                </span>\n+              </>\n+            ) : null}\n+          </div>\n+        </div>\n+        <div className=\"ml-1 flex shrink-0 items-center gap-1\">\n+          <Button\n+            type=\"button\"\n+            size=\"sm\"\n+            variant=\"link\"\n+            className=\"h-auto px-0 pr-1 text-xs text-muted-foreground underline\"\n+            disabled={sendDisabled || isProcessing}\n+            onClick={() => onSendImmediately(queuedMessage.id)}\n+          >\n+            {isProcessing ? \"Sending...\" : \"Send now\"}\n+          </Button>\n+          <Button\n+            type=\"button\"\n+            size=\"icon\"\n+            variant=\"ghost\"\n+            className=\"size-7 text-muted-foreground\"\n+            disabled={actionDisabled || isProcessing}\n+            onClick={() => onEdit(queuedMessage.id)}\n+            aria-label={`Edit queued message ${index + 1}`}\n+            title=\"Edit queued message\"\n+          >\n+            <Pencil className=\"size-3.5\" />\n+          </Button>\n+          <Button\n+            type=\"button\"\n+            size=\"icon\"\n+            variant=\"ghost\"\n+            className=\"size-7 text-muted-foreground hover:text-destructive\"\n+            disabled={actionDisabled || isProcessing}\n+            onClick={() => onDelete(queuedMessage.id)}\n+            aria-label={`Delete queued message ${index + 1}`}\n+            title=\"Delete queued message\"\n+          >\n+            <Trash2 className=\"size-3.5\" />\n+          </Button>\n+        </div>\n+      </div>\n+    </li>\n+  );\n+});\n+\n function QueuedMessageList({\n@@ -93,86 +194,15 @@\n       <ul>\n-        {queuedMessages.map((queuedMessage, index) => {\n-          const preview = formatQueuedMessagePreview(queuedMessage.content);\n-          const attachmentCount = countQueuedMessageAttachments(\n-            queuedMessage.content,\n-          );\n-          const isProcessing = processingMessageId === queuedMessage.id;\n-          return (\n-            <li key={queuedMessage.id} className=\"px-2.5 py-0.5\">\n-              <div className=\"flex items-center gap-1.5\">\n-                <div className=\"p-0.5 text-muted-foreground\">\n-                  <CornerDownRight className=\"size-3.5\" />\n-                </div>\n-                <div className=\"min-w-0 flex-1\">\n-                  <div className=\"flex min-w-0 items-center gap-1 text-xs leading-4\">\n-                    <p\n-                      className=\"min-w-0 truncate text-foreground\"\n-                      title={preview}\n-                    >\n-                      {preview}\n-                    </p>\n-                    {attachmentCount > 0 ? (\n-                      <>\n-                        <span className=\"shrink-0 text-muted-foreground\">\n-                          .\n-                        </span>\n-                        <span className=\"shrink-0 text-muted-foreground\">\n-                          {attachmentCount === 1\n-                            ? \"1 attachment\"\n-                            : `${attachmentCount} attachments`}\n-                        </span>\n-                      </>\n-                    ) : null}\n-                    {isProcessing ? (\n-                      <>\n-                        <span className=\"shrink-0 text-muted-foreground\">\n-                          .\n-                        </span>\n-                        <span className=\"shrink-0 text-muted-foreground\">\n-                          Sending...\n-                        </span>\n-                      </>\n-                    ) : null}\n-                  </div>\n-                </div>\n-                <div className=\"ml-1 flex shrink-0 items-center gap-1\">\n-                  <Button\n-                    type=\"button\"\n-                    size=\"sm\"\n-                    variant=\"link\"\n-                    className=\"h-auto px-0 pr-1 text-xs text-muted-foreground underline\"\n-                    disabled={sendDisabled || isProcessing}\n-                    onClick={() => onSendImmediately(queuedMessage.id)}\n-                  >\n-                    {isProcessing ? \"Sending...\" : \"Send now\"}\n-                  </Button>\n-                  <Button\n-                    type=\"button\"\n-                    size=\"icon\"\n-                    variant=\"ghost\"\n-                    className=\"size-7 text-muted-foreground\"\n-                    disabled={actionDisabled || isProcessing}\n-                    onClick={() => onEdit(queuedMessage.id)}\n-                    aria-label={`Edit queued message ${index + 1}`}\n-                    title=\"Edit queued message\"\n-                  >\n-                    <Pencil className=\"size-3.5\" />\n-                  </Button>\n-                  <Button\n-                    type=\"button\"\n-                    size=\"icon\"\n-                    variant=\"ghost\"\n-                    className=\"size-7 text-muted-foreground hover:text-destructive\"\n-                    disabled={actionDisabled || isProcessing}\n-                    onClick={() => onDelete(queuedMessage.id)}\n-                    aria-label={`Delete queued message ${index + 1}`}\n-                    title=\"Delete queued message\"\n-                  >\n-                    <Trash2 className=\"size-3.5\" />\n-                  </Button>\n-                </div>\n-              </div>\n-            </li>\n-          );\n-        })}\n+        {queuedMessages.map((queuedMessage, index) => (\n+          <QueuedMessageItem\n+            key={queuedMessage.id}\n+            queuedMessage={queuedMessage}\n+            index={index}\n+            isProcessing={processingMessageId === queuedMessage.id}\n+            sendDisabled={sendDisabled}\n+            actionDisabled={actionDisabled}\n+            onDelete={onDelete}\n+            onEdit={onEdit}\n+            onSendImmediately={onSendImmediately}\n+          />\n+        ))}\n       </ul>\n",
    "diffStats": { "added": 115, "removed": 85 },
  },
  "stdout": null,
  "stderr": null,
  "approvalStatus": null,
};

// Lifecycle variants reuse the real updateApiTypes change. status=pending /
// error / interrupted and the approval-gate states aren't available as
// terminal events in the DB (errors clear the row, approval pre-completion
// state isn't persisted on completed events) — so we synthesize them from a
// real fixture rather than fabricate diffs.

const runningFileChange: TimelineRow = {
  ...updateApiTypes,
  "id": "thr_uphts6irka:file-change:call_running:0",
  "callId": "call_running",
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "status": "pending",
};

const errorFileChange: TimelineRow = {
  ...updateApiTypes,
  "id": "thr_uphts6irka:file-change:call_error:0",
  "callId": "call_error",
  "status": "error",
  "stderr": "ENOENT: no such file or directory, open '/Users/michael/.bb-dev/worktrees/env_story/bb/packages/server-contract/src/api-types.ts'\n",
};

const interruptedFileChange: TimelineRow = {
  ...updateApiTypes,
  "id": "thr_uphts6irka:file-change:call_interrupted:0",
  "callId": "call_interrupted",
  "status": "interrupted",
};

const waitingApprovalFileChange: TimelineRow = {
  ...updateApiTypes,
  "id": "thr_uphts6irka:file-change:call_waiting_approval:0",
  "callId": "call_waiting_approval",
  "status": "pending",
  "approvalStatus": "waiting_for_approval",
};

const deniedFileChange: TimelineRow = {
  ...updateApiTypes,
  "id": "thr_uphts6irka:file-change:call_denied:0",
  "callId": "call_denied",
  "status": "completed",
  "approvalStatus": "denied",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed update"
        hint="production-default — header only, click to expand. Real unified diff."
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[updateApiTypes]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — completed create"
        hint="kind=add. Diff is the full new-file content; stats count plain lines."
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[addFormatHelpersTest]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — completed delete"
        hint="kind=delete. Diff is the prior file content; stats count as removed."
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[deleteActiveThinking]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — running"
        hint="status=pending, no completedAt — edit is mid-flight"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[runningFileChange]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — error"
        hint="status=error, stderr populated"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[errorFileChange]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="status=interrupted — turn was cancelled mid-edit"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[interruptedFileChange]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — waiting for approval"
        hint="approvalStatus=waiting_for_approval, parked before applying the edit"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[waitingApprovalFileChange]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — denied"
        hint="approvalStatus=denied, user rejected the edit"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            timelineRows={[deniedFileChange]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="expanded — large diff"
        hint="extract-to-memo refactor of ThreadFollowUpComposer.tsx — full diff body inline"
      >
        <TimelineStage>
          <ThemedTimelineRows
            {...baseProps}
            initialExpanded={new Set([largeRefactorComposer.id])}
            timelineRows={[largeRefactorComposer]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
