
import type { AbsolutePathBuf } from "../AbsolutePathBuf.js";
import type { GitInfo } from "./GitInfo.js";
import type { SessionSource } from "./SessionSource.js";
import type { ThreadSection } from "./ThreadSection.js";
import type { ThreadSource } from "./ThreadSource.js";
import type { ThreadStatus } from "./ThreadStatus.js";
import type { Turn } from "./Turn.js";

export type Thread = {

id: string,

sessionId: string,

forkedFromId: string | null,

parentThreadId: string | null,

preview: string,

ephemeral: boolean,

section: ThreadSection | null,

sectionEnteredAt: number | null,

projectId: string | null,

modelProvider: string,

createdAt: number,

updatedAt: number,

recencyAt: number | null,

status: ThreadStatus,

path: string | null,

cwd: AbsolutePathBuf,

cliVersion: string,

source: SessionSource,

threadSource: ThreadSource | null,

agentNickname: string | null,

agentRole: string | null,

gitInfo: GitInfo | null,

name: string | null,

turns: Array<Turn>};
