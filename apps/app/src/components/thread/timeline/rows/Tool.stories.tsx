import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { fileReadRow, toolRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Tool",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const toolSearchTool: TimelineRow = toolRow({
  id: "thr_yn2i6jeaca:tool:toolu_0191NxebN8QhTioHDkJ3awer",
  threadId: "thr_yn2i6jeaca",
  turnId: "turn_8840389c92b04db7_1",
  sourceSeqStart: 760,
  sourceSeqEnd: 761,
  startedAt: 1776880211436,
  createdAt: 1776880211541,
  status: "completed",
  callId: "toolu_0191NxebN8QhTioHDkJ3awer",
  toolName: "ToolSearch",
  toolArgs: {
    query: "select:TodoWrite",
    max_results: 1,
  },
  output: "Matched tools: TodoWrite",
  approvalStatus: null,
  durationMs: 105,
});

const nativeSkillTool: TimelineRow = toolRow({
  id: "thr_skill_native:tool:toolu_skill_native",
  threadId: "thr_skill_native",
  turnId: "turn_skill_native_1",
  sourceSeqStart: 1,
  sourceSeqEnd: 2,
  status: "completed",
  callId: "toolu_skill_native",
  toolName: "Skill",
  toolArgs: { skill: "visual-qa-loop" },
  output: "Skill loaded",
  approvalStatus: null,
  durationMs: 120,
  presentation: {
    label: { pending: "Loading skill", completed: "Loaded skill" },
    icon: { glyph: "Zap" },
    title: "visual-qa-loop",
  },
});

const longOutputTool: TimelineRow = toolRow({
  id: "thr_tool_long_output:tool:toolu_long_output",
  threadId: "thr_tool_long_output",
  turnId: "turn_tool_long_output_1",
  sourceSeqStart: 762,
  sourceSeqEnd: 763,
  startedAt: 1776880212000,
  createdAt: 1776880212100,
  status: "completed",
  callId: "toolu_long_output",
  toolName: "ToolSearch",
  toolArgs: {
    query: "select:LongOutput",
    max_results: 1,
  },
  output: `Matched tool: LongOutput\nresult_id=${"0123456789abcdef".repeat(20)}`,
  approvalStatus: null,
  durationMs: 100,
});

const notifyUserShort: TimelineRow = toolRow({
  id: "thr_bj3p5vk9py:tool:call_MZFh9Lp2X4LkW9gQteoyDB2F",
  threadId: "thr_bj3p5vk9py",
  turnId: "019de9bd-c299-7053-b11d-11b1f40e8b83",
  sourceSeqStart: 13,
  sourceSeqEnd: 13,
  startedAt: 1777743031156,
  createdAt: 1777743031156,
  status: "completed",
  callId: "call_MZFh9Lp2X4LkW9gQteoyDB2F",
  toolName: "notify_user",
  toolArgs: {
    text: "Hi — I’m your bb parent thread for this project. I’ll coordinate work by delegating substantive coding, debugging, and investigation tasks to child threads in isolated worktrees, then review results and report back.\n\nA few quick preferences so I can work the way you like:\n1. What should I call you?\n2. Do you prefer heavy delegation with concise summaries, or more hands-on collaboration with more frequent check-ins?\n3. What kinds of tasks should I expect most often: implementation, debugging, planning/reviews, or something else?",
  },
  output: "Notification delivered",
  approvalStatus: null,
  durationMs: 0,
});

const notifyUserLong: TimelineRow = toolRow({
  id: "thr_bj3p5vk9py:tool:call_llaogf7VfpS1YkeQ2iIPUuL7",
  threadId: "thr_bj3p5vk9py",
  turnId: "019de9bd-c299-7053-b11d-11b1f40e8b83",
  sourceSeqStart: 28209,
  sourceSeqEnd: 28209,
  startedAt: 1777800000000,
  createdAt: 1777800000000,
  status: "completed",
  callId: "call_llaogf7VfpS1YkeQ2iIPUuL7",
  toolName: "notify_user",
  toolArgs: {
    text: "Here’s the merge-evaluation summary.\n\n## 1. `bb/daemon-protocol-phase6-cleanup`\n\n**Status:** code complete, validated by worker, Claude review active. **Not merging without your explicit go-ahead.**\n\n**Commits over `main` (`d75f390c`):**\n- `452df600` — remove daemon high-water response compatibility\n- `c1261311` — remove completed daemon cutover scaffolding\n\n**Diff:** 19 files, **+75 / -3502**, net **-3427 LOC**.\n\n| Area | Files | Diff | Responsibility |\n| --- | --- | ---: | --- |\n| One-off cutover tooling/docs | server migration script, runner, test, runbook | **-2945** | Delete post-live-migration executable scaffolding. Git history is the archive. |\n| Plans/docs cleanup | delete completed host cutover plan; update simplification/complexity plans | **-415** | Keep roadmap accurate; remove completed plan per AGENTS.md. |\n| Server runtime/tests/package | command-result route, session route, events comment, package dep/script, tests | **-62** | Remove response high-water computation and stale naming. |\n| Host daemon tests/helpers | test server/session result expectations | **-14** | Stop modeling high-water marks in daemon-facing tests. |\n| Contract package | session response schemas/tests | **+13** | Tighten contract to reject removed field. |\n| DB public surface | `packages/db/src/data/index.ts` | **-1** | Stop exporting internal `getHighWaterMarks`. |\n\n### Contract boundary changes\n- `/internal/session/open` response no longer includes `threadHighWaterMarks`.\n- `/internal/session/command-result` response is now strictly `{ ok: true }`.\n- Contract schemas are `.strict()`, so old response fields are rejected rather than silently tolerated.\n- Host daemon tests now assert the removed field is absent/rejected.\n\n### Main risk / decision\nThe big decision is whether we are comfortable deleting the one-off migration tooling now. It’s the right simplification move after successful live cutover, but it is a burn-the-bridge step; recovery would be via git history, not a current script.",
  },
  output: "Notification delivered",
  approvalStatus: null,
  durationMs: 50,
});

const runningTool: TimelineRow = toolRow({
  id: "thr_yn2i6jeaca:tool:toolu_running",
  threadId: "thr_yn2i6jeaca",
  turnId: "turn_8840389c92b04db7_1",
  sourceSeqStart: 900,
  sourceSeqEnd: 900,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  callId: "toolu_running",
  toolName: "TodoWrite",
  toolArgs: {
    todos: [
      {
        content:
          "Verify dead code claim: timeline-activity-group-summary.ts & timeline-assistant-grouping.ts have no consumers",
        status: "in_progress",
        activeForm: "Verifying dead-code claim on two timeline modules",
      },
    ],
  },
  output: "",
  approvalStatus: null,
  durationMs: null,
});

const errorTool: TimelineRow = toolRow({
  id: "thr_yn2i6jeaca:tool:toolu_error",
  threadId: "thr_yn2i6jeaca",
  turnId: "turn_8840389c92b04db7_1",
  sourceSeqStart: 901,
  sourceSeqEnd: 902,
  startedAt: 1776880300000,
  createdAt: 1776880300100,
  status: "error",
  callId: "toolu_error",
  toolName: "ToolSearch",
  toolArgs: {
    query: "select:TodoWrite",
    max_results: 1,
  },
  output: "Tool failed: deferred tool registry unavailable",
  approvalStatus: null,
  durationMs: 100,
});

const interruptedTool: TimelineRow = toolRow({
  id: "thr_bj3p5vk9py:tool:call_interrupted",
  threadId: "thr_bj3p5vk9py",
  turnId: "019de9bd-c299-7053-b11d-11b1f40e8b83",
  sourceSeqStart: 950,
  sourceSeqEnd: 951,
  startedAt: 1777743100000,
  createdAt: 1777743100200,
  status: "interrupted",
  callId: "call_interrupted",
  toolName: "notify_user",
  toolArgs: {
    text: "Got it. I’ve recorded this workflow and started the main Codex/GPT-5.5 xhigh worker in its own worktree to familiarize itself with the five change ranges before we process comments.\n\nI’ll wait for its readiness summary, then I’ll ask you for the first batch of 3–4 review comments and run the triage → fix/commit → review-check cycle you described.",
  },
  output: "",
  approvalStatus: null,
  durationMs: 200,
});

const waitingApprovalTool: TimelineRow = toolRow({
  id: "thr_4z2watgfgm:tool:toolu_waiting_approval",
  threadId: "thr_4z2watgfgm",
  turnId: "turn_b40752bbbd9145cb_1",
  sourceSeqStart: 960,
  sourceSeqEnd: 960,
  startedAt: 1777933900000,
  createdAt: 1777933900000,
  status: "pending",
  callId: "toolu_waiting_approval",
  toolName: "ScheduleWakeup",
  toolArgs: {
    delaySeconds: 90,
    reason: "checking on parallel review agents",
    prompt: "resume review synthesis once subagents return",
  },
  output: "",
  approvalStatus: "waiting_for_approval",
  durationMs: null,
});

const deniedTool: TimelineRow = toolRow({
  id: "thr_4z2watgfgm:tool:toolu_denied",
  threadId: "thr_4z2watgfgm",
  turnId: "turn_b40752bbbd9145cb_1",
  sourceSeqStart: 961,
  sourceSeqEnd: 961,
  startedAt: 1777933910000,
  createdAt: 1777933910000,
  status: "completed",
  callId: "toolu_denied",
  toolName: "ScheduleWakeup",
  toolArgs: {
    delaySeconds: 90,
    reason: "checking on parallel review agents",
    prompt: "resume review synthesis once subagents return",
  },
  output: "",
  approvalStatus: "denied",
  durationMs: 500,
});

interface SkillReadRowArgs {
  idSuffix: string;
  sequenceOffset: number;
  skillPath: string;
}

interface SkillReadStoryState {
  hint: string;
  label: string;
  row: TimelineRow;
}

function createSkillReadRow(args: SkillReadRowArgs): TimelineRow {
  return fileReadRow({
    id: `thr_skill_read:file-read:toolu_skill_read_${args.idSuffix}`,
    threadId: "thr_skill_read",
    turnId: "turn_skill_read_1",
    sourceSeqStart: 970 + args.sequenceOffset,
    sourceSeqEnd: 971 + args.sequenceOffset,
    startedAt: 1777933920000 + args.sequenceOffset,
    createdAt: 1777933920000 + args.sequenceOffset,
    status: "completed",
    callId: `toolu_skill_read_${args.idSuffix}`,
    path: args.skillPath,
    durationMs: 130,
  });
}

const projectClaudeSkillReadTool = createSkillReadRow({
  idSuffix: "project_claude",
  sequenceOffset: 0,
  skillPath:
    "/Users/brsbl/Code/bb/.claude/skills/moss-hardening-review/SKILL.md",
});

const userClaudeSymlinkSkillReadTool = createSkillReadRow({
  idSuffix: "user_claude_symlink",
  sequenceOffset: 2,
  skillPath: "/Users/brsbl/.claude/skills/personal-review/SKILL.md",
});

const projectCodexSkillReadTool = createSkillReadRow({
  idSuffix: "project_codex",
  sequenceOffset: 4,
  skillPath: "/Users/brsbl/Code/bb/.codex/skills/workspace-tools/SKILL.md",
});

const userCodexSkillReadTool = createSkillReadRow({
  idSuffix: "user_codex",
  sequenceOffset: 6,
  skillPath: "/Users/brsbl/.codex/skills/html-previews/SKILL.md",
});

const codexSystemSkillReadTool = createSkillReadRow({
  idSuffix: "codex_system",
  sequenceOffset: 8,
  skillPath: "/Users/brsbl/.codex/skills/.system/openai-docs/SKILL.md",
});

const codexPluginNestedSkillReadTool = createSkillReadRow({
  idSuffix: "codex_plugin_nested",
  sequenceOffset: 10,
  skillPath:
    "/Users/brsbl/.codex/plugins/cache/openai-bundled/browser/26.608.12217/skills/control-in-app-browser/SKILL.md",
});

const claudePluginNestedSkillReadTool = createSkillReadRow({
  idSuffix: "claude_plugin_nested",
  sequenceOffset: 12,
  skillPath:
    "/Users/brsbl/.claude/plugins/cache/claude-plugins-official/frontend-design/bd7cf41fc8a4/skills/frontend-design/SKILL.md",
});

const pluginRootSkillReadTool = createSkillReadRow({
  idSuffix: "plugin_root",
  sequenceOffset: 14,
  skillPath:
    "/Users/brsbl/.codex/plugins/cache/openai-bundled/browser/26.608.12217/SKILL.md",
});

const skillReadStoryStates: SkillReadStoryState[] = [
  {
    label: "Project Claude skill",
    hint: ".claude/skills/<skill>/SKILL.md",
    row: projectClaudeSkillReadTool,
  },
  {
    label: "User Claude skill",
    hint: "personal install path, including symlinked entries",
    row: userClaudeSymlinkSkillReadTool,
  },
  {
    label: "Project Codex skill",
    hint: ".codex/skills/<skill>/SKILL.md",
    row: projectCodexSkillReadTool,
  },
  {
    label: "User Codex skill",
    hint: "$CODEX_HOME/skills/<skill>/SKILL.md",
    row: userCodexSkillReadTool,
  },
  {
    label: "Codex system skill",
    hint: "$CODEX_HOME/skills/.system/<skill>/SKILL.md",
    row: codexSystemSkillReadTool,
  },
  {
    label: "Codex plugin skill",
    hint: "plugins/cache/<market>/<plugin>/<version>/skills/<skill>/SKILL.md",
    row: codexPluginNestedSkillReadTool,
  },
  {
    label: "Claude plugin skill",
    hint: "plugins/cache/<market>/<plugin>/<version>/skills/<skill>/SKILL.md",
    row: claudePluginNestedSkillReadTool,
  },
  {
    label: "Plugin root skill",
    hint: "plugins/cache/<market>/<plugin>/<version>/SKILL.md",
    row: pluginRootSkillReadTool,
  },
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="ToolSearch"
        hint="completed, scalar args, one-line match result"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([toolSearchTool.id])}
            timelineRows={[toolSearchTool]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="ToolSearch — long output line"
        hint="output scrolls horizontally without moving the divider"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([longOutputTool.id])}
            timelineRows={[longOutputTool]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="notify_user — short"
        hint="single multi-line text arg, exercises the Show more overlay"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([notifyUserShort.id])}
            timelineRows={[notifyUserShort]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="notify_user — long"
        hint="long markdown arg renders inside the row body"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([notifyUserLong.id])}
            timelineRows={[notifyUserLong]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="running"
        hint="status=pending, output empty, completedAt null"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[runningTool]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="error"
        hint="status=error, real toolArgs, error result string"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[errorTool]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="waiting for approval"
        hint="approvalStatus=waiting_for_approval, queued before execution"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[waitingApprovalTool]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="interrupted"
        hint="status=interrupted, user steered before tool returned"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[interruptedTool]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="denied"
        hint="approvalStatus=denied, user rejected the approval request"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[deniedTool]} />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

export function SkillReads() {
  return (
    <StoryCard labelWidth="260px">
      {skillReadStoryStates.map((state) => (
        <StoryRow key={state.row.id} label={state.label} hint={state.hint}>
          <TimelineStage>
            <ThreadTimelineRows {...baseProps} timelineRows={[state.row]} />
          </TimelineStage>
        </StoryRow>
      ))}
    </StoryCard>
  );
}

export function NativeSkillCall() {
  return (
    <StoryCard>
      <StoryRow
        label="Claude native Skill call"
        hint="provider presentation uses the established lightning glyph"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[nativeSkillTool]} />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
