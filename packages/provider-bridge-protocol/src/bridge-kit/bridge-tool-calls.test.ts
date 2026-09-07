import { describe, expect, it } from "vitest";
import {
  buildBridgeToolCallContent,
  decodeToolCallResponsePayload,
} from "./bridge-tool-calls.js";

const PNG = "iVBORw0KGgo=";

describe("decodeToolCallResponsePayload", () => {
  it("keeps text results unchanged", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          { type: "inputText", text: "first" },
          { type: "inputText", text: "second" },
        ],
      }),
    ).toEqual({
      content: "first\nsecond",
      contentBlocks: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      images: [],
      isError: false,
    });
  });

  it("decodes an image-only result into an image rather than OK", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          { type: "inputImage", imageUrl: `data:image/png;base64,${PNG}` },
        ],
      }),
    ).toEqual({
      content: "",
      contentBlocks: [{ type: "image", data: PNG, mimeType: "image/png" }],
      images: [{ data: PNG, mimeType: "image/png" }],
      isError: false,
    });
  });

  it("keeps both halves of a mixed text and image result", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          { type: "inputText", text: "captured" },
          { type: "inputImage", imageUrl: `data:image/jpeg;base64,${PNG}` },
        ],
      }),
    ).toEqual({
      content: "captured",
      contentBlocks: [
        { type: "text", text: "captured" },
        { type: "image", data: PNG, mimeType: "image/jpeg" },
      ],
      images: [{ data: PNG, mimeType: "image/jpeg" }],
      isError: false,
    });
  });

  it("preserves interleaved text and image order", () => {
    const decoded = decodeToolCallResponsePayload({
      success: true,
      contentItems: [
        { type: "inputImage", imageUrl: `data:image/png;base64,${PNG}` },
        { type: "inputText", text: "between" },
        { type: "inputImage", imageUrl: `data:image/jpeg;base64,${PNG}` },
      ],
    });

    expect(buildBridgeToolCallContent(decoded)).toEqual([
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "text", text: "between" },
      { type: "image", data: PNG, mimeType: "image/jpeg" },
    ]);
  });

  it("reports an image result that failed as an error", () => {
    expect(
      decodeToolCallResponsePayload({
        success: false,
        contentItems: [
          { type: "inputImage", imageUrl: `data:image/png;base64,${PNG}` },
        ],
      }).isError,
    ).toBe(true);
  });

  it("keeps a non-data image url as text", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          { type: "inputImage", imageUrl: "https://example.com/a.png" },
        ],
      }),
    ).toEqual({
      content: "https://example.com/a.png",
      contentBlocks: [{ type: "text", text: "https://example.com/a.png" }],
      images: [],
      isError: false,
    });
  });

  it("keeps a data url with an empty payload as text", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          { type: "inputImage", imageUrl: "data:image/png;base64," },
        ],
      }),
    ).toEqual({
      content: "data:image/png;base64,",
      contentBlocks: [{ type: "text", text: "data:image/png;base64," }],
      images: [],
      isError: false,
    });
  });

  it("falls back to OK only when there is neither text nor image", () => {
    expect(
      decodeToolCallResponsePayload({ success: true, contentItems: [] }),
    ).toEqual({
      content: "OK",
      contentBlocks: [{ type: "text", text: "OK" }],
      images: [],
      isError: false,
    });
  });

  it("surfaces empty failures and malformed payloads as errors", () => {
    expect(
      decodeToolCallResponsePayload({ success: false, contentItems: [] }),
    ).toEqual({
      content: "Tool call failed",
      contentBlocks: [{ type: "text", text: "Tool call failed" }],
      images: [],
      isError: true,
    });
    expect(decodeToolCallResponsePayload({ nope: true })).toEqual({
      content: "Invalid tool call response",
      contentBlocks: [{ type: "text", text: "Invalid tool call response" }],
      images: [],
      isError: true,
    });
  });

  it("accepts MIME parameters in an inline image data URL", () => {
    expect(
      decodeToolCallResponsePayload({
        success: true,
        contentItems: [
          {
            type: "inputImage",
            imageUrl: `data:image/svg+xml;charset=utf-8;base64,${PNG}`,
          },
        ],
      }).images,
    ).toEqual([{ data: PNG, mimeType: "image/svg+xml;charset=utf-8" }]);
  });
});

describe("buildBridgeToolCallContent", () => {
  it("emits an image block alone when there is no text", () => {
    expect(
      buildBridgeToolCallContent({
        content: "",
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
    ).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
  });

  it("keeps text first when a result carries both", () => {
    expect(
      buildBridgeToolCallContent({
        content: "captured",
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
    ).toEqual([
      { type: "text", text: "captured" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ]);
  });

  it("prefers ordered content blocks when present", () => {
    expect(
      buildBridgeToolCallContent({
        content: "legacy text",
        contentBlocks: [
          { type: "image", data: PNG, mimeType: "image/png" },
          { type: "text", text: "after" },
        ],
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
    ).toEqual([
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);
  });

  it("emits a lone text block for a text result", () => {
    expect(buildBridgeToolCallContent({ content: "OK", images: [] })).toEqual([
      { type: "text", text: "OK" },
    ]);
  });

  it("tolerates a result with no images key", () => {
    expect(buildBridgeToolCallContent({ content: "transport closed" })).toEqual(
      [{ type: "text", text: "transport closed" }],
    );
  });
});
