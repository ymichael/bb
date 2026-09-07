
import type { ProcessOutputStream } from "./ProcessOutputStream.js";

export type ProcessOutputDeltaNotification = {
processHandle: string,
stream: ProcessOutputStream,
deltaBase64: string,
capReached: boolean, };
