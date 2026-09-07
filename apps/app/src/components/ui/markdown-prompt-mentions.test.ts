import { describe, expect, it } from "vitest";
import type { Paragraph, PhrasingContent, Root } from "mdast";
import type { PromptMentionResource } from "@bb/domain";
import {
  remarkPromptMentions,
  substitutePromptMentions,
} from "./markdown-prompt-mentions";

const THREAD_RESOURCE: PromptMentionResource = {
  kind: "thread",
  threadId: "thr_child",
  projectId: "proj_demo",
  label: "Rebuild comments",
};

const PATH_RESOURCE: PromptMentionResource = {
  kind: "path",
  source: "workspace",
  entryKind: "file",
  path: "src/foo_bar.ts",
  label: "foo_bar.ts",
};

const COMMAND_RESOURCE: PromptMentionResource = {
  kind: "command",
  trigger: "/",
  name: "deploy",
  source: "command",
  origin: "user",
  label: "deploy",
  argumentHint: null,
};

function spanAt(text: string, token: string, resource: PromptMentionResource) {
  const start = text.indexOf(token);
  if (start < 0) {
    throw new Error(`token ${token} not found in ${text}`);
  }
  return { start, end: start + token.length, resource };
}

describe("substitutePromptMentions", () => {
  it("returns the text unchanged with no mentions", () => {
    const result = substitutePromptMentions("plain body", []);
    expect(result.content).toBe("plain body");
    expect(result.mentions).toEqual([]);
  });

  it("replaces a mention span with a sentinel and records its resource", () => {
    const text = "See @thread:thr_child here.";
    const result = substitutePromptMentions(text, [
      spanAt(text, "@thread:thr_child", THREAD_RESOURCE),
    ]);

    expect(result.content).not.toContain("@thread:thr_child");
    expect(result.content.startsWith("See ")).toBe(true);
    expect(result.content.endsWith(" here.")).toBe(true);
    expect(result.mentions).toEqual([
      { resource: THREAD_RESOURCE, serializedText: "@thread:thr_child" },
    ]);
  });

  it("substitutes every mention kind in source order", () => {
    const text = "Ask @thread:thr_child about @src/foo_bar.ts then /deploy.";
    const result = substitutePromptMentions(text, [
      spanAt(text, "@thread:thr_child", THREAD_RESOURCE),
      spanAt(text, "@src/foo_bar.ts", PATH_RESOURCE),
      spanAt(text, "/deploy", COMMAND_RESOURCE),
    ]);

    expect(result.mentions.map((mention) => mention.serializedText)).toEqual([
      "@thread:thr_child",
      "@src/foo_bar.ts",
      "/deploy",
    ]);
    expect(result.mentions.map((mention) => mention.resource.kind)).toEqual([
      "thread",
      "path",
      "command",
    ]);
    expect(result.content).not.toContain("@thread:thr_child");
    expect(result.content).not.toContain("@src/foo_bar.ts");
  });

  it("preserves the index ordering even when mentions arrive unsorted", () => {
    const text = "Ask @thread:thr_child about @src/foo_bar.ts.";
    const result = substitutePromptMentions(text, [
      spanAt(text, "@src/foo_bar.ts", PATH_RESOURCE),
      spanAt(text, "@thread:thr_child", THREAD_RESOURCE),
    ]);
    expect(result.mentions.map((mention) => mention.resource.kind)).toEqual([
      "thread",
      "path",
    ]);
  });

  it("drops an overlapping mention so each sentinel maps to one resource", () => {
    const text = "@src/foo_bar.ts";
    const result = substitutePromptMentions(text, [
      spanAt(text, "@src/foo_bar.ts", PATH_RESOURCE),
      { start: 1, end: 5, resource: THREAD_RESOURCE },
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]?.resource.kind).toBe("path");
  });

  it("drops a mention whose range falls outside the text", () => {
    const text = "short";
    const result = substitutePromptMentions(text, [
      { start: 0, end: 99, resource: THREAD_RESOURCE },
    ]);
    expect(result.content).toBe("short");
    expect(result.mentions).toEqual([]);
  });
});

describe("remarkPromptMentions", () => {
  function mentionNodes(children: readonly PhrasingContent[]) {
    return children.filter(
      (child) => child.data?.hName === "bb-prompt-mention",
    );
  }

  it("rewrites each sentinel into an indexed mention node", () => {
    const text = "Ask @thread:thr_child and @src/foo_bar.ts.";
    const { content } = substitutePromptMentions(text, [
      spanAt(text, "@thread:thr_child", THREAD_RESOURCE),
      spanAt(text, "@src/foo_bar.ts", PATH_RESOURCE),
    ]);
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: content }],
    };
    const tree: Root = { type: "root", children: [paragraph] };

    remarkPromptMentions()(tree);

    const mentions = mentionNodes(paragraph.children);
    expect(mentions).toHaveLength(2);
    expect(
      mentions.map((node) => node.data?.hProperties?.dataMentionIndex),
    ).toEqual([0, 1]);
  });

  it("leaves a sentinel-free body untouched", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "no mentions here" }],
    };
    const tree: Root = { type: "root", children: [paragraph] };

    remarkPromptMentions()(tree);

    expect(paragraph.children).toHaveLength(1);
    expect(paragraph.children[0]).toMatchObject({
      type: "text",
      value: "no mentions here",
    });
  });
});
