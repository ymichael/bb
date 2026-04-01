import { envsafe, port, str } from "envsafe";
import { join } from "node:path";
import { commonConfig } from "./common.js";
import { DEFAULTS } from "./defaults.js";
import { resolveDevPublicUrl, validateRequiredUrl } from "./public-url.js";

export { commonConfig };

function validateInferenceModel(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value)) {
    return value;
  }
  throw new Error(
    `BB_INFERENCE_MODEL must use provider/model format, received "${value}"`,
  );
}

const rawServerConfig = envsafe({
  BB_HOST_DAEMON_PORT: port({
    desc: "Port the host daemon listens on for local API requests",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
  BB_SERVER_PORT: port({
    desc: "HTTP port for the server",
    default: DEFAULTS.serverPort.prod,
    devDefault: DEFAULTS.serverPort.dev,
  }),
  BB_DATABASE_URL: str({
    desc: "SQLite database path. Defaults to $BB_DATA_DIR/bb.db",
    default: join(commonConfig.BB_DATA_DIR, "bb.db"),
  }),
  BB_PUBLIC_URL: str({
    desc: "Public URL sandboxes can use to reach the server",
    devDefault: resolveDevPublicUrl(),
  }),
  E2B_API_KEY: str({
    desc: "E2B API key for ephemeral sandbox provisioning (optional)",
    default: "",
    allowEmpty: true,
  }),
  E2B_TEMPLATE: str({
    desc: "E2B sandbox template ID (optional)",
    default: "",
    allowEmpty: true,
  }),
  BB_GITHUB_PAT: str({
    desc: "GitHub personal access token used for authenticated repo clones in sandboxes",
    default: "",
    allowEmpty: true,
  }),
  BB_INFERENCE_MODEL: str({
    desc: "Inference model used for server-side completions in provider/model format",
    default: DEFAULTS.inferenceModel,
    devDefault: DEFAULTS.inferenceModel,
  }),
  OPENAI_API_KEY: str({
    desc: "OpenAI API key used for voice transcription and OpenAI-backed inference (optional)",
    default: "",
    allowEmpty: true,
    devDefault: "",
  }),
});

export const serverConfig = {
  ...rawServerConfig,
  BB_PUBLIC_URL: validateRequiredUrl("BB_PUBLIC_URL", rawServerConfig.BB_PUBLIC_URL),
  BB_INFERENCE_MODEL: validateInferenceModel(rawServerConfig.BB_INFERENCE_MODEL),
};
