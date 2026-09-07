import { describe, expect, it, vi } from "vitest";

import {
  scrollUsedBy,
  usedByScrollState,
  usedByScrollStep,
} from "../src/index";

const FITS = { scrollLeft: 0, scrollWidth: 180, clientWidth: 240 };
const AT_START = { scrollLeft: 0, scrollWidth: 900, clientWidth: 240 };

describe("usedByScrollState", () => {
  it("offers no carets when the items fit", () => {
    expect(usedByScrollState(FITS)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
  });

  it("offers no carets for a row that is exactly full, or over by a rounding error", () => {
    expect(
      usedByScrollState({ scrollLeft: 0, scrollWidth: 240, clientWidth: 240 }),
    ).toEqual({ canScrollLeft: false, canScrollRight: false });
    expect(
      usedByScrollState({
        scrollLeft: 0,
        scrollWidth: 240.5,
        clientWidth: 240,
      }),
    ).toEqual({ canScrollLeft: false, canScrollRight: false });
  });

  it("offers only the right caret at the start", () => {
    expect(usedByScrollState(AT_START)).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
  });

  it("offers both carets in the middle", () => {
    expect(usedByScrollState({ ...AT_START, scrollLeft: 300 })).toEqual({
      canScrollLeft: true,
      canScrollRight: true,
    });
  });

  it("offers only the left caret at the end", () => {
    expect(usedByScrollState({ ...AT_START, scrollLeft: 660 })).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
    expect(usedByScrollState({ ...AT_START, scrollLeft: 659.4 })).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });
});

describe("usedByScrollStep", () => {
  it("pages by roughly one visible width, keeping an overlap", () => {
    expect(usedByScrollStep(240)).toBe(208);
    expect(usedByScrollStep(600)).toBe(568);
  });

  it("still advances usefully in a very narrow row", () => {
    expect(usedByScrollStep(40)).toBe(80);
  });
});

describe("scrollUsedBy", () => {
  it("scrolls the viewport one page in the pressed direction", () => {
    const scrollBy = vi.fn();
    scrollUsedBy({ clientWidth: 240, scrollBy }, 1, { reducedMotion: false });
    expect(scrollBy).toHaveBeenCalledWith({ left: 208, behavior: "smooth" });

    scrollUsedBy({ clientWidth: 240, scrollBy }, -1, { reducedMotion: false });
    expect(scrollBy).toHaveBeenLastCalledWith({
      left: -208,
      behavior: "smooth",
    });
  });

  it("jumps instead of animating when motion is reduced", () => {
    const scrollBy = vi.fn();
    scrollUsedBy({ clientWidth: 240, scrollBy }, 1, { reducedMotion: true });
    expect(scrollBy).toHaveBeenCalledWith({ left: 208, behavior: "auto" });
  });
});
