import { describe, expect, it } from "vitest";
import { buildBridgeSharePayload } from "./shell-share";

describe("buildBridgeSharePayload", () => {
  it("gives iOS a real url item for a bare link", () => {
    expect(
      buildBridgeSharePayload("ios", {
        title: "Fix the flaky test",
        url: "https://bee.getbb.app/threads/thr_1",
      }),
    ).toEqual({
      content: {
        title: "Fix the flaky test",
        url: "https://bee.getbb.app/threads/thr_1",
      },
      options: {
        dialogTitle: "Share Fix the flaky test",
        subject: "Fix the flaky test",
      },
    });
  });

  it("gives Android one message, because it ignores url", () => {
    expect(
      buildBridgeSharePayload("android", {
        title: "bb",
        url: "https://bee.getbb.app/threads/thr_1",
      }).content,
    ).toEqual({
      title: "bb",
      message: "https://bee.getbb.app/threads/thr_1",
    });
  });

  it("keeps both parts when the page shares text and a link", () => {
    expect(
      buildBridgeSharePayload("ios", {
        text: "Look at this run",
        url: "https://bee.getbb.app/threads/thr_1",
      }).content,
    ).toEqual({
      title: undefined,
      message: "Look at this run\n\nhttps://bee.getbb.app/threads/thr_1",
    });
  });

  it("does not repeat a url the text already carries", () => {
    const url = "https://bee.getbb.app/threads/thr_1";
    expect(buildBridgeSharePayload("ios", { text: url, url }).content).toEqual({
      title: undefined,
      message: url,
    });
  });

  it("falls back to a plain dialog title", () => {
    expect(
      buildBridgeSharePayload("ios", { text: "hello" }).options.dialogTitle,
    ).toBe("Share");
    expect(
      buildBridgeSharePayload("ios", { title: "   ", text: "hello" }).options
        .dialogTitle,
    ).toBe("Share");
  });
});
