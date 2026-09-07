import { describe, expect, it } from "vitest";
import { toolInputSchema } from "./contracts.js";
import {
  NOT_UNIQUE_MESSAGE,
  TOO_FEW_OPTIONS_MESSAGE,
} from "./tool-definition.js";
import {
  MAX_INTERACTION_PAYLOAD_BYTES,
  PreviewTooLargeError,
  assertInteractionPayloadFits,
  buildInteractionPayload,
  buildInteractionTitle,
  buildToolResult,
  validateToolInput,
} from "./translate.js";

function parseInput(input: unknown) {
  const parsed = toolInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid fixture: ${parsed.error}`);
  return parsed.data;
}

const twoOptions = [
  { label: "Postgres", description: "Relational, needs a server." },
  { label: "SQLite", description: "Embedded, zero setup." },
];

describe("tool input validation", () => {
  it("defaults multiSelect so a model that omits it gets single-select", () => {
    const parsed = parseInput({
      questions: [{ question: "Which DB?", header: "DB", options: twoOptions }],
    });
    expect(parsed.questions[0]?.multiSelect).toBe(false);
  });

  it("accepts a valid call", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            { question: "Which DB?", header: "DB", options: twoOptions },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("steers the model to proceed rather than pad a one-option question", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            { question: "Which DB?", header: "DB", options: [twoOptions[0]] },
          ],
        }),
      ),
    ).toBe(TOO_FEW_OPTIONS_MESSAGE);
  });

  it("rejects duplicate prompts, which would collapse into one answer key", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            { question: "Same?", header: "A", options: twoOptions },
            { question: "Same?", header: "B", options: twoOptions },
          ],
        }),
      ),
    ).toBe(NOT_UNIQUE_MESSAGE);
  });

  it("rejects duplicate option labels within one question", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            {
              question: "Which DB?",
              header: "DB",
              options: [
                { label: "Postgres", description: "Managed." },
                { label: "Postgres", description: "Self-hosted." },
              ],
            },
          ],
        }),
      ),
    ).toBe(NOT_UNIQUE_MESSAGE);
  });
});

describe("buildInteractionPayload", () => {
  it("assigns stable ids, keeps option order, and always allows free text", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
          {
            question: "Which cache?",
            header: "Cache",
            multiSelect: true,
            options: [
              { label: "Redis", description: "In-memory." },
              { label: "None", description: "Skip caching." },
            ],
          },
        ],
      }),
    );

    expect(payload.questions.map((question) => question.id)).toEqual([
      "q0",
      "q1",
    ]);
    expect(payload.questions[0]).toMatchObject({
      prompt: "Which DB?",
      shortLabel: "DB",
      multiSelect: false,
      allowFreeText: true,
    });
    expect(payload.questions[0]?.options.map((option) => option.value)).toEqual(
      ["q0o0", "q0o1"],
    );
    expect(payload.questions[1]?.multiSelect).toBe(true);
    expect(payload.questions[1]?.options[0]?.value).toBe("q1o0");
  });

  it("drops previews on multiSelect questions, which do not support them", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which extras?",
            header: "Extras",
            multiSelect: true,
            options: [
              { label: "Metrics", description: "Prometheus.", preview: "up{}" },
              { label: "Tracing", description: "OTel.", preview: "span" },
            ],
          },
        ],
      }),
    );
    expect(
      payload.questions[0]?.options.map((option) => option.preview),
    ).toEqual([undefined, undefined]);
  });

  it("drops blank previews instead of forwarding empty preview blocks", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which layout?",
            header: "Layout",
            options: [
              { label: "Grid", description: "Cards.", preview: "   \n  " },
              { label: "List", description: "Rows.", preview: "  a | b  " },
            ],
          },
        ],
      }),
    );
    expect(payload.questions[0]?.options[0]?.preview).toBeUndefined();
    expect(payload.questions[0]?.options[1]?.preview).toBe("a | b");
  });
});

describe("assertInteractionPayloadFits", () => {
  it("rejects a payload whose previews would blow the interaction limit", () => {
    const preview = "x".repeat(4096);
    const questions = Array.from({ length: 4 }, (_unused, index) => ({
      question: `Question ${index}?`,
      header: `Q${index}`,
      options: Array.from({ length: 4 }, (_option, optionIndex) => ({
        label: `Option ${optionIndex}`,
        description: "Detail.",
        preview,
      })),
    }));
    const payload = buildInteractionPayload(parseInput({ questions }));

    expect(() => assertInteractionPayloadFits(payload)).toThrow(
      PreviewTooLargeError,
    );
  });

  it("accepts a realistic payload", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which DB?",
            header: "DB",
            options: [
              {
                label: "Postgres",
                description: "Server.",
                preview: "x".repeat(2000),
              },
              { label: "SQLite", description: "Embedded." },
            ],
          },
        ],
      }),
    );
    expect(() => assertInteractionPayloadFits(payload)).not.toThrow();
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).length,
    ).toBeLessThan(MAX_INTERACTION_PAYLOAD_BYTES);
  });
});

describe("buildInteractionTitle", () => {
  it("uses the header for one question and a count for several", () => {
    const single = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "Database", options: twoOptions },
        ],
      }),
    );
    expect(buildInteractionTitle(single)).toBe("Database");

    const multiple = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
          { question: "Which cache?", header: "Cache", options: twoOptions },
        ],
      }),
    );
    expect(buildInteractionTitle(multiple)).toBe("2 questions");
  });
});

describe("buildToolResult", () => {
  const payload = buildInteractionPayload(
    parseInput({
      questions: [
        {
          question: "Which DB?",
          header: "DB",
          options: [
            {
              label: "Postgres",
              description: "Server.",
              preview: "CREATE TABLE t();",
            },
            { label: "SQLite", description: "Embedded." },
          ],
        },
        {
          question: "Which extras?",
          header: "Extras",
          multiSelect: true,
          options: [
            { label: "Metrics", description: "Prometheus." },
            { label: "Tracing", description: "OTel." },
          ],
        },
      ],
    }),
  );

  it("keys answers by question text, matching the native Claude result", () => {
    const result = buildToolResult(payload, {
      answers: {
        q0: { selected: ["q0o1"] },
        q1: { selected: ["q1o0", "q1o1"] },
      },
    });

    expect(result.answers).toEqual({
      "Which DB?": "SQLite",
      "Which extras?": "Metrics, Tracing",
    });
    expect(result.annotations).toBeUndefined();
    expect(result.questions[0]).toEqual({
      question: "Which DB?",
      header: "DB",
      multiSelect: false,
      options: [
        {
          label: "Postgres",
          description: "Server.",
          preview: "CREATE TABLE t();",
        },
        { label: "SQLite", description: "Embedded." },
      ],
    });
  });

  it("appends free text after a selection and records it as a note", () => {
    const result = buildToolResult(payload, {
      answers: {
        q0: { selected: ["q0o0"], freeText: "but shard it" },
        q1: { selected: [] },
      },
    });

    expect(result.answers["Which DB?"]).toBe("Postgres; but shard it");
    expect(result.annotations?.["Which DB?"]).toEqual({
      preview: "CREATE TABLE t();",
      notes: "but shard it",
    });
    expect(result.answers).not.toHaveProperty("Which extras?");
  });

  it("returns free text alone as the whole answer, with no redundant note", () => {
    const result = buildToolResult(payload, {
      answers: {
        q0: { selected: [], freeText: "DuckDB" },
        q1: { selected: [] },
      },
    });

    expect(result.answers["Which DB?"]).toBe("DuckDB");
    expect(result.annotations).toBeUndefined();
    expect(result.response).toBeUndefined();
  });

  it("sets `response` when a lone question is answered with free text only", () => {
    const single = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
        ],
      }),
    );
    const result = buildToolResult(single, {
      answers: { q0: { selected: [], freeText: "DuckDB" } },
    });

    expect(result.response).toBe("DuckDB");
    expect(result.answers["Which DB?"]).toBe("DuckDB");
  });

  it("ignores selections that do not match any option value", () => {
    const result = buildToolResult(payload, {
      answers: { q0: { selected: ["bogus"] }, q1: { selected: ["q1o1"] } },
    });

    expect(result.answers).not.toHaveProperty("Which DB?");
    expect(result.answers["Which extras?"]).toBe("Tracing");
  });
});
