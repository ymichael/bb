import { describe, expect, it } from "vitest";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
  RAW_THREAD_ID_PATTERN_SOURCE,
  clientTurnRequestIdSchema,
  encodeClientTurnRequestIdAlphabetIndexes,
  encodeClientTurnRequestIdNumber,
  formatClientTurnRequestIdSuffix,
  isRawThreadId,
  rawThreadIdSchema,
} from "../src/index.js";

describe("protocol id schemas", () => {
  it("accepts prefixed client request ids", () => {
    expect(clientTurnRequestIdSchema.safeParse("creq_23456789ab").success).toBe(
      true,
    );
  });

  it("rejects unprefixed or short ids", () => {
    expect(clientTurnRequestIdSchema.safeParse("creq_23456789").success).toBe(
      false,
    );
  });

  it("formats and encodes client turn request ids with the shared alphabet", () => {
    expect(formatClientTurnRequestIdSuffix({ suffix: "23456789ab" })).toBe(
      "creq_23456789ab",
    );
    expect(encodeClientTurnRequestIdNumber({ value: 1 })).toBe(
      "creq_2222222223",
    );
    expect(
      encodeClientTurnRequestIdAlphabetIndexes({
        indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      }),
    ).toBe("creq_23456789ab");
  });

  it("rejects invalid client turn request id helper input", () => {
    expect(() => formatClientTurnRequestIdSuffix({ suffix: "bad" })).toThrow();
    expect(() => encodeClientTurnRequestIdNumber({ value: -1 })).toThrow();
    expect(() =>
      encodeClientTurnRequestIdAlphabetIndexes({ indexes: [0] }),
    ).toThrow();
    expect(() =>
      encodeClientTurnRequestIdAlphabetIndexes({
        indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 99],
      }),
    ).toThrow();
  });

  it("recognizes exactly the currently generated prefixed thread IDs", () => {
    expect(GENERATED_ID_ALPHABET).toBe("23456789abcdefghijkmnpqrstuvwxyz");
    expect(GENERATED_ID_SUFFIX_LENGTH).toBe(10);
    expect(RAW_THREAD_ID_PATTERN_SOURCE).toBe(
      "thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}",
    );
    expect(isRawThreadId("thr_23456789ab")).toBe(true);
    expect(rawThreadIdSchema.parse("thr_zyxwvutsrq")).toBe("thr_zyxwvutsrq");

    for (const invalid of [
      "23456789ab",
      "thr_23456789a",
      "thr_23456789abc",
      "thr_0123456789",
      "proj_23456789ab",
      "THR_23456789ab",
    ]) {
      expect(isRawThreadId(invalid), invalid).toBe(false);
      expect(rawThreadIdSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it("does not broaden raw-thread matching to legacy unprefixed NanoIDs", () => {
    expect(isRawThreadId("dcwivn5n8w")).toBe(false);
    expect(rawThreadIdSchema.safeParse("dcwivn5n8w").success).toBe(false);
  });
});
