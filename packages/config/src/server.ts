import { envsafe, port, str } from "envsafe";
import { join } from "node:path";
import { commonConfig } from "./common.js";

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
  BB_SERVER_PORT: port({
    desc: "HTTP port for the server",
    default: 3000,
    devDefault: 3000,
  }),
  BB_DATABASE_URL: str({
    desc: "SQLite database path. Defaults to $BB_DATA_DIR/bb.db",
    default: join(commonConfig.BB_DATA_DIR, "bb.db"),
  }),
  BB_E2B_API_KEY: str({
    desc: "E2B API key for ephemeral sandbox provisioning (optional)",
    default: "",
    allowEmpty: true,
  }),
  BB_E2B_TEMPLATE: str({
    desc: "E2B sandbox template ID (optional)",
    default: "",
    allowEmpty: true,
  }),
  BB_INFERENCE_MODEL: str({
    desc: "Inference model used for server-side completions in provider/model format",
    default: "openai/gpt-4o-mini",
    devDefault: "openai/gpt-4o-mini",
  }),
  OPENAI_API_KEY: str({
    desc: "OpenAI API key used for voice transcription and OpenAI-backed inference",
  }),
});

export const serverConfig = {
  ...rawServerConfig,
  BB_INFERENCE_MODEL: validateInferenceModel(rawServerConfig.BB_INFERENCE_MODEL),
};
