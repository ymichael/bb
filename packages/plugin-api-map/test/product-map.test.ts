import { describe, expect, it } from "vitest";

import { annotationNeighbors, panCarets, SURFACE_GROUPS } from "../src/index";

const LAST = SURFACE_GROUPS.length - 1;

describe("panCarets", () => {
  it("disables the caret that has nowhere to go", () => {
    expect(panCarets(0, SURFACE_GROUPS.length)).toEqual({
      previous: false,
      next: true,
    });
    expect(panCarets(LAST, SURFACE_GROUPS.length)).toEqual({
      previous: true,
      next: false,
    });
  });

  it("enables both carets everywhere in between", () => {
    for (let index = 1; index < LAST; index++) {
      expect(panCarets(index, SURFACE_GROUPS.length), `slide ${index}`).toEqual(
        {
          previous: true,
          next: true,
        },
      );
    }
  });

  it("disables both carets when there is a single slide", () => {
    expect(panCarets(0, 1)).toEqual({ previous: false, next: false });
  });
});

describe("annotationNeighbors", () => {
  const surfaces = SURFACE_GROUPS[0]!.surfaces;

  it("moves through annotations in their authored numeric order", () => {
    expect(annotationNeighbors(surfaces, surfaces[1]!.id)).toEqual({
      previous: surfaces[0],
      next: surfaces[2],
    });
  });

  it("keeps the missing direction disabled at each endpoint", () => {
    expect(annotationNeighbors(surfaces, surfaces[0]!.id)).toEqual({
      previous: null,
      next: surfaces[1],
    });
    expect(annotationNeighbors(surfaces, surfaces.at(-1)!.id)).toEqual({
      previous: surfaces.at(-2),
      next: null,
    });
  });
});
