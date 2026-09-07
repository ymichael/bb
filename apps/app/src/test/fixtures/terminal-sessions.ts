import type { TerminalSession } from "@bb/server-contract";

export function makeTerminalSession(
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id: "term_test",
    threadId: "thr_test",
    environmentId: "env_test",
    hostId: "host_test",
    title: "Terminal",
    initialCwd: "/workspace",
    cols: 100,
    rows: 30,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 0,
    updatedAt: 0,
    lastUserInputAt: null,
    ...overrides,
  };
}
