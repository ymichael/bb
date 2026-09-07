
import type { TextRange } from "./TextRange.js";

export type ConfigWarningNotification = {
summary: string,
details: string | null,
path?: string,
range?: TextRange, };
