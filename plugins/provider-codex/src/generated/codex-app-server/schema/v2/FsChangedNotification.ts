
import type { AbsolutePathBuf } from "../AbsolutePathBuf.js";

export type FsChangedNotification = {
watchId: string,
changedPaths: Array<AbsolutePathBuf>, };
