import { describe, expect, it } from "vitest";
import { parseCodexRequestBody, parseRequestBody } from "./request-body.js";

const accountUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nextAccountUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const encode = (value: object) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("Claude request parsing", () => {
  it.each([accountUuid, "invalid-account-uuid", 123, null])(
    "extracts the own session independently of account UUID %s",
    (account) => {
      const body = encode({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            account_uuid: account,
            session_id: sessionId,
            parent_session_id: "parent",
            device_id: "device",
          }),
        },
      });
      const parsed = parseRequestBody(body);
      expect(parsed.family).toBe("fable");
      expect(parsed.affinityId).toBe(`session:${sessionId}`);
      expect(parsed.parentAffinityId).toBe("session:parent");
      if (account === "invalid-account-uuid" || account === 123)
        expect(parsed.forAccount(nextAccountUuid)).toBe(body);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "   ",
    123,
    [],
    { nested: "session" },
    "a\nb",
    "a\u007fb",
    "a\u0085b",
    "x".repeat(513),
  ])(
    "rejects invalid session %j while preserving it and extra metadata during account rewrite",
    (session) => {
      const user = {
        account_uuid: accountUuid,
        session_id: session,
        parent_session_id: sessionId,
        device_id: sessionId,
        extension: { keep: true },
      };
      const request = {
        model: "claude-fable-5",
        metadata: { user_id: JSON.stringify(user), extra: "keep" },
        messages: [{ role: "user", content: "message" }],
      };
      const parsed = parseRequestBody(encode(request));
      expect(parsed.affinityId).toBeNull();
      expect(parsed.parentAffinityId).toBeNull();
      const rewritten = JSON.parse(
        new TextDecoder().decode(parsed.forAccount(nextAccountUuid)),
      );
      expect(rewritten).toEqual({
        ...request,
        metadata: {
          ...request.metadata,
          user_id: JSON.stringify({ ...user, account_uuid: nextAccountUuid }),
        },
      });
    },
  );

  it.each([
    { parent: "parent", expected: "session:parent" },
    { parent: "x".repeat(512), expected: `session:${"x".repeat(512)}` },
    { parent: sessionId, expected: null },
    { parent: "", expected: null },
    { parent: " \t ", expected: null },
    { parent: "bad\u0085parent", expected: null },
    { parent: "x".repeat(513), expected: null },
    { parent: { invalid: true }, expected: null },
  ])(
    "validates parent $parent without losing native metadata",
    ({ parent, expected }) => {
      const user = {
        account_uuid: accountUuid,
        session_id: sessionId,
        parent_session_id: parent,
        extra: { keep: [1, 2] },
      };
      const request = {
        metadata: { user_id: JSON.stringify(user), extra: "keep" },
        messages: [{ role: "user", content: "unchanged prefix" }],
      };
      const body = encode(request);
      const parsed = parseRequestBody(body);
      expect(parsed.affinityId).toBe(`session:${sessionId}`);
      expect(parsed.parentAffinityId).toBe(expected);
      expect(parsed.forAccount(accountUuid)).toBe(body);
      expect(
        JSON.parse(
          new TextDecoder().decode(parsed.forAccount(nextAccountUuid)),
        ),
      ).toEqual({
        ...request,
        metadata: {
          ...request.metadata,
          user_id: JSON.stringify({ ...user, account_uuid: nextAccountUuid }),
        },
      });
    },
  );

  it("accepts a 512-character session and preserves legacy metadata except the account UUID", () => {
    const id = "x".repeat(512);
    expect(
      parseRequestBody(
        encode({ metadata: { user_id: JSON.stringify({ session_id: id }) } }),
      ).affinityId,
    ).toBe(`session:${id}`);
    const body = encode({
      metadata: {
        user_id: `user_hash_account_${accountUuid}_session_${sessionId}`,
        extra: "keep",
      },
    });
    const parsed = parseRequestBody(body);
    expect(parsed.affinityId).toBe(`session:${sessionId}`);
    expect(parsed.parentAffinityId).toBeNull();
    expect(
      JSON.parse(new TextDecoder().decode(parsed.forAccount(nextAccountUuid))),
    ).toEqual({
      metadata: {
        user_id: `user_hash_account_${nextAccountUuid}_session_${sessionId}`,
        extra: "keep",
      },
    });
  });

  it.each([
    "not-json",
    "[]",
    '{"metadata":{"user_id":"malformed"}}',
    '{"metadata":{"user_id":123}}',
  ])("leaves malformed request %s unbound and byte-identical", (raw) => {
    const body = new TextEncoder().encode(raw);
    const parsed = parseRequestBody(body);
    expect(parsed.affinityId).toBeNull();
    expect(parsed.forAccount(nextAccountUuid)).toBe(body);
  });
});

describe("Codex request parsing", () => {
  it.each<{
    headers: Record<string, string>;
    cacheKey: string | null;
    expected: string | null;
  }>([
    {
      headers: { "session-id": "native", session_id: "legacy" },
      cacheKey: "cache",
      expected: "session:native",
    },
    {
      headers: { session_id: "legacy" },
      cacheKey: "cache",
      expected: "session:legacy",
    },
    {
      headers: { "session-id": "", session_id: "legacy" },
      cacheKey: "cache",
      expected: "session:legacy",
    },
    {
      headers: { "session-id": "x".repeat(513), session_id: "legacy" },
      cacheKey: "cache",
      expected: "session:legacy",
    },
    {
      headers: { "session-id": "bad\u007fid" },
      cacheKey: "cache",
      expected: "cache:cache",
    },
    {
      headers: { "thread-id": "thread" },
      cacheKey: null,
      expected: "session:thread",
    },
    { headers: {}, cacheKey: "same", expected: "cache:same" },
    {
      headers: { "session-id": "same" },
      cacheKey: "same",
      expected: "session:same",
    },
    { headers: {}, cacheKey: "", expected: null },
    { headers: {}, cacheKey: "bad\nid", expected: null },
    { headers: {}, cacheKey: "x".repeat(513), expected: null },
    {
      headers: {},
      cacheKey: "x".repeat(512),
      expected: `cache:${"x".repeat(512)}`,
    },
  ])(
    "resolves affinity $expected without changing request bytes",
    ({ headers, cacheKey, expected }) => {
      const body = new TextEncoder().encode(
        JSON.stringify(
          {
            prompt_cache_key: cacheKey,
            client_metadata: { extra: "keep" },
            input: [
              { type: "compaction_trigger" },
              { type: "compaction", encrypted_content: "fixture" },
            ],
          },
          null,
          2,
        ),
      );
      const parsed = parseCodexRequestBody(body, new Headers(headers));
      expect(parsed.affinityId).toBe(expected);
      expect(parsed.parentAffinityId).toBeNull();
      expect(parsed.forAccount(nextAccountUuid)).toBe(body);
    },
  );

  it.each<{
    name: string;
    headers: Record<string, string>;
    client: object;
    own: string;
    parent: string | null;
  }>([
    {
      name: "separate child thread beats shared root session",
      headers: {
        "session-id": "root",
        "thread-id": "child",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "other",
          forked_from_thread_id: "root",
        }),
      },
      client: { thread_id: "body-child" },
      own: "child",
      parent: "root",
    },
    {
      name: "header turn identity and fork origin beat body and spawn hints",
      headers: {
        "session-id": "root",
        "x-codex-parent-thread-id": "spawn",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "child",
          forked_from_thread_id: "fork",
        }),
      },
      client: {
        thread_id: "body-child",
        "x-codex-turn-metadata": JSON.stringify({
          forked_from_thread_id: "body-fork",
        }),
      },
      own: "child",
      parent: "fork",
    },
    {
      name: "body fork origin beats header spawn parent",
      headers: { "session-id": "root", "x-codex-parent-thread-id": "spawn" },
      client: {
        thread_id: "child",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "other",
          forked_from_thread_id: "fork",
        }),
      },
      own: "child",
      parent: "fork",
    },
    {
      name: "body turn identity and parent",
      headers: { "session-id": "root" },
      client: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "child",
          parent_thread_id: "parent",
        }),
      },
      own: "child",
      parent: "parent",
    },
    {
      name: "header spawn parent beats body spawn parent",
      headers: {
        "thread-id": "child",
        "x-codex-turn-metadata": JSON.stringify({ parent_thread_id: "parent" }),
      },
      client: { "x-codex-parent-thread-id": "body-parent" },
      own: "child",
      parent: "parent",
    },
    {
      name: "body native parent survives malformed optional turn metadata",
      headers: { "thread-id": "child", "x-codex-turn-metadata": "not-json" },
      client: {
        "x-codex-parent-thread-id": "parent",
        "x-codex-turn-metadata": 42,
      },
      own: "child",
      parent: "parent",
    },
    {
      name: "malformed client metadata leaves header identity usable",
      headers: { "session-id": "child", "x-codex-parent-thread-id": "parent" },
      client: [],
      own: "child",
      parent: "parent",
    },
    {
      name: "header turn session survives a malformed thread hint",
      headers: {
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "child",
          thread_id: [],
          forked_from_thread_id: "parent",
        }),
      },
      client: { session_id: "body-session" },
      own: "child",
      parent: "parent",
    },
    {
      name: "body session survives a malformed thread hint",
      headers: {},
      client: {
        session_id: "child",
        thread_id: 42,
        "x-codex-parent-thread-id": "parent",
      },
      own: "child",
      parent: "parent",
    },
    {
      name: "body turn session and parent",
      headers: {},
      client: {
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "child",
          parent_thread_id: "parent",
        }),
      },
      own: "child",
      parent: "parent",
    },
    {
      name: "direct session header beats embedded session hints",
      headers: {
        "session-id": "child",
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "other",
          parent_thread_id: "parent",
        }),
      },
      client: { session_id: "body-session" },
      own: "child",
      parent: "parent",
    },
  ])(
    "parses native $name without rewriting payload",
    ({ headers, client, own, parent }) => {
      const body = encode({
        prompt_cache_key: { malformed: true },
        client_metadata: client,
        input: [
          { type: "compaction_trigger" },
          { type: "compaction", encrypted_content: "keep" },
        ],
        extra: { keep: true },
      });
      const parsed = parseCodexRequestBody(body, new Headers(headers));
      expect(parsed.affinityId).toBe(`session:${own}`);
      expect(parsed.parentAffinityId).toBe(
        parent === null ? null : `session:${parent}`,
      );
      expect(parsed.forAccount(nextAccountUuid)).toBe(body);
    },
  );

  it.each([
    { parent: "x".repeat(512), expected: `session:${"x".repeat(512)}` },
    { parent: "child", expected: null },
    { parent: "", expected: null },
    { parent: "bad\nparent", expected: null },
    { parent: "bad\u007fparent", expected: null },
    { parent: "x".repeat(513), expected: null },
    { parent: { invalid: true }, expected: null },
  ])(
    "validates native fork parent $parent independently",
    ({ parent, expected }) => {
      const body = encode({
        client_metadata: {
          thread_id: "child",
          "x-codex-turn-metadata": JSON.stringify({
            forked_from_thread_id: parent,
          }),
        },
      });
      const parsed = parseCodexRequestBody(body, new Headers());
      expect(parsed.affinityId).toBe("session:child");
      expect(parsed.parentAffinityId).toBe(expected);
      expect(parsed.forAccount(null)).toBe(body);
    },
  );

  it("does not inherit a parent for an anonymous cache-key request", () => {
    const body = encode({ prompt_cache_key: "cache" });
    const parsed = parseCodexRequestBody(
      body,
      new Headers({ "x-codex-parent-thread-id": "parent" }),
    );
    expect(parsed.affinityId).toBe("cache:cache");
    expect(parsed.parentAffinityId).toBeNull();
  });

  it.each(["not-json", '{"prompt_cache_key":123}', '{"prompt_cache_key":[]}'])(
    "does not infer cache affinity from malformed payload %s",
    (raw) => {
      const body = new TextEncoder().encode(raw);
      const parsed = parseCodexRequestBody(body, new Headers());
      expect(parsed.affinityId).toBeNull();
      expect(parsed.forAccount(null)).toBe(body);
    },
  );
});
