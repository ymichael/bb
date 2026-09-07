import { PROVIDER_BRIDGE_RECORD_DIR_ENV } from "./bridge-recorder.js";

export function withoutBridgeRuntimeEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv[PROVIDER_BRIDGE_RECORD_DIR_ENV];
  return childEnv;
}
