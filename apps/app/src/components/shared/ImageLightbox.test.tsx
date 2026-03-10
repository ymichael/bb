import { describe, expect, it } from "vitest"
import { getWrappedImageIndex } from "./ImageLightbox"

describe("ImageLightbox", () => {
  it("wraps image navigation in both directions", () => {
    expect(
      getWrappedImageIndex({
        currentIndex: 0,
        direction: "previous",
        itemCount: 3,
      })
    ).toBe(2)

    expect(
      getWrappedImageIndex({
        currentIndex: 2,
        direction: "next",
        itemCount: 3,
      })
    ).toBe(0)
  })

  it("leaves the index unchanged when there are no images to navigate", () => {
    expect(
      getWrappedImageIndex({
        currentIndex: 1,
        direction: "next",
        itemCount: 0,
      })
    ).toBe(1)
  })
})
