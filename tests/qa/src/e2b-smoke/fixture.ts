import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getCloudAuthProviderDefinition,
  type StoredCloudAuthCredential,
} from "@bb/agent-provider-auth";

export const DEFAULT_QA_AUTH_FIXTURE_PATH = "/tmp/bb-oauth-handshakes/credentials.json";
export const E2B_SMOKE_README_PATH = "tests/qa/src/e2b-smoke/README.md";

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

const smokeQaClaudeFixtureSchema = z.object({
  access: z.string(),
  expires: z.number(),
  refresh: z.string(),
});

const smokeQaCodexFixtureSchema = z.object({
  access: z.string(),
  accountId: z.string().optional(),
  expires: z.number(),
  idToken: z.string().optional(),
  refresh: z.string(),
});

const smokeQaAuthFixtureSchema = z.object({
  claude: smokeQaClaudeFixtureSchema.optional(),
  createdAt: z.string().optional(),
  "openai-codex": smokeQaCodexFixtureSchema.optional(),
});

function parseQaAuthFixture(raw: string): SmokeQaAuthFixture {
  return smokeQaAuthFixtureSchema.parse(JSON.parse(raw));
}

function serializeQaAuthFixture(fixture: SmokeQaAuthFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function writeQaAuthFixtureFile(
  args: {
    fixture: SmokeQaAuthFixture;
    fixturePath: string;
  },
): Promise<void> {
  await fs.mkdir(path.dirname(args.fixturePath), { recursive: true });
  await fs.writeFile(
    args.fixturePath,
    serializeQaAuthFixture(args.fixture),
    { mode: 0o600 },
  );
}

async function enrichQaAuthFixture(
  fixture: SmokeQaAuthFixture,
  notices: string[],
): Promise<SmokeQaAuthFixture> {
  let nextFixture: SmokeQaAuthFixture = fixture;

  if (fixture.claude) {
    try {
      const refreshedCredential = await getCloudAuthProviderDefinition("claude-code").refreshCredential({
        credential: {
          accessToken: fixture.claude.access,
          accountEmail: null,
          accountId: null,
          expiresAt: fixture.claude.expires,
          providerId: "claude-code",
          refreshToken: fixture.claude.refresh,
          scopes: [],
          subscriptionType: null,
        },
      });
      nextFixture = {
        ...nextFixture,
        ...buildFixtureFromCredential(refreshedCredential),
      };
    } catch {
      throw new Error(
        "Claude fixture refresh failed; reacquire it with the auth-connect helper.",
      );
    }
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
    throw new Error(
      "Codex fixture refresh failed; reacquire it with the auth-connect helper.",
    );
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
  return `pnpm --filter @bb/qa auth:e2b-smoke --provider ${providerId}`;
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

  const enrichedFixture = await enrichQaAuthFixture(rawFixture, notices);
  if (serializeQaAuthFixture(enrichedFixture) !== serializeQaAuthFixture(rawFixture)) {
    await writeQaAuthFixtureFile({
      fixture: enrichedFixture,
      fixturePath,
    });
  }

  return {
    fixture: enrichedFixture,
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
    createdAt: new Date().toISOString(),
  };

  await writeQaAuthFixtureFile({
    fixture: nextFixture,
    fixturePath,
  });
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
