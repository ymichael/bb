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
      resolved.lastRefreshedAt ?? resolved.updatedAt,
    ).toISOString(),
    tokens: {
      access_token: resolved.credential.accessToken,
      ...(resolved.credential.accountId
        ? { account_id: resolved.credential.accountId }
        : {}),
      ...(resolved.credential.idToken
        ? { id_token: resolved.credential.idToken }
        : {}),
      refresh_token: "",
    },
  };

  return buildManagedFile({
    contents: stringifyJsonFile(contents),
    path: CODEX_AUTH_PATH,
  });
}

function buildPiAuthFile(args: {
  claudeCredential: ClaudeResolvedCredential | null;
  codexCredential: CodexResolvedCredential | null;
}): HostRuntimeMaterialManagedFile | null {
  const contents: PiAuthFile = {};

  if (args.claudeCredential) {
    contents.anthropic = {
      access: args.claudeCredential.credential.accessToken,
      expires: args.claudeCredential.credential.expiresAt,
      refresh: "",
      type: "oauth",
    };
  }

  if (args.codexCredential) {
    contents["openai-codex"] = {
      access: args.codexCredential.credential.accessToken,
      ...(args.codexCredential.credential.accountId
        ? { accountId: args.codexCredential.credential.accountId }
        : {}),
      expires: args.codexCredential.credential.expiresAt,
      refresh: "",
      type: "oauth",
    };
  }

  if (Object.keys(contents).length === 0) {
    return null;
  }

  return buildManagedFile({
    contents: stringifyJsonFile(contents),
    path: PI_AUTH_PATH,
  });
}

export function buildCloudAuthRuntimeMaterial(
  args: BuildCloudAuthRuntimeMaterialArgs,
): BuildCloudAuthRuntimeMaterialResult {
  const claudeCredential = args.credentials.find(isClaudeResolvedCredential) ?? null;
  const codexCredential = args.credentials.find(isCodexResolvedCredential) ?? null;

  const files: HostRuntimeMaterialManagedFile[] = [];
  const env: Record<string, string> = {};

  if (claudeCredential) {
    files.push(buildClaudeCredentialsFile(claudeCredential));
  }

  if (codexCredential) {
    files.push(buildCodexAuthFile(codexCredential));
  }

  const piAuthFile = buildPiAuthFile({
    claudeCredential,
    codexCredential,
  });
  if (piAuthFile) {
    env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
    files.push(piAuthFile);
  }

  return {
    env,
    files,
  };
}
