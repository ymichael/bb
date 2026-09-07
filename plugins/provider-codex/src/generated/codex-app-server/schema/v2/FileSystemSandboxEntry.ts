
import type { FileSystemAccessMode } from "./FileSystemAccessMode.js";
import type { FileSystemPath } from "./FileSystemPath.js";

export type FileSystemSandboxEntry = { path: FileSystemPath, access: FileSystemAccessMode, };
