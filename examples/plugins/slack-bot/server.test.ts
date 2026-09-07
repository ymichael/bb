import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import slackBot from "./server";

const SIGNING_SECRET = "test-signing-secret";

function slackHeaders(rawBody: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    "v0=" +
    createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

function mentionEvent(args: { text: string; ts: string; threadTs?: string }) {
  return JSON.stringify({
    type: "event_callback",
    event: {
      type: "app_mention",
      channel: "C42",
      text: args.text,
      ts: args.ts,
      ...(args.threadTs !== undefined ? { thread_ts: args.threadTs } : {}),
    },
  });
}

async function loadConfigured(): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "slack-bot",
    settings: {
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      project: "proj-1",
    },
    sdk: {
      threads: {
        spawn: async () => ({ id: "th_1" }),
        send: async () => ({ ok: true }),
      },
    },
  });
  await slackBot(host.bb);
  return host;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slack-bot webhook", () => {
  it("answers the Slack URL-verification handshake", async () => {
    const { harness } = await loadConfigured();
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "c-123",
    });
    const response = await harness.fetchHttp("POST", "/events", {
      headers: slackHeaders(rawBody),
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "c-123" });
  });

  it("rejects requests whose signature does not verify", async () => {
    const { harness } = await loadConfigured();
    const rawBody = mentionEvent({ text: "<@U1> hi", ts: "1.1" });
    const response = await harness.fetchHttp("POST", "/events", {
      headers: { ...slackHeaders(rawBody), "x-slack-signature": "v0=nope" },
      body: rawBody,
    });
    expect(response.status).toBe(401);
  });

  it("spawns an attributed BB thread on first mention and stores the kv mapping", async () => {
    const { bb, harness } = await loadConfigured();
    const rawBody = mentionEvent({
      text: "<@U1> run the tests please",
      ts: "111.222",
    });
    const response = await harness.fetchHttp("POST", "/events", {
      headers: slackHeaders(rawBody),
      body: rawBody,
    });
    expect(response.status).toBe(200);

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        {
          projectId: "proj-1",
          prompt: "run the tests please",
          environment: { type: "project-default" },
          title: "Slack: run the tests please",
          origin: "plugin",
          originPluginId: "slack-bot",
        },
      ],
    ]);
    expect(await bb.storage.kv.get("slack:111.222")).toBe("th_1");
    expect(await bb.storage.kv.get("bb:th_1")).toEqual({
      channel: "C42",
      threadTs: "111.222",
    });
  });

  it("sends a follow-up to the mapped thread on a second mention", async () => {
    const { harness } = await loadConfigured();
    const first = mentionEvent({ text: "<@U1> start", ts: "111.222" });
    await harness.fetchHttp("POST", "/events", {
      headers: slackHeaders(first),
      body: first,
    });
    const second = mentionEvent({
      text: "<@U1> and lint too",
      ts: "111.333",
      threadTs: "111.222",
    });
    await harness.fetchHttp("POST", "/events", {
      headers: slackHeaders(second),
      body: second,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "th_1",
          mode: "auto",
          input: [{ type: "text", text: "and lint too" }],
        },
      ],
    ]);
  });

  it("reports needs-configuration and serves 503 when unconfigured", async () => {
    const host = createFakePluginHost({ pluginId: "slack-bot" });
    await slackBot(host.bb);
    expect(host.harness.needsConfigurationMessages).toHaveLength(1);

    const response = await host.harness.fetchHttp("POST", "/events", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
  });
});

describe("slack-bot thread.idle", () => {
  it("posts the agent's answer back into the originating Slack thread", async () => {
    const { bb, harness } = await loadConfigured();
    const rawBody = mentionEvent({ text: "<@U1> summarize", ts: "9.9" });
    await harness.fetchHttp("POST", "/events", {
      headers: slackHeaders(rawBody),
      body: rawBody,
    });

    const postMessage = vi.fn(async () => ({
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", postMessage);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_1", originPluginId: "slack-bot" }),
      lastAssistantText: "All tests pass.",
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [url, init] = postMessage.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.headers.authorization).toBe("Bearer xoxb-test");
    expect(JSON.parse(init.body)).toEqual({
      channel: "C42",
      thread_ts: "9.9",
      text: "All tests pass.",
    });
  });

  it("ignores idle threads this plugin did not spawn", async () => {
    const { harness } = await loadConfigured();
    const postMessage = vi.fn();
    vi.stubGlobal("fetch", postMessage);
    const { errors } = await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_other" }),
      lastAssistantText: "hello",
    });
    expect(errors).toEqual([]);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
