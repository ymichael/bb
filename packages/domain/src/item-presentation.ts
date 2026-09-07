import { z } from "zod";

export const THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH = 280;

export const threadEventItemPresentationLabelSchema = z.object({
  pending: z.string().min(1),
  completed: z.string().min(1),
});
export type ThreadEventItemPresentationLabel = z.infer<
  typeof threadEventItemPresentationLabelSchema
>;

export const threadEventItemPresentationIconSchema = z.object({
  glyph: z.string().min(1),
});
export type ThreadEventItemPresentationIcon = z.infer<
  typeof threadEventItemPresentationIconSchema
>;

export const threadEventItemPresentationTintSchema = z.object({
  light: z.string().min(1),
  dark: z.string().min(1),
});
export type ThreadEventItemPresentationTint = z.infer<
  typeof threadEventItemPresentationTintSchema
>;

const PRESENTATION_TINT_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([-+.%\w\s,/]*\)|[a-z]{3,20})$/iu;

export function isPresentationTintColor(value: string): boolean {
  return PRESENTATION_TINT_COLOR_PATTERN.test(value.trim());
}

export const THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH = 80;

export const threadEventItemPresentationBadgeSchema = z.object({
  glyph: z.string().min(1),
  label: z
    .string()
    .min(1)
    .max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  hint: z
    .string()
    .min(1)
    .max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  tone: z.enum(["neutral", "destructive"]),
});
export type ThreadEventItemPresentationBadge = z.infer<
  typeof threadEventItemPresentationBadgeSchema
>;

export const threadEventItemPresentationSchema = z.object({
  label: threadEventItemPresentationLabelSchema,
  icon: threadEventItemPresentationIconSchema,
  title: z.string().optional(),
  detail: z
    .string()
    .max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH)
    .optional(),
  suppress: z.boolean().optional(),
  tint: threadEventItemPresentationTintSchema.optional(),
  badge: threadEventItemPresentationBadgeSchema.optional(),
});
export type ThreadEventItemPresentation = z.infer<
  typeof threadEventItemPresentationSchema
>;
