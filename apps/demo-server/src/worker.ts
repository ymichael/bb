import { DemoStateDO } from "./demo-state.js";

export interface Env {
  DEMO_STATE: DurableObjectNamespace;
}

export { DemoStateDO };

function demoStateName(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.DEMO_STATE.idFromName(demoStateName(request));
    return env.DEMO_STATE.get(id).fetch(request);
  },
};
