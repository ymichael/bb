
import type { CommandExecOutputStream } from "./CommandExecOutputStream.js";

export type CommandExecOutputDeltaNotification = {
processId: string,
stream: CommandExecOutputStream,
deltaBase64: string,
capReached: boolean, };
