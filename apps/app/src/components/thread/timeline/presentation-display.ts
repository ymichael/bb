import type { CSSProperties } from "react";
import { isPresentationTintColor } from "@bb/domain";
import type { TimelineRowPresentation } from "@bb/server-contract";
import { ICON_NAMES, type IconName } from "@bb/shared-ui/icon";

const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES);

export function isIconName(value: string): value is IconName {
  return ICON_NAME_SET.has(value);
}

export function presentationIconName(
  presentation: { icon: TimelineRowPresentation["icon"] } | undefined,
): IconName | undefined {
  const glyph = presentation?.icon.glyph;
  return glyph !== undefined && isIconName(glyph) ? glyph : undefined;
}

export function presentationTintStyle(
  presentation:
    | { tint?: TimelineRowPresentation["tint"] | null | undefined }
    | undefined,
): CSSProperties | undefined {
  const tint = presentation?.tint;
  if (
    tint === undefined ||
    tint === null ||
    !isPresentationTintColor(tint.light) ||
    !isPresentationTintColor(tint.dark)
  ) {
    return undefined;
  }
  return { color: `light-dark(${tint.light.trim()}, ${tint.dark.trim()})` };
}
