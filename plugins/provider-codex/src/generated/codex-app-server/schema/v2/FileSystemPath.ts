
import type { LegacyAppPathString } from "../LegacyAppPathString.js";
import type { FileSystemSpecialPath } from "./FileSystemSpecialPath.js";

export type FileSystemPath = { "type": "path", path: LegacyAppPathString, } | { "type": "glob_pattern", pattern: string, } | { "type": "special", value: FileSystemSpecialPath, };
