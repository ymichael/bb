import { describe, expect, it } from "vitest";

import { stringifySiteSearch } from "./search-serialization.js";

describe("stringifySiteSearch", () => {
  it("writes one plain category parameter and omits a missing one", () => {
    expect(
      stringifySiteSearch({
        category: "thread-content",
        sort: "recently-added",
      }),
    ).toBe("?sort=recently-added&category=thread-content");
    expect(stringifySiteSearch({ category: undefined })).toBe("");
  });
});
