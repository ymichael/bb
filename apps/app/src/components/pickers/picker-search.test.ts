import { describe, expect, it } from "vitest";
import { searchPickerOptions } from "./picker-search";

interface TestOption {
  label: string;
  aliases: readonly string[];
}

const getLabel = (option: TestOption) => option.label;
const getAliases = (option: TestOption) => option.aliases;

describe("searchPickerOptions", () => {
  it("matches case-insensitive character sequences in visible labels", () => {
    const options = [
      { label: "Alpha Web", aliases: [] },
      { label: "Charlie Docs", aliases: [] },
      { label: "feature/three", aliases: [] },
    ];

    expect(
      searchPickerOptions({ options, query: "AW", getLabel, getAliases }),
    ).toEqual([options[0]]);
    expect(
      searchPickerOptions({ options, query: "cd", getLabel, getAliases }),
    ).toEqual([options[1]]);
    expect(
      searchPickerOptions({ options, query: "fth", getLabel, getAliases }),
    ).toEqual([options[2]]);
  });

  it("lets option types augment visible labels with aliases", () => {
    const options = [
      {
        label: "Codex Parent",
        aliases: ["thr_codex_parent"],
      },
      {
        label: "Frontend Parent",
        aliases: ["thr_frontend_parent"],
      },
    ];

    expect(
      searchPickerOptions({
        options,
        query: "frontend_parent",
        getLabel,
        getAliases,
      }),
    ).toEqual([options[1]]);
    expect(
      searchPickerOptions({ options, query: "cdxp", getLabel, getAliases }),
    ).toEqual([options[0]]);
  });

  it("ranks visible-label matches ahead of alias-only matches", () => {
    const nemotron = {
      label: "NVIDIA: Nemotron 3 Ultra",
      aliases: ["openrouter/nvidia/nemotron-3-ultra-550b-a55b"],
    };
    const gpt = {
      label: "GPT-5.5",
      aliases: ["openai/gpt-5.5"],
    };

    expect(
      searchPickerOptions({
        options: [nemotron, gpt],
        query: "55",
        getLabel,
        getAliases,
      }),
    ).toEqual([gpt, nemotron]);
  });

  it("ranks stronger matches first and preserves source order for ties", () => {
    const exact = { label: "gpt4", aliases: [] };
    const direct = { label: "GPT-4 Turbo", aliases: [] };
    const loose = { label: "Super GPT-4 Compatibility", aliases: [] };
    const duplicateA = { label: "Alpha Web", aliases: ["first"] };
    const duplicateB = { label: "Alpha Web", aliases: ["second"] };

    expect(
      searchPickerOptions({
        options: [loose, direct, exact],
        query: "gpt4",
        getLabel,
        getAliases,
      }),
    ).toEqual([exact, direct, loose]);
    expect(
      searchPickerOptions({
        options: [duplicateA, duplicateB],
        query: "aw",
        getLabel,
        getAliases,
      }),
    ).toEqual([duplicateA, duplicateB]);
  });

  it("treats punctuation literally and returns source order for blank queries", () => {
    const options = [
      { label: "5.2", aliases: [] },
      { label: "512", aliases: [] },
    ];

    expect(
      searchPickerOptions({ options, query: "5.2", getLabel, getAliases }),
    ).toEqual([options[0]]);
    expect(
      searchPickerOptions({ options, query: "  ", getLabel, getAliases }),
    ).toBe(options);
  });
});
