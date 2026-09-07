// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { InteractionPayload, InteractionResponse } from "./src/contracts";

const app = await loadPluginApp(() => import("./app"));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

const singleSelect: InteractionPayload = {
  questions: [
    {
      id: "q0",
      prompt: "Which database should we use?",
      shortLabel: "Database",
      multiSelect: false,
      allowFreeText: true,
      options: [
        {
          value: "q0o0",
          label: "Postgres",
          description: "Relational, needs a server.",
          preview: "CREATE TABLE users (id uuid primary key);",
        },
        {
          value: "q0o1",
          label: "SQLite",
          description: "Embedded, zero setup.",
        },
      ],
    },
  ],
};

function render(
  payload: InteractionPayload,
  handlers: {
    submit?: (value: unknown) => Promise<void>;
    cancel?: () => Promise<void>;
  } = {},
) {
  return renderSlot(app.pendingInteractions[0]!, {
    interaction: {
      id: "pint_test",
      threadId: "thr_test",
      title: "Database",
      payload: payload as never,
      createdAt: 0,
      expiresAt: null,
    },
    submit: handlers.submit ?? (async () => undefined),
    cancel: handlers.cancel ?? (async () => undefined),
  });
}

function getButtonByText(
  slot: ReturnType<typeof render>,
  text: string,
): HTMLButtonElement {
  const button = slot.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${text} is not rendered inside a button`);
  }
  return button;
}

describe("answering a single-select question", () => {
  it("submits the selected option value", () => {
    const submit = vi.fn(async () => undefined);
    const slot = render(singleSelect, { submit });

    expect(slot.getAllByText("Which database should we use?")).toHaveLength(2);
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit answer"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    } satisfies InteractionResponse);
  });

  it("blocks submission until something is chosen", () => {
    const slot = render(singleSelect);
    const submitButton = getButtonByText(slot, "Submit answer");

    expect(submitButton.disabled).toBe(true);
    fireEvent.click(getButtonByText(slot, "Postgres"));
    expect(submitButton.disabled).toBe(false);
  });

  it("reveals an option preview only while that option is selected", () => {
    const slot = render(singleSelect);
    const preview = "CREATE TABLE users (id uuid primary key);";

    expect(slot.queryByText(preview)).toBeNull();
    fireEvent.click(getButtonByText(slot, "Postgres"));
    expect(slot.getByText(preview)).toBeTruthy();

    fireEvent.click(getButtonByText(slot, "SQLite"));
    expect(slot.queryByText(preview)).toBeNull();
  });

  it("makes 'Other' and a real option mutually exclusive", () => {
    const submit = vi.fn(async () => undefined);
    const slot = render(singleSelect, { submit });

    fireEvent.click(getButtonByText(slot, "Postgres"));
    fireEvent.click(getButtonByText(slot, "Other…"));
    const textarea = slot.getByLabelText("Database answer");
    fireEvent.change(textarea, { target: { value: "DuckDB" } });
    fireEvent.click(getButtonByText(slot, "Submit answer"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: [], freeText: "DuckDB" } },
    } satisfies InteractionResponse);
  });

  it("selects an option with its number-key shortcut", () => {
    const submit = vi.fn(async () => undefined);
    const slot = render(singleSelect, { submit });

    fireEvent.keyDown(window, { key: "2" });
    fireEvent.click(getButtonByText(slot, "Submit answer"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    } satisfies InteractionResponse);
  });

  it("ignores number keys typed into the free-text box", () => {
    const slot = render(singleSelect);
    fireEvent.click(getButtonByText(slot, "Other…"));
    const textarea = slot.getByLabelText("Database answer");

    fireEvent.keyDown(textarea, { key: "1" });

    expect(getButtonByText(slot, "Postgres").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("multi-select and multi-question flows", () => {
  const multi: InteractionPayload = {
    questions: [
      {
        id: "q0",
        prompt: "Which extras?",
        shortLabel: "Extras",
        multiSelect: true,
        allowFreeText: true,
        options: [
          { value: "q0o0", label: "Metrics", description: "Prometheus." },
          { value: "q0o1", label: "Tracing", description: "OTel." },
        ],
      },
      {
        id: "q1",
        prompt: "Which database?",
        shortLabel: "Database",
        multiSelect: false,
        allowFreeText: true,
        options: [
          { value: "q1o0", label: "Postgres", description: "Server." },
          { value: "q1o1", label: "SQLite", description: "Embedded." },
        ],
      },
    ],
  };

  it("keeps several options selected and walks both questions before submitting", () => {
    const submit = vi.fn(async () => undefined);
    const slot = render(multi, { submit });

    expect(slot.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(getButtonByText(slot, "Metrics"));
    fireEvent.click(getButtonByText(slot, "Tracing"));
    fireEvent.click(getButtonByText(slot, "Next"));

    expect(slot.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(getButtonByText(slot, "Postgres"));
    fireEvent.click(getButtonByText(slot, "Submit answer"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: {
        q0: { selected: ["q0o0", "q0o1"] },
        q1: { selected: ["q1o0"] },
      },
    } satisfies InteractionResponse);
  });

  it("cancels the request instead of submitting", () => {
    const cancel = vi.fn(async () => undefined);
    const slot = render(multi, { cancel });

    fireEvent.click(getButtonByText(slot, "Cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("a payload the form cannot read", () => {
  it("offers a cancel escape rather than blocking the composer", () => {
    const cancel = vi.fn(async () => undefined);
    const slot = renderSlot(app.pendingInteractions[0]!, {
      interaction: {
        id: "pint_test",
        threadId: "thr_test",
        title: "Database",
        payload: { questions: "not an array" } as never,
        createdAt: 0,
        expiresAt: null,
      },
      submit: async () => undefined,
      cancel,
    });

    expect(
      slot.getByText("This question could not be displayed."),
    ).toBeTruthy();
    fireEvent.click(getButtonByText(slot, "Cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
