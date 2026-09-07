import { z } from "zod";

export const SETTING_DESCRIPTORS = {
  tokenId: {
    type: "string",
    label: "Modal token id",
    description:
      "The token id half of a Modal API token (modal token new writes one to ~/.modal.toml).",
  },
  tokenSecret: {
    type: "string",
    label: "Modal token secret",
    secret: true,
    description: "The token secret half of the same Modal API token.",
  },
  serverUrl: {
    type: "string",
    label: "bb server URL (optional)",
    description:
      "Only for a tunnel you run yourself. Leave blank to use bb connect: this bb's own https://<handle>.getbb.app apex, which sandboxes reach without a login. Set it to a tunnel URL if this bb is not paired with bb connect. The server's own loopback address is not reachable from Modal, and a bb connect port share is not either — it sits behind connect's browser login.",
  },
  appName: {
    type: "string",
    label: "Modal app name",
    description: "The Modal app the sandboxes are created in.",
    default: "bb-sandboxes",
  },
  image: {
    type: "string",
    label: "Container image",
    description:
      "Registry tag for the sandbox image. It needs Node 22 or newer, npm, git and curl.",
    default: "node:22-bookworm",
  },
  environmentVariables: {
    type: "string",
    label: "Sandbox environment variables (optional)",
    secret: true,
    description:
      "A JSON object of environment variables injected into each sandbox. For Codex, set OPENAI_API_KEY or CODEX_ACCESS_TOKEN so the plugin can authenticate the installed CLI.",
  },
  timeoutMinutes: {
    type: "string",
    label: "Sandbox lifetime (minutes)",
    description:
      "Modal terminates the sandbox after this long. Between 1 and 1440.",
    default: "60",
  },
  idleMinutes: {
    type: "string",
    label: "Hibernate after idle (minutes)",
    description:
      "Snapshot and stop an idle sandbox after this long. Use 0 to keep it running until Modal's lifetime limit.",
    default: "15",
  },
  cpu: {
    type: "string",
    label: "CPU cores",
    description:
      "Reserved physical cores, fractional allowed. Blank for Modal's default.",
    default: "",
  },
  memoryMiB: {
    type: "string",
    label: "Memory (MiB)",
    description: "Reserved memory in MiB. Blank for Modal's default.",
    default: "",
  },
} as const;

export interface ResolvedSettings {
  tokenId: string;
  tokenSecret: string;
  serverUrl: string | null;
  appName: string;
  image: string;
  environmentVariables: Readonly<Record<string, string>>;
  timeoutMs: number;
  idleMs: number | null;
  cpu: number | null;
  memoryMiB: number | null;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

export interface RawSettings {
  tokenId: string | undefined;
  tokenSecret: string | undefined;
  serverUrl: string | undefined;
  appName: string;
  image: string;
  environmentVariables: string | undefined;
  timeoutMinutes: string;
  idleMinutes: string;
  cpu: string;
  memoryMiB: string;
}

const MAX_TIMEOUT_MINUTES = 24 * 60;
const MAX_IDLE_MINUTES = 24 * 60;
const MAX_ENVIRONMENT_VARIABLES = 64;
const environmentVariablesSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  z.string(),
);

function parseEnvironmentVariables(
  raw: string | undefined,
):
  | { ok: true; value: Readonly<Record<string, string>> }
  | { ok: false; message: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  let parsed: z.infer<typeof environmentVariablesSchema>;
  try {
    parsed = environmentVariablesSchema.parse(JSON.parse(trimmed));
  } catch {
    return {
      ok: false,
      message:
        "Modal sandbox environmentVariables must be a JSON object whose keys are environment variable names and whose values are strings.",
    };
  }
  if (Object.keys(parsed).length > MAX_ENVIRONMENT_VARIABLES) {
    return {
      ok: false,
      message: `Modal sandbox environmentVariables may contain at most ${MAX_ENVIRONMENT_VARIABLES} entries.`,
    };
  }
  return { ok: true, value: parsed };
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  const tokenId = (raw.tokenId ?? "").trim();
  const tokenSecret = (raw.tokenSecret ?? "").trim();
  const serverUrl = (raw.serverUrl ?? "").trim().replace(/\/+$/u, "");
  const missing: string[] = [];
  if (tokenId.length === 0) missing.push("tokenId");
  if (tokenSecret.length === 0) missing.push("tokenSecret");
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Modal sandbox is not configured: set ${missing.join(", ")} in the plugin's settings.`,
    };
  }
  if (serverUrl.length > 0 && !/^https?:\/\//u.test(serverUrl)) {
    return {
      ok: false,
      message: `Modal sandbox serverUrl must be an http(s) URL the sandbox can reach, not ${serverUrl}.`,
    };
  }
  const appName = raw.appName.trim();
  if (appName.length === 0) {
    return { ok: false, message: "Modal sandbox appName must not be blank." };
  }
  const image = raw.image.trim();
  if (image.length === 0) {
    return { ok: false, message: "Modal sandbox image must not be blank." };
  }
  const environmentVariables = parseEnvironmentVariables(
    raw.environmentVariables,
  );
  if (!environmentVariables.ok) return environmentVariables;
  const timeoutMinutes = Number(raw.timeoutMinutes.trim());
  if (
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < 1 ||
    timeoutMinutes > MAX_TIMEOUT_MINUTES
  ) {
    return {
      ok: false,
      message: `Modal sandbox timeoutMinutes must be a whole number between 1 and ${MAX_TIMEOUT_MINUTES}, not ${raw.timeoutMinutes}.`,
    };
  }
  const cpu = parseNumber(raw.cpu);
  if (cpu !== null && Number.isNaN(cpu)) {
    return {
      ok: false,
      message: `Modal sandbox cpu must be a positive number or blank, not ${raw.cpu}.`,
    };
  }
  const memoryMiB = parseNumber(raw.memoryMiB);
  if (memoryMiB !== null && Number.isNaN(memoryMiB)) {
    return {
      ok: false,
      message: `Modal sandbox memoryMiB must be a positive number or blank, not ${raw.memoryMiB}.`,
    };
  }
  const idleMinutes = Number(raw.idleMinutes.trim());
  if (
    !Number.isInteger(idleMinutes) ||
    idleMinutes < 0 ||
    idleMinutes > MAX_IDLE_MINUTES
  ) {
    return {
      ok: false,
      message: `Modal sandbox idleMinutes must be a whole number between 0 and ${MAX_IDLE_MINUTES}, not ${raw.idleMinutes}.`,
    };
  }
  return {
    ok: true,
    settings: {
      tokenId,
      tokenSecret,
      serverUrl: serverUrl.length === 0 ? null : serverUrl,
      appName,
      image,
      environmentVariables: environmentVariables.value,
      timeoutMs: timeoutMinutes * 60_000,
      idleMs: idleMinutes === 0 ? null : idleMinutes * 60_000,
      cpu,
      memoryMiB,
    },
  };
}
