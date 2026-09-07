import { z } from "zod";

export const GENERATED_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export const GENERATED_ID_SUFFIX_LENGTH = 10;

const THREAD_ID_PREFIX = "thr_";

export const RAW_THREAD_ID_PATTERN_SOURCE = `${THREAD_ID_PREFIX}[${GENERATED_ID_ALPHABET}]{${GENERATED_ID_SUFFIX_LENGTH}}`;

const rawThreadIdPattern = new RegExp(`^${RAW_THREAD_ID_PATTERN_SOURCE}$`, "u");

export const rawThreadIdSchema = z.string().regex(rawThreadIdPattern);
type RawThreadId = z.infer<typeof rawThreadIdSchema>;

export function isRawThreadId(value: string): value is RawThreadId {
  return rawThreadIdPattern.test(value);
}
