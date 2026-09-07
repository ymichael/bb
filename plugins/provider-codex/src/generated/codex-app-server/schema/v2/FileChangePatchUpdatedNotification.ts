
import type { FileUpdateChange } from "./FileUpdateChange.js";

export type FileChangePatchUpdatedNotification = { threadId: string, turnId: string, itemId: string, changes: Array<FileUpdateChange>, };
