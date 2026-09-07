import type {
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineRow,
} from "@bb/server-contract";

export interface DemoThreadSeed {
  id: string;
  title: string;
  minutesAgo: number;
  rows: (threadId: string, startedAt: number) => TimelineRow[];
}

const CWD = "/home/demo/demo-app";

function baseRow(threadId: string, turnId: string, seq: number, at: number) {
  return {
    threadId,
    turnId,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: at,
    createdAt: at,
  };
}

export function conversationRow(args: {
  threadId: string;
  turnId: string;
  seq: number;
  at: number;
  role: "user" | "assistant";
  text: string;
}): TimelineConversationRow {
  const { threadId, turnId, seq, at, role, text } = args;
  const common = {
    ...baseRow(threadId, turnId, seq, at),
    id: `${threadId}:conversation:${seq}`,
    kind: "conversation" as const,
    text,
  };
  if (role === "assistant") {
    return { ...common, role, attachments: null, turnRequest: null };
  }
  return {
    ...common,
    role,
    mentions: [],
    attachments: {
      webImages: 0,
      localImages: 0,
      localFiles: 0,
      imageUrls: [],
      localImagePaths: [],
      localFilePaths: [],
    },
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  };
}

export function commandRow(args: {
  threadId: string;
  turnId: string;
  seq: number;
  at: number;
  command: string;
  output: string;
}): TimelineCommandWorkRow {
  const { threadId, turnId, seq, at, command, output } = args;
  return {
    ...baseRow(threadId, turnId, seq, at),
    id: `${threadId}:command:${seq}`,
    kind: "work",
    workKind: "command",
    status: "completed",
    callId: `${threadId}-call-${seq}`,
    command,
    cwd: CWD,
    source: null,
    output,
    exitCode: 0,
    completedAt: at + 1_200,
    approvalStatus: null,
    activityIntents: [],
  };
}

const ASSISTANT_INTRO = [
  "I looked at how the theme is applied today.",
  "",
  "The palette is set once at startup from `settings.theme`, so a toggle needs",
  "two things: a stored preference, and a listener that re-applies the palette",
  "without a reload.",
  "",
  "## Plan",
  "",
  "1. Persist the choice next to the other user preferences.",
  "2. Re-apply the palette when the value changes.",
  "3. Follow the system setting when the user has not chosen.",
  "",
  "```ts",
  "export function useTheme() {",
  '  const [mode, setMode] = usePreference("theme", "system");',
  "  useEffect(() => applyPalette(resolve(mode)), [mode]);",
  "  return { mode, setMode };",
  "}",
  "```",
  "",
  "Want me to make the change?",
].join("\n");

export const DEMO_THREADS: readonly DemoThreadSeed[] = [
  {
    id: "thr_demo00000001",
    title: "Add a dark mode toggle",
    minutesAgo: 12,
    rows: (threadId, start) => {
      const turnId = `${threadId}-turn-1`;
      return [
        conversationRow({
          threadId,
          turnId,
          seq: 1,
          at: start,
          role: "user",
          text: "Add a dark mode toggle to the settings screen.",
        }),
        commandRow({
          threadId,
          turnId,
          seq: 2,
          at: start + 2_000,
          command: "rg -n 'theme' src --type ts",
          output: [
            'src/settings/appearance.ts:14:export const THEME_KEY = "theme";',
            "src/settings/appearance.ts:22:  applyPalette(resolveTheme(stored));",
            "src/app/boot.ts:41:  applyPalette(readTheme());",
          ].join("\n"),
        }),
        conversationRow({
          threadId,
          turnId,
          seq: 3,
          at: start + 6_000,
          role: "assistant",
          text: ASSISTANT_INTRO,
        }),
      ];
    },
  },
  {
    id: "thr_demo00000002",
    title: "Fix the flaky checkout test",
    minutesAgo: 90,
    rows: (threadId, start) => {
      const turnId = `${threadId}-turn-1`;
      return [
        conversationRow({
          threadId,
          turnId,
          seq: 1,
          at: start,
          role: "user",
          text: "The checkout test fails about one run in five. Find out why.",
        }),
        commandRow({
          threadId,
          turnId,
          seq: 2,
          at: start + 3_000,
          command: "pnpm test checkout --repeat 20",
          output: [
            "✓ checkout > applies a discount code (18 runs)",
            "✗ checkout > applies a discount code (2 runs)",
            "  expected 1 request, received 2",
          ].join("\n"),
        }),
        conversationRow({
          threadId,
          turnId,
          seq: 3,
          at: start + 9_000,
          role: "assistant",
          text: [
            "The test does not wait for the first request to settle, so a retry",
            "sometimes lands inside the assertion window.",
            "",
            "The fix is to await the pending request instead of a fixed delay.",
          ].join("\n"),
        }),
      ];
    },
  },
  {
    id: "thr_demo00000003",
    title: "Speed up the search index",
    minutesAgo: 240,
    rows: (threadId, start) => {
      const turnId = `${threadId}-turn-1`;
      return [
        conversationRow({
          threadId,
          turnId,
          seq: 1,
          at: start,
          role: "user",
          text: "Search takes about two seconds on the large fixture. Where does the time go?",
        }),
        conversationRow({
          threadId,
          turnId,
          seq: 2,
          at: start + 5_000,
          role: "assistant",
          text: [
            "Almost all of it is in `buildIndex`, which re-reads every document on",
            "each query. Caching the index and invalidating it on write brings a",
            "warm query under 50ms.",
          ].join("\n"),
        }),
      ];
    },
  },
];

export const DEMO_REPLY = [
  "That change is straightforward.",
  "",
  "I would put the toggle next to the other appearance settings and store the",
  "choice with the existing preferences, so it survives a restart.",
  "",
  "This is the bb demo server, so I am replaying a scripted answer rather than",
  "running a real agent.",
].join("\n");

export const DEMO_REPLY_COMMAND = {
  command: "rg -n 'appearance' src --type ts",
  output: 'src/settings/appearance.ts:14:export const THEME_KEY = "theme";',
};
