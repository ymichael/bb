import { describe, expect, it } from "vitest";
import { acpAgentProbeSchema, probeAcpAgent } from "./probe.js";

describe("probeAcpAgent", () => {
  it("reports a missing agent instead of throwing", async () => {
    const probe = await probeAcpAgent({
      command: "bb-acp-agent-that-does-not-exist",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(probe.reachable).toBe(false);
    expect(probe.reachable === false && probe.reason).toContain("ENOENT");
    expect(acpAgentProbeSchema.safeParse(probe).success).toBe(true);
  });

  it("gives up on an agent that never answers initialize", async () => {
    const probe = await probeAcpAgent({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      cwd: process.cwd(),
      timeoutMs: 300,
    });

    expect(probe).toEqual({
      reachable: false,
      reason: "the agent did not answer initialize within 300ms",
    });
  });

  it("strips the bridge runtime environment the way a real launch does", async () => {
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const probe = await probeAcpAgent({
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.on("data", () => {
             process.stdout.write(JSON.stringify({
               jsonrpc: "2.0",
               id: 1,
               result: {
                 protocolVersion: 1,
                 agentCapabilities: {
                   sessionCapabilities:
                     process.env.ELECTRON_RUN_AS_NODE === undefined
                       ? { fork: {} }
                       : {},
                 },
               },
             }) + "\\n");
           });`,
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      expect(probe).toEqual({ reachable: true, fork: true });
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previous;
    }
  });

  it("reads the fork capability out of the agent's full reply", async () => {
    const probe = await probeAcpAgent({
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.on("data", () => {
           process.stdout.write(JSON.stringify({
             jsonrpc: "2.0",
             id: 1,
             result: {
               protocolVersion: 1,
               agentCapabilities: {
                 loadSession: true,
                 sessionCapabilities: { fork: {} },
                 promptCapabilities: { image: true },
               },
               authMethods: [{ id: "token" }],
             },
           }) + "\\n");
         });`,
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(probe).toEqual({ reachable: true, fork: true });
  });
});
