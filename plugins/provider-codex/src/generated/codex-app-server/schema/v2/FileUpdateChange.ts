
import type { PatchChangeKind } from "./PatchChangeKind.js";

export type FileUpdateChange = { path: string, kind: PatchChangeKind, diff: string, };
