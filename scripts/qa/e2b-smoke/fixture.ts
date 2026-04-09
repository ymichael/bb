import fs from "node:fs/promises";
import path from "node:path";
import {
  getCloudAuthProviderDefinition,
  type StoredCloudAuthCredential,
} from "../../../packages/agent-provider-auth/src/index.ts";

export const DEFAULT_QA_AUTH_FIXTURE_PATH = "/tmp/bb-oauth-handshakes/credentials.json";
export const E2B_SMOKE_README_PATH = "scripts/qa/e2b-smoke/README.md";

export type SmokeQaAuthProviderId = "claude-code" | "codex";

export interface SmokeQaClaudeFixture {
  access: string;
  expires: number;
  refresh: string;
}

export interface SmokeQaCodexFixture {
  access: string;
  accountId?: string;
  expires: number;
  idToken?: string;
  refresh: string;
}

export interface SmokeQaAuthFixture {
  claude?: SmokeQaClaudeFixture;
  codexRefreshCapable?: boolean;
  createdAt?: string;
  "openai-codex"?: SmokeQaCodexFixture;
}

export interface LoadedSmokeQaAuthFixture {
  fixture: SmokeQaAuthFixture | null;
  fixturePath: string;
  notices: string[];
}

export interface QaAuthCoverageEntry {
  command: string;
  label: string;
  providerId: SmokeQaAuthProviderId;
  status: "available" | "missing";
}

export interface QaAuthCoverageSummary {
  entries: QaAuthCoverageEntry[];
  fixturePath: string;
  hasFullSubscriptionCoverage: boolean;
  hasSubscriptionCoverage: boolean;
}

function createCodexIdToken(email: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ email }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
}

function decodeCodexEmailFromAccessToken(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    );
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const rawProfile = Reflect.get(payload, "https://api.openai.com/profile");
    if (typeof rawProfile !== "object" || rawProfile === null) {
      return null;
    }
    const email = Reflect.get(rawProfile, "email");
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseQaAuthFixture(raw: string): SmokeQaAuthFixture {
  const value = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("Cloud auth fixture must be an object");
  }

  const claude = value.claude;
  if (
    claude !== undefined
    && (
      !isRecord(claude)
      || typeof claude.access !== "string"
      || typeof claude.expires !== "number"
      || typeof claude.refresh !== "string"
    )
  ) {
    throw new Error("Invalid Claude auth fixture");
  }

  const codex = value["openai-codex"];
  if (
    codex !== undefined
    && (
      !isRecord(codex)
      || typeof codex.access !== "string"
      || typeof codex.expires !== "number"
      || typeof codex.refresh !== "string"
      || (codex.accountId !== undefined && typeof codex.accountId !== "string")
      || (codex.idToken !== undefined && typeof codex.idToken !== "string")
    )
  ) {
    throw new Error("Invalid Codex auth fixture");
  }

  const createdAt = value.createdAt;
  if (createdAt !== undefined && typeof createdAt !== "string") {
    throw new Error("Invalid cloud auth fixture createdAt");
  }

  const codexRefreshCapable = value.codexRefreshCapable;
  if (
    codexRefreshCapable !== undefined
    && typeof codexRefreshCapable !== "boolean"
  ) {
    throw new Error("Invalid cloud auth fixture codexRefreshCapable");
  }

  return {
    ...(typeof createdAt === "string" ? { createdAt } : {}),
    ...(typeof codexRefreshCapable === "boolean"
      ? { codexRefreshCapable }
      : {}),
    ...(claude && isRecord(claude)
      ? {
          claude: {
            access: claude.access,
            expires: claude.expires,
            refresh: claude.refresh,
          },
        }
      : {}),
    ...(codex && isRecord(codex)
      ? {
          "openai-codex": {
            access: codex.access,
            ...(typeof codex.accountId === "string"
              ? { accountId: codex.accountId }
              : {}),
            expires: codex.expires,
            ...(typeof codex.idToken === "string"
              ? { idToken: codex.idToken }
              : {}),
            refresh: codex.refresh,
          },
        }
      : {}),
  };
}

async function enrichQaAuthFixture(
  fixture: SmokeQaAuthFixture,
  notices: string[],
): Promise<SmokeQaAuthFixture> {
  let nextFixture: SmokeQaAuthFixture = fixture;

  if (fixture.claude && fixture.claude.expires <= Date.now()) {
    notices.push(
      "Claude fixture is expired; Claude-specific smoke coverage will be skipped until it is refreshed.",
    );
    const { claude: _removedClaude, ...remainingFixture } = nextFixture;
    nextFixture = remainingFixture;
  }

  const codexFixture = nextFixture["openai-codex"];
  if (!codexFixture) {
    return nextFixture;
  }

  try {
    const refreshedCredential = await getCloudAuthProviderDefinition("codex").refreshCredential({
      credential: {
        accessToken: codexFixture.access,
        accountId: codexFixture.accountId ?? null,
        expiresAt: codexFixture.expires,
        idToken: codexFixture.idToken ?? null,
        providerId: "codex",
        refreshToken: codexFixture.refresh,
      },
    });

    if (!refreshedCredential.idToken) {
      throw new Error("Codex credential refresh did not return an idToken");
    }

    return {
      ...nextFixture,
      codexRefreshCapable: true,
      "openai-codex": {
        access: refreshedCredential.accessToken,
        ...(refreshedCredential.accountId
          ? { accountId: refreshedCredential.accountId }
          : {}),
        expires: refreshedCredential.expiresAt,
        idToken: refreshedCredential.idToken,
        refresh: refreshedCredential.refreshToken,
      },
    };
  } catch {
    const email = decodeCodexEmailFromAccessToken(codexFixture.access);
    if (!email) {
      throw new Error(
        "Codex fixture refresh failed and the access token did not contain enough claims to synthesize an idToken for smoke validation",
      );
    }

    notices.push(
      "Codex fixture refresh failed; smoke will synthesize an idToken from access-token claims for validation and skip refresh-specific assertions.",
    );
    return {
      ...nextFixture,
      codexRefreshCapable: false,
      "openai-codex": {
        ...codexFixture,
        idToken: codexFixture.idToken ?? createCodexIdToken(email),
      },
    };
  }
}

async function readQaAuthFixtureFile(
  fixturePath: string,
): Promise<SmokeQaAuthFixture | null> {
  try {
    const raw = await fs.readFile(fixturePath, "utf8");
    return parseQaAuthFixture(raw);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function mapFixtureAliasToProviderId(provider: string): SmokeQaAuthProviderId {
  switch (provider) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
    case "openai-codex":
      return "codex";
    default:
      throw new Error(`Unsupported smoke auth provider "${provider}"`);
  }
}

function buildFixtureFromCredential(
  credential: StoredCloudAuthCredential,
): Partial<SmokeQaAuthFixture> {
  if (credential.providerId === "claude-code") {
    return {
      claude: {
        access: credential.accessToken,
        expires: credential.expiresAt,
        refresh: credential.refreshToken,
      },
    };
  }

  return {
    "openai-codex": {
      access: credential.accessToken,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
      expires: credential.expiresAt,
      ...(credential.idToken ? { idToken: credential.idToken } : {}),
      refresh: credential.refreshToken,
    },
  };
}

export function formatQaAuthHelperCommand(
  providerId: SmokeQaAuthProviderId,
): string {
  return `pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/e2b-smoke/auth-connect.mts --provider ${providerId}`;
}

export function loadSmokeQaProviderId(input: string): SmokeQaAuthProviderId {
  return mapFixtureAliasToProviderId(input);
}

export async function loadQaAuthFixture(): Promise<LoadedSmokeQaAuthFixture> {
  const fixturePath =
    process.env.BB_CLOUD_AUTH_FIXTURE_PATH ?? DEFAULT_QA_AUTH_FIXTURE_PATH;
  const notices: string[] = [];
  const rawFixture = await readQaAuthFixtureFile(fixturePath);
  if (!rawFixture) {
    notices.push(
      `No local cloud-auth fixture was found at ${fixturePath}. Run the helper commands below if you want full Claude/Codex subscription coverage.`,
    );
    return {
      fixture: null,
      fixturePath,
      notices,
    };
  }

  return {
    fixture: await enrichQaAuthFixture(rawFixture, notices),
    fixturePath,
    notices,
  };
}

export async function upsertQaAuthFixtureCredential(
  args: {
    credential: StoredCloudAuthCredential;
    fixturePath?: string;
  },
): Promise<string> {
  const fixturePath = args.fixturePath ?? DEFAULT_QA_AUTH_FIXTURE_PATH;
  const existingFixture = await readQaAuthFixtureFile(fixturePath);
  const nextFixture: SmokeQaAuthFixture = {
    ...(existingFixture ?? {}),
    ...buildFixtureFromCredential(args.credential),
    codexRefreshCapable: undefined,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(
    fixturePath,
    `${JSON.stringify(nextFixture, null, 2)}\n`,
    { mode: 0o600 },
  );
  return fixturePath;
}

export function buildQaAuthCoverageSummary(
  loadedFixture: LoadedSmokeQaAuthFixture,
): QaAuthCoverageSummary {
  const entries: QaAuthCoverageEntry[] = [
    {
      command: formatQaAuthHelperCommand("claude-code"),
      label: "Claude subscription auth",
      providerId: "claude-code",
      status: loadedFixture.fixture?.claude ? "available" : "missing",
    },
    {
      command: formatQaAuthHelperCommand("codex"),
      label: "Codex subscription auth",
      providerId: "codex",
      status: loadedFixture.fixture?.["openai-codex"] ? "available" : "missing",
    },
  ];

  return {
    entries,
    fixturePath: loadedFixture.fixturePath,
    hasFullSubscriptionCoverage: entries.every((entry) => entry.status === "available"),
    hasSubscriptionCoverage: entries.some((entry) => entry.status === "available"),
  };
}

export function renderQaAuthCoverageSummary(
  summary: QaAuthCoverageSummary,
): string[] {
  const lines = [
    `Cloud auth fixture: ${summary.fixturePath}`,
  ];

  for (const entry of summary.entries) {
    if (entry.status === "available") {
      lines.push(`${entry.label}: available`);
      continue;
    }

    lines.push(
      `${entry.label}: missing. Acquire it with: ${entry.command}`,
    );
  }

  lines.push(`Operator guide: ${E2B_SMOKE_README_PATH}`);
  return lines;
}
