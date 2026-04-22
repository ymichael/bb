export const detailScrollSizeValues = ["regular", "large"] as const;
export type DetailScrollSize = (typeof detailScrollSizeValues)[number];

const DETAIL_SCROLL_MAX_HEIGHT_CLASS_BY_SIZE: Record<DetailScrollSize, string> =
  {
    regular: "max-h-[220px]",
    large: "max-h-[320px]",
  };

export function getDetailScrollMaxHeightClass(
  size: DetailScrollSize,
): string {
  return DETAIL_SCROLL_MAX_HEIGHT_CLASS_BY_SIZE[size];
}
