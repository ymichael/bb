import { describe, expect, it } from "vitest";
import { buildDynamicTools } from "../tool-proxy.js";

describe("tool-proxy", () => {
  it("preserves required and optional scalar fields", () => {
    const [tool] = buildDynamicTools(
      [
        {
          name: "lookup",
          description: "Lookup a record",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              verbose: { type: "boolean" },
            },
            required: ["id"],
          },
        },
      ],
      async () => ({ content: "ok" }),
    );

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        verbose: { type: "boolean" },
      },
      required: ["id"],
    });
  });

  it("converts nested objects, arrays, and enums recursively", () => {
    const [tool] = buildDynamicTools(
      [
        {
          name: "complex",
          description: "Complex schema",
          inputSchema: {
            type: "object",
            properties: {
              filters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    operator: { enum: ["eq", "ne"] },
                  },
                  required: ["field", "operator"],
                },
              },
              settings: {
                type: "object",
                properties: {
                  mode: { enum: ["fast", "accurate"] },
                  retries: { type: "integer" },
                },
                required: ["mode"],
              },
            },
            required: ["filters"],
          },
        },
      ],
      async () => ({ content: "ok" }),
    );

    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["filters"],
      properties: {
        filters: {
          type: "array",
          items: {
            type: "object",
            required: ["field", "operator"],
            properties: {
              field: { type: "string" },
              operator: {
                anyOf: [{ const: "eq", type: "string" }, { const: "ne", type: "string" }],
              },
            },
          },
        },
        settings: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: {
              anyOf: [
                { const: "fast", type: "string" },
                { const: "accurate", type: "string" },
              ],
            },
            retries: { type: "number" },
          },
        },
      },
    });
  });
});
