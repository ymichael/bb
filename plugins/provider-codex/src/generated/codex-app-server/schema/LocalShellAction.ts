
import type { LocalShellExecAction } from "./LocalShellExecAction.js";

export type LocalShellAction = { "type": "exec" } & LocalShellExecAction;
