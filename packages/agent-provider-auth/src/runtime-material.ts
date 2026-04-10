import {
  getCloudAuthProvider,
  type CloudAuthRuntimeConsumer,
} from "@bb/agent-providers";
import type { HostRuntimeMaterialManagedFile } from "@bb/host-daemon-contract";
import type {
  ClaudeStoredCredential,
  CodexStoredCredential,
} from "./provider-definitions.js";
import type { CloudAuthResolvedCredential } from "./types.js";

const CLAUDE_CREDENTIALS_PATH = "~/.claude/.credentials.json";
const CODEX_AUTH_PATH = "~/.codex/auth.json";
const PI_AGENT_DIR = "~/.pi/agent";
const PI_AUTH_PATH = `${PI_AGENT_DIR}/auth.json`;
const RUNTIME_MATERIAL_FILE_MODE = 0o600;
const RUNTIME_MATERIAL_MANAGED_BY = "bb-runtime-material";

export interface BuildCloudAuthRuntimeMaterialResult {
  env: Record<string, string>;
  files: HostRuntimeMaterialManagedFile[];
}

interface BuildCloudAuthRuntimeMaterialArgs {
  credentials: CloudAuthResolvedCredential[];
}

interface ClaudeCredentialsFile {
  claudeAiOauth: {
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    scopes: string[];
    subscriptionType: ClaudeStoredCredential["subscriptionType"];
  };
}

interface CodexAuthFile {
  OPENAI_API_KEY: null;
  auth_mode: "chatgpt";
  last_refresh: string;
  tokens: {
    access_token: string;
    account_id?: string;
    id_token?: string;
    refresh_token: string;
  };
}

interface PiOAuthCredential {
  access: string;
  accountId?: string;
  expires: number;
  refresh: string;
  type: "oauth";
}

type PiAuthFile = Record<string, PiOAuthCredential>;

type ClaudeResolvedCredential = CloudAuthResolvedCredential<ClaudeStoredCredential>;
type CodexResolvedCredential = CloudAuthResolvedCredential<CodexStoredCredential>;

interface RuntimeMaterialAccumulator {
  env: Record<string, string>;
  files: HostRuntimeMaterialManagedFile[];
  piAuthFile: PiAuthFile;
}

interface RuntimeConsumerDispatchArgs {
  accumulator: RuntimeMaterialAccumulator;
  authConsumerId: CloudAuthRuntimeConsumer["authConsumerId"];
  credential: CloudAuthResolvedCredential;
  runtimeProviderId: CloudAuthRuntimeConsumer["runtimeProviderId"];
}

function stringifyJsonFile(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildManagedFile(args: {
  contents: string;
  path: string;
}): HostRuntimeMaterialManagedFile {
  return {
    contents: args.contents,
    managedBy: RUNTIME_MATERIAL_MANAGED_BY,
    mode: RUNTIME_MATERIAL_FILE_MODE,
    path: args.path,
  };
}

function isClaudeResolvedCredential(
  credential: CloudAuthResolvedCredential,
): credential is ClaudeResolvedCredential {
  return credential.providerId === "claude-code";
}

function isCodexResolvedCredential(
  credential: CloudAuthResolvedCredential,
): credential is CodexResolvedCredential {
  return credential.providerId === "codex";
}

function buildClaudeCredentialsFile(
  resolved: ClaudeResolvedCredential,
): HostRuntimeMaterialManagedFile {
  const contents: ClaudeCredentialsFile = {
    claudeAiOauth: {
      accessToken: resolved.credential.accessToken,
      expiresAt: resolved.credential.expiresAt,
      // Sandboxes receive access-only snapshots; only the server refreshes.
      refreshToken: "",
      scopes: resolved.credential.scopes,
      subscriptionType: resolved.credential.subscriptionType,
    },
  };

  return buildManagedFile({
    contents: stringifyJsonFile(contents),
    path: CLAUDE_CREDENTIALS_PATH,
  });
}

function buildCodexAuthFile(
  resolved: CodexResolvedCredential,
): HostRuntimeMaterialManagedFile {
  const contents: CodexAuthFile = {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: new Date(
      resolved.lastRefreshedAt ?? resolved.credential.expiresAt,
    ).toISOString(),
    tokens: {
      access_token: resolved.credential.accessToken,
      ...(resolved.credential.accountId
        ? { account_id: resolved.credential.accountId }
        : {}),
      ...(resolved.credential.idToken
        ? { id_token: resolved.credential.idToken }
        : {}),
      // Sandboxes receive access-only snapshots; only the server refreshes.
      refresh_token: "",
    },
  };

  return buildManagedFile({
    contents: stringifyJsonFile(contents),
    path: CODEX_AUTH_PATH,
  });
}

function buildPiAuthFile(args: {
  contents: PiAuthFile;
}): HostRuntimeMaterialManagedFile | null {
  if (Object.keys(args.contents).length === 0) {
    return null;
  }

  return buildManagedFile({
    contents: stringifyJsonFile(args.contents),
    path: PI_AUTH_PATH,
  });
}

function appendClaudePiCredential(
  accumulator: RuntimeMaterialAccumulator,
  credential: ClaudeResolvedCredential,
): void {
  accumulator.env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
  accumulator.piAuthFile.anthropic = {
    access: credential.credential.accessToken,
    expires: credential.credential.expiresAt,
    // Pi receives access-only snapshots; only the server refreshes.
    refresh: "",
    type: "oauth",
  };
}

function appendCodexPiCredential(
  accumulator: RuntimeMaterialAccumulator,
  credential: CodexResolvedCredential,
): void {
  accumulator.env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
  accumulator.piAuthFile["openai-codex"] = {
    access: credential.credential.accessToken,
    ...(credential.credential.accountId
      ? { accountId: credential.credential.accountId }
      : {}),
    expires: credential.credential.expiresAt,
    // Pi receives access-only snapshots; only the server refreshes.
    refresh: "",
    type: "oauth",
  };
}

function appendRuntimeConsumerMaterial(
  args: RuntimeConsumerDispatchArgs,
): void {
  switch (args.runtimeProviderId) {
    case "claude-code":
      if (args.authConsumerId !== "claude-code" || !isClaudeResolvedCredential(args.credential)) {
        throw new Error(
          `Runtime consumer ${args.runtimeProviderId}/${args.authConsumerId} requires a Claude credential`,
        );
      }
      args.accumulator.files.push(buildClaudeCredentialsFile(args.credential));
      return;
    case "codex":
      if (args.authConsumerId !== "codex" || !isCodexResolvedCredential(args.credential)) {
        throw new Error(
          `Runtime consumer ${args.runtimeProviderId}/${args.authConsumerId} requires a Codex credential`,
        );
      }
      args.accumulator.files.push(buildCodexAuthFile(args.credential));
      return;
    case "pi":
      switch (args.authConsumerId) {
        case "anthropic":
          if (!isClaudeResolvedCredential(args.credential)) {
            throw new Error(
              `Runtime consumer ${args.runtimeProviderId}/${args.authConsumerId} requires a Claude credential`,
            );
          }
          appendClaudePiCredential(args.accumulator, args.credential);
          return;
        case "openai-codex":
          if (!isCodexResolvedCredential(args.credential)) {
            throw new Error(
              `Runtime consumer ${args.runtimeProviderId}/${args.authConsumerId} requires a Codex credential`,
            );
          }
          appendCodexPiCredential(args.accumulator, args.credential);
          return;
        default:
          throw new Error(
            `Unsupported cloud auth runtime consumer ${args.runtimeProviderId}/${args.authConsumerId}`,
          );
      }
    default:
      args.runtimeProviderId satisfies never;
      throw new Error(
        `Unsupported cloud auth runtime provider ${args.runtimeProviderId}`,
      );
  }
}

export function buildCloudAuthRuntimeMaterial(
  args: BuildCloudAuthRuntimeMaterialArgs,
): BuildCloudAuthRuntimeMaterialResult {
  const accumulator: RuntimeMaterialAccumulator = {
    env: {},
    files: [],
    piAuthFile: {},
  };

  for (const credential of args.credentials) {
    for (const consumer of getCloudAuthProvider(credential.providerId).runtimeConsumers) {
      appendRuntimeConsumerMaterial({
        accumulator,
        authConsumerId: consumer.authConsumerId,
        credential,
        runtimeProviderId: consumer.runtimeProviderId,
      });
    }
  }

  const piAuthFile = buildPiAuthFile({
    contents: accumulator.piAuthFile,
  });
  if (piAuthFile) {
    accumulator.files.push(piAuthFile);
  }

  return {
    env: accumulator.env,
    files: accumulator.files,
  };
}
