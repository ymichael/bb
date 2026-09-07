
import type { LegacyAppPathString } from "../LegacyAppPathString.js";
import type { FileSystemSandboxEntry } from "./FileSystemSandboxEntry.js";

export type AdditionalFileSystemPermissions = {
read: Array<LegacyAppPathString> | null,
write: Array<LegacyAppPathString> | null, globScanMaxDepth?: number, entries?: Array<FileSystemSandboxEntry>, };
