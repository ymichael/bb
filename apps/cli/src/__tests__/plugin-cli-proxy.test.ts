import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { RESERVED_BB_CLI_COMMANDS } from "@bb/domain/plugin-cli";

import {
  CORE_COMMAND_GROUPS,
  pluginProxyCandidate,
} from "../command-groups.js";
import {
  describeUnreachableServer,
  fetchPluginCliContributions,
  findDisabledPluginForCommand,
  findPluginCliCommand,
  PLUGIN_CLI_HEADERS_TIMEOUT_MS,
  runPluginCliCommand,
  type PluginCliContributionEntry,
} from "../plugin-cli-proxy.js";

describe("reserved bb CLI command names", () => {
  it("matches the complete core command-group registry plus help", () => {
    expect([...RESERVED_BB_CLI_COMMANDS].sort()).toEqual(
      [...CORE_COMMAND_GROUPS.map((group) => group.name), "help"].sort(),
    );
  });
});

describe("pluginProxyCandidate", () => {
  const known = new Set(["thread", "plugin", "help"]);

  it("returns unknown command names", () => {
    expect(pluginProxyCandidate("linear", known)).toBe("linear");
  });

  it("proxies the builtin plugin commands the kernel no longer owns", () => {
    const names = new Set(CORE_COMMAND_GROUPS.map((group) => group.name));
    names.add("help");
    for (const moved of ["automation", "connect"]) {
      expect(RESERVED_BB_CLI_COMMANDS).not.toContain(moved);
      expect(pluginProxyCandidate(moved, names)).toBe(moved);
    }
  });

  it("never proxies flags, empty args, or core commands", () => {
    expect(pluginProxyCandidate(undefined, known)).toBeNull();
    expect(pluginProxyCandidate("", known)).toBeNull();
    expect(pluginProxyCandidate("--version", known)).toBeNull();
    expect(pluginProxyCandidate("-h", known)).toBeNull();
    expect(pluginProxyCandidate("thread", known)).toBeNull();
    expect(pluginProxyCandidate("help", known)).toBeNull();
  });
});

describe("fetchPluginCliContributions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes an unreachable server from an old/invalid one", async () => {
    const thrown = new Error("ECONNREFUSED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw thrown;
      }),
    );
    await expect(
      fetchPluginCliContributions("http://localhost"),
    ).resolves.toEqual({
      outcome: "unreachable",
      cause: thrown,
      attempts: 1,
      lastTimeoutMs: 2000,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(
      fetchPluginCliContributions("http://localhost"),
    ).resolves.toEqual({
      outcome: "invalid",
    });
  });

  it("returns validated contribution entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              cliCommands: [
                {
                  pluginId: "connect",
                  name: "connect",
                  summary: "s",
                  commands: [],
                },
                { bogus: true },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await fetchPluginCliContributions("http://localhost");
    expect(result).toEqual({
      outcome: "ok",
      contributions: [
        { pluginId: "connect", name: "connect", summary: "s", commands: [] },
      ],
    });
  });
});

describe("fetchPluginCliContributions retries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okResponse = () =>
    new Response(JSON.stringify({ cliCommands: [] }), { status: 200 });

  function timeoutError(): Error {
    return Object.assign(
      new Error("The operation was aborted due to timeout"),
      {
        name: "TimeoutError",
      },
    );
  }

  function connectError(code: string): Error {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect ${code} 127.0.0.1:38886`), {
        code,
      }),
    });
  }

  function recordingSleep() {
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
  }

  it("recovers when a busy server answers on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { slept, sleep } = recordingSleep();

    await expect(
      fetchPluginCliContributions("http://localhost", 2000, { sleep }),
    ).resolves.toEqual({ outcome: "ok", contributions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([150]);
  });

  it("retries when the response body transport fails", async () => {
    const bodyFailedResponse = new Response("{}");
    vi.spyOn(bodyFailedResponse, "json").mockRejectedValue(
      connectError("UND_ERR_SOCKET"),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bodyFailedResponse)
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { slept, sleep } = recordingSleep();

    await expect(
      fetchPluginCliContributions("http://localhost", 2000, { sleep }),
    ).resolves.toEqual({ outcome: "ok", contributions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([150]);
  });

  it("does not retry malformed response JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { slept, sleep } = recordingSleep();

    await expect(
      fetchPluginCliContributions("http://localhost", 2000, { sleep }),
    ).resolves.toEqual({ outcome: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("widens the probe window on each retry before giving up", async () => {
    const fetchMock = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal("fetch", fetchMock);
    const { slept, sleep } = recordingSleep();

    const result = await fetchPluginCliContributions("http://localhost", 2000, {
      sleep,
    });
    expect(result).toMatchObject({
      outcome: "unreachable",
      attempts: 3,
      lastTimeoutMs: 4000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([150, 500]);
  });

  it("fails fast when nothing is listening", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectError("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const { slept, sleep } = recordingSleep();

    const result = await fetchPluginCliContributions("http://localhost", 2000, {
      sleep,
    });
    expect(result).toMatchObject({ outcome: "unreachable", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("fails fast when the shell is sandboxed", async () => {
    for (const code of ["EPERM", "EACCES"]) {
      const fetchMock = vi.fn().mockRejectedValue(connectError(code));
      vi.stubGlobal("fetch", fetchMock);
      const { slept, sleep } = recordingSleep();

      const result = await fetchPluginCliContributions(
        "http://localhost",
        2000,
        { sleep },
      );
      expect(result).toMatchObject({ outcome: "unreachable", attempts: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(slept).toEqual([]);
    }
  });

  it("retries a dropped socket", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectError("ECONNRESET"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { sleep } = recordingSleep();

    await expect(
      fetchPluginCliContributions("http://localhost", 2000, { sleep }),
    ).resolves.toEqual({ outcome: "ok", contributions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("describeUnreachableServer", () => {
  const url = "http://127.0.0.1:38886";

  function fetchFailed(code: string): Error {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect ${code} 127.0.0.1:38886`), {
        code,
      }),
    });
  }

  function aggregateFetchFailed(codes: string[]): Error {
    const errors = codes.map((code, index) =>
      Object.assign(new Error(`connect ${code} address-${index + 1}:38886`), {
        code,
      }),
    );
    return new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError(errors), {
        code: errors[0]?.code,
      }),
    });
  }

  it("says bb is not running only on ECONNREFUSED", () => {
    expect(describeUnreachableServer(url, fetchFailed("ECONNREFUSED"))).toBe(
      `bb is not running at ${url} — open the bb app, then re-run this command.`,
    );
  });

  it("requires every aggregate connection attempt to be refused", () => {
    expect(
      describeUnreachableServer(
        url,
        aggregateFetchFailed(["ECONNREFUSED", "ECONNREFUSED"]),
      ),
    ).toBe(
      `bb is not running at ${url} — open the bb app, then re-run this command.`,
    );

    const mixedMessage = describeUnreachableServer(
      url,
      aggregateFetchFailed(["ECONNREFUSED", "EPERM"]),
    );
    expect(mixedMessage).toContain(`Cannot reach bb at ${url}: EPERM`);
    expect(mixedMessage).toContain("bb may still be running");
    expect(mixedMessage).not.toContain("not running at");
  });

  it("reports a blocked connection without declaring bb down", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const message = describeUnreachableServer(url, fetchFailed(code));
      expect(message).toContain(`Cannot reach bb at ${url}: ${code}`);
      expect(message).toContain("bb may still be running");
      expect(message).not.toContain("not running at");
    }
  });

  it("reports a timeout with the probe window", () => {
    const timeout = Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    });
    const message = describeUnreachableServer(url, timeout, 2000);
    expect(message).toContain(`bb did not respond at ${url} within 2000ms`);
    expect(message).toContain("it may be busy or temporarily unreachable");
    expect(message).not.toContain("not running at");
    expect(message).not.toContain("bb is running");
    expect(message).toContain("re-run it");
  });

  it("names the attempt count once the probe was retried", () => {
    const timeout = Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    });
    const message = describeUnreachableServer(url, timeout, 4000, 3);
    expect(message).toContain("after 3 attempts (last window 4000ms)");
    expect(message).not.toContain("not running at");
  });

  it("falls back to the unwrapped cause chain", () => {
    const err = new TypeError("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
    });
    expect(describeUnreachableServer(url, err)).toBe(
      `Cannot reach bb at ${url}: fetch failed: getaddrinfo ENOTFOUND example.invalid`,
    );
  });
});

describe("findDisabledPluginForCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches an installed-but-disabled plugin by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plugins: [
                { id: "automations", enabled: true },
                { id: "connect", enabled: false },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      findDisabledPluginForCommand("http://localhost", "connect"),
    ).resolves.toEqual({
      id: "connect",
      enabled: false,
      status: null,
      statusDetail: null,
    });
    await expect(
      findDisabledPluginForCommand("http://localhost", "automations"),
    ).resolves.toBeNull();
    await expect(
      findDisabledPluginForCommand("http://localhost", "linear"),
    ).resolves.toBeNull();
  });

  it("matches a disabled plugin by runtime status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plugins: [
                {
                  id: "automations",
                  enabled: true,
                  status: "disabled",
                  statusDetail: "plugin failed to load",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      findDisabledPluginForCommand("http://localhost", "automations"),
    ).resolves.toEqual({
      id: "automations",
      enabled: true,
      status: "disabled",
      statusDetail: "plugin failed to load",
    });
  });

  it("returns null on any fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      findDisabledPluginForCommand("http://localhost", "connect"),
    ).resolves.toBeNull();
  });
});

describe("findPluginCliCommand", () => {
  const contributions: PluginCliContributionEntry[] = [
    { pluginId: "linear", name: "linear", summary: "Linear", commands: [] },
    { pluginId: "acme", name: "acme-tools", summary: "Acme", commands: [] },
  ];

  it("matches on the registered command name, not the plugin id", () => {
    expect(findPluginCliCommand(contributions, "acme-tools")?.pluginId).toBe(
      "acme",
    );
    expect(findPluginCliCommand(contributions, "acme")).toBeUndefined();
    expect(findPluginCliCommand(contributions, "linear")?.pluginId).toBe(
      "linear",
    );
  });
});

describe("runPluginCliCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for output larger than 64 KiB to flush before returning", async () => {
    const stdout = "x".repeat(1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ exitCode: 0, stdout, stderr: "warning" }),
            { status: 200 },
          ),
      ),
    );
    const writes: Array<{ channel: "stdout" | "stderr"; value: string }> = [];
    let pendingWrites = 0;
    const outputStream = (channel: "stdout" | "stderr") => ({
      write(value: string, callback: (error?: Error | null) => void) {
        pendingWrites += 1;
        setTimeout(() => {
          writes.push({ channel, value });
          pendingWrites -= 1;
          callback();
        }, 0);
        return false;
      },
    });

    const exitCode = await runPluginCliCommand(
      "http://localhost",
      "fixture",
      [],
      { stdout: outputStream("stdout"), stderr: outputStream("stderr") },
    );

    expect(exitCode).toBe(0);
    expect(pendingWrites).toBe(0);
    expect(writes).toEqual([
      { channel: "stdout", value: `${stdout}\n` },
      { channel: "stderr", value: "warning\n" },
    ]);
  });

  it("materializes an arbitrary stdin flag only in the proxied request", async () => {
    const requests: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit | undefined) => {
        const parsed = JSON.parse(String(init?.body)) as { argv: string[] };
        requests.push(parsed.argv);
        return new Response(JSON.stringify({ exitCode: 0 }), { status: 200 });
      }),
    );
    const writes: string[] = [];
    const output = {
      write(value: string, callback: (error?: Error | null) => void) {
        writes.push(value);
        callback();
        return true;
      },
    };
    const input = {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("opaque-credential\n");
      },
    };
    const argv = ["deploy", "--credential-stdin", "--format", "json"];

    await expect(
      runPluginCliCommand(
        "http://localhost",
        "fixture",
        argv,
        { stdout: output, stderr: output },
        input,
      ),
    ).resolves.toBe(0);
    expect(argv).toEqual(["deploy", "--credential-stdin", "--format", "json"]);
    expect(requests).toEqual([
      ["deploy", "--credential", "opaque-credential", "--format", "json"],
    ]);
    expect(writes).toEqual([]);
  });

  it("outlives the global fetch headers timeout while a plugin command waits on a human", async () => {
    const RESPONSE_DELAY_MS = 1500;
    const server: Server = createServer((request, response) => {
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            exitCode: 0,
            stdout: `${request.method} ${request.url}`,
          }),
        );
      }, RESPONSE_DELAY_MS);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ headersTimeout: 200 }));
    try {
      await expect(
        fetch(`${baseUrl}/api/v1/plugins/secrets/cli`, { method: "POST" }),
      ).rejects.toMatchObject({
        message: "fetch failed",
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      });

      const writes: string[] = [];
      const stream = {
        write(value: string, callback: (error?: Error | null) => void) {
          writes.push(value);
          callback();
          return true;
        },
      };
      const exitCode = await runPluginCliCommand(
        baseUrl,
        "secrets",
        ["request", "--purpose", "Testing the transport \u2014 an em dash"],
        { stdout: stream, stderr: stream },
      );

      expect(exitCode).toBe(0);
      expect(writes).toEqual(["POST /api/v1/plugins/secrets/cli\n"]);
      expect(PLUGIN_CLI_HEADERS_TIMEOUT_MS).toBeGreaterThan(60 * 60 * 1000);
      expect(PLUGIN_CLI_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(
        2 * 60 * 60 * 1000,
      );
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
