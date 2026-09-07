import { describe, expect, it } from "vitest";
import {
  parsePluginAgentToolPresentation,
  PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS,
} from "../internal/host-policy.js";

describe("parsePluginAgentToolPresentation", () => {
  const maxLabel = "x".repeat(PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS);

  it.each([
    { name: "absent", value: undefined, expected: null },
    { name: "empty object", value: {}, expected: {} },
    {
      name: "labels at the cap, untrimmed",
      value: { label: { pending: maxLabel, completed: " done " } },
      expected: { label: { pending: maxLabel, completed: " done " } },
    },
    {
      name: "every field",
      value: {
        label: { pending: "Running", completed: "Ran" },
        icon: { glyph: "Workflow" },
        suppress: true,
        tint: { light: "#111111", dark: "#eeeeee" },
      },
      expected: {
        label: { pending: "Running", completed: "Ran" },
        icon: { glyph: "Workflow" },
        suppress: true,
        tint: { light: "#111111", dark: "#eeeeee" },
      },
    },
    {
      name: "undeclared fields are dropped",
      value: {
        icon: { glyph: "Workflow", size: 24 },
        label: { pending: "Running", completed: "Ran", failed: "Failed" },
        extra: "<script>",
      },
      expected: {
        icon: { glyph: "Workflow" },
        label: { pending: "Running", completed: "Ran" },
      },
    },
  ])("accepts $name", ({ value, expected }) => {
    const parsed = parsePluginAgentToolPresentation("tool_x", value);
    expect(parsed).toEqual(expected);
    if (value !== undefined) {
      expect(parsed).not.toBe(value);
    }
  });

  const labelMessage = `tool "tool_x" presentation.label strings must be non-empty and at most ${PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS} characters`;

  it.each([
    {
      name: "a string",
      value: "Workflow",
      message: 'tool "tool_x" presentation must be an object',
    },
    {
      name: "null",
      value: null,
      message: 'tool "tool_x" presentation must be an object',
    },
    {
      name: "an array",
      value: [],
      message: 'tool "tool_x" presentation must be an object',
    },
    {
      name: "a label missing completed",
      value: { label: { pending: "Running" } },
      message:
        'tool "tool_x" presentation.label must provide pending and completed strings',
    },
    {
      name: "a label given as a string",
      value: { label: "Running" },
      message:
        'tool "tool_x" presentation.label must provide pending and completed strings',
    },
    {
      name: "a label one character over the cap",
      value: { label: { pending: `${maxLabel}x`, completed: "Ran" } },
      message: labelMessage,
    },
    {
      name: "an empty label",
      value: { label: { pending: "", completed: "Ran" } },
      message: labelMessage,
    },
    {
      name: "a blank label",
      value: { label: { pending: "Running", completed: "   " } },
      message: labelMessage,
    },
    {
      name: "an icon given as a glyph name",
      value: { icon: "Workflow" },
      message: 'tool "tool_x" presentation.icon must be { glyph: string }',
    },
    {
      name: "an icon with a blank glyph",
      value: { icon: { glyph: " " } },
      message: 'tool "tool_x" presentation.icon must be { glyph: string }',
    },
    {
      name: "a non-boolean suppress",
      value: { suppress: "yes" },
      message: 'tool "tool_x" presentation.suppress must be a boolean',
    },
    {
      name: "a tint missing dark",
      value: { tint: { light: "#111111" } },
      message:
        'tool "tool_x" presentation.tint must provide light and dark strings',
    },
  ])("rejects $name", ({ value, message }) => {
    expect(() => parsePluginAgentToolPresentation("tool_x", value)).toThrow(
      message,
    );
  });
});
