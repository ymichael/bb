import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  accountSchema,
  accountSecretSchema,
  hubTokenSummarySchema,
  providerSchema,
  quotaSchema,
  type Account,
  type AccountQuota,
  type AccountSecret,
  type HubTokenSummary,
  type PoolProvider,
} from "./contracts.js";

const ACCOUNTS_KEY = "accounts:v1";
const ACCOUNT_LAST_USED_PERSIST_MS = 60 * 1_000;
const accountsSchema = z.array(accountSchema);
const HUB_TOKEN_PREFIX = "hub-token-";
const HUB_TOKEN_GRACE_MS = 10 * 60 * 1_000;
const HUB_TOKEN_LAST_USED_PERSIST_MS = 60 * 1_000;

const tokenValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const priorHubTokenSchema = z
  .object({
    value: tokenValueSchema,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const storedHubTokenSchema = z
  .object({
    hostId: z.string().min(1),
    value: tokenValueSchema,
    mintedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
    previous: z.array(priorHubTokenSchema),
  })
  .strict();
type StoredHubToken = z.infer<typeof storedHubTokenSchema>;

const routedThreadSchema = z
  .object({
    hostId: z.string().min(1),
    routedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RoutedThread = z.infer<typeof routedThreadSchema> & {
  threadId: string;
};

export class AccountStore {
  private mutationLock: Promise<void> | null = null;

  constructor(
    private readonly kv: PluginKvStorage,
    private readonly secretsDir: string,
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.secretsDir, 0o700);
  }

  async list(): Promise<Account[]> {
    const value = await this.kv.get(ACCOUNTS_KEY);
    if (value === undefined) return [];
    return accountsSchema.parse(value);
  }

  async get(id: string): Promise<Account | null> {
    return (await this.list()).find((account) => account.id === id) ?? null;
  }

  async add(
    input: Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId">,
    secret: AccountSecret,
  ): Promise<Account> {
    return this.serialized(async () => {
      const account = accountSchema.parse({
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
        lastUsedAt: null,
        lastUsedHostId: null,
      });
      await this.writeSecret(account.id, secret);
      try {
        const accounts = await this.list();
        accounts.push(account);
        await this.kv.set(ACCOUNTS_KEY, accounts);
      } catch (error) {
        await fs.rm(this.accountSecretPath(account.id), { force: true });
        throw error;
      }
      return account;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const next = accounts.filter((account) => account.id !== id);
      if (next.length === accounts.length) return false;
      await this.kv.set(ACCOUNTS_KEY, next);
      await fs.rm(this.accountSecretPath(id), { force: true });
      return true;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account | null> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      if (index < 0) return null;
      const current = accounts[index];
      if (current === undefined) return null;
      const updated = accountSchema.parse({ ...current, enabled });
      accounts[index] = updated;
      await this.kv.set(ACCOUNTS_KEY, accounts);
      return updated;
    });
  }

  async setPriority(id: string, priority: number): Promise<Account | null> {
    return this.update(id, (account) => ({ ...account, priority }));
  }

  async reorder(provider: PoolProvider, accountIds: string[]): Promise<void> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const current = accounts.filter(
        (account) => account.provider === provider,
      );
      const positions = new Map(accountIds.map((id, index) => [id, index]));
      if (
        positions.size !== accountIds.length ||
        current.length !== positions.size ||
        current.some((account) => !positions.has(account.id))
      ) {
        throw new Error(
          "Include every account for this provider exactly once. Refresh the account list and try again.",
        );
      }
      await this.kv.set(
        ACCOUNTS_KEY,
        accounts.map((account) => {
          const position = positions.get(account.id);
          return position === undefined
            ? account
            : { ...account, priority: position + 1 };
        }),
      );
    });
  }

  async recordUsed(
    id: string,
    lastUsedAt: number,
    lastUsedHostId: string,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      const current = accounts[index];
      if (index < 0 || current === undefined) return false;
      if (
        current.lastUsedAt !== null &&
        current.lastUsedHostId === lastUsedHostId &&
        lastUsedAt - current.lastUsedAt < ACCOUNT_LAST_USED_PERSIST_MS
      ) {
        return false;
      }
      accounts[index] = accountSchema.parse({
        ...current,
        lastUsedAt,
        lastUsedHostId,
      });
      await this.kv.set(ACCOUNTS_KEY, accounts);
      return true;
    });
  }

  async setAccountUuid(
    id: string,
    accountUuid: string,
  ): Promise<Account | null> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      if (index < 0) return null;
      const current = accounts[index];
      if (current === undefined) return null;
      const updated = accountSchema.parse({ ...current, accountUuid });
      accounts[index] = updated;
      await this.kv.set(ACCOUNTS_KEY, accounts);
      return updated;
    });
  }

  private async update(
    id: string,
    change: (account: Account) => Account,
  ): Promise<Account | null> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      const current = accounts[index];
      if (index < 0 || current === undefined) return null;
      const updated = accountSchema.parse(change(current));
      accounts[index] = updated;
      await this.kv.set(ACCOUNTS_KEY, accounts);
      return updated;
    });
  }

  async readSecret(id: string): Promise<AccountSecret> {
    const parsed = JSON.parse(
      await fs.readFile(this.accountSecretPath(id), "utf8"),
    );
    return accountSecretSchema.parse(parsed);
  }

  async writeSecret(id: string, secret: AccountSecret): Promise<void> {
    await this.initialize();
    const value = `${JSON.stringify(accountSecretSchema.parse(secret))}\n`;
    const destination = this.accountSecretPath(id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  }

  private accountSecretPath(id: string): string {
    z.string().uuid().parse(id);
    return path.join(this.secretsDir, `account-${id}.json`);
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationLock ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationLock = tail;
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.mutationLock === tail) this.mutationLock = null;
    }
  }
}

export class HubTokenStore {
  private readonly hostLocks = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, StoredHubToken>();
  private readonly persistedLastUsedAt = new Map<string, number | null>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly secretsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    this.initialization ??= this.load();
    await this.initialization;
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.secretsDir, 0o700);
    await fs.rm(path.join(this.secretsDir, "hub-key"), { force: true });
    const names = await fs.readdir(this.secretsDir);
    for (const name of names) {
      if (!name.startsWith(HUB_TOKEN_PREFIX) || !name.endsWith(".json"))
        continue;
      const token = storedHubTokenSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.secretsDir, name), "utf8")),
      );
      this.tokens.set(token.hostId, token);
      this.persistedLastUsedAt.set(token.hostId, token.lastUsedAt);
    }
  }

  async forHost(hostId: string): Promise<string> {
    await this.initialize();
    return this.serialized(hostId, async () => {
      const existing = this.read(hostId);
      if (existing !== null) return existing.value;
      const created = this.create(hostId);
      await this.write(hostId, created);
      return created.value;
    });
  }

  async rotate(hostId: string): Promise<HubTokenSummary> {
    await this.initialize();
    return this.serialized(hostId, async () => {
      const current = this.read(hostId);
      const now = this.now();
      const next = this.create(hostId);
      if (current !== null) {
        next.previous = [
          { value: current.value, expiresAt: now + HUB_TOKEN_GRACE_MS },
          ...current.previous.filter((token) => token.expiresAt > now),
        ];
      }
      await this.write(hostId, next);
      return this.summary(next);
    });
  }

  async authenticate(presented: string | null): Promise<string | null> {
    if (presented === null) return null;
    await this.initialize();
    const now = this.now();
    let matchedHostId: string | null = null;
    for (const token of this.readAll()) {
      if (matchesStoredToken(token, presented, now))
        matchedHostId = token.hostId;
    }
    if (matchedHostId === null) return null;
    return this.serialized(matchedHostId, async () => {
      const matched = this.read(matchedHostId);
      if (
        matched === null ||
        !matchesStoredToken(matched, presented, this.now())
      )
        return null;
      const usedAt = this.now();
      const next = storedHubTokenSchema.parse({
        ...matched,
        lastUsedAt: usedAt,
        previous: matched.previous.filter((token) => token.expiresAt > usedAt),
      });
      const persistedAt = this.persistedLastUsedAt.get(matched.hostId) ?? null;
      if (
        persistedAt === null ||
        usedAt - persistedAt >= HUB_TOKEN_LAST_USED_PERSIST_MS
      ) {
        await this.write(matched.hostId, next);
      } else {
        this.tokens.set(matched.hostId, next);
      }
      return matched.hostId;
    });
  }

  async list(): Promise<HubTokenSummary[]> {
    await this.initialize();
    return this.readAll()
      .map((token) => this.summary(token))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  async prune(hostIds: readonly string[]): Promise<void> {
    await this.initialize();
    const enrolled = new Set(hostIds);
    const stale = [...this.tokens.keys()].filter(
      (hostId) => !enrolled.has(hostId),
    );
    await Promise.all(
      stale.map((hostId) =>
        this.serialized(hostId, async () => {
          await fs.rm(this.tokenPath(hostId), { force: true });
          this.tokens.delete(hostId);
          this.persistedLastUsedAt.delete(hostId);
        }),
      ),
    );
  }

  private create(hostId: string): StoredHubToken {
    return storedHubTokenSchema.parse({
      hostId,
      value: randomBytes(32).toString("base64url"),
      mintedAt: this.now(),
      lastUsedAt: null,
      previous: [],
    });
  }

  private summary(token: StoredHubToken): HubTokenSummary {
    return hubTokenSummarySchema.parse({
      hostId: token.hostId,
      hostName: null,
      mintedAt: token.mintedAt,
      lastUsedAt: token.lastUsedAt,
    });
  }

  private read(hostId: string): StoredHubToken | null {
    const token = this.tokens.get(hostId);
    if (token === undefined) return null;
    const previous = token.previous.filter(
      (candidate) => candidate.expiresAt > this.now(),
    );
    if (previous.length === token.previous.length) return token;
    const pruned = storedHubTokenSchema.parse({ ...token, previous });
    this.tokens.set(hostId, pruned);
    return pruned;
  }

  private readAll(): StoredHubToken[] {
    return [...this.tokens.keys()].flatMap((hostId) => {
      const token = this.read(hostId);
      return token === null ? [] : [token];
    });
  }

  private async write(hostId: string, token: StoredHubToken): Promise<void> {
    await this.initialize();
    const destination = this.tokenPath(hostId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await this.writeFile(temporary, token);
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
    this.tokens.set(hostId, token);
    this.persistedLastUsedAt.set(hostId, token.lastUsedAt);
  }

  private async writeFile(file: string, token: StoredHubToken): Promise<void> {
    await fs.writeFile(
      file,
      `${JSON.stringify(storedHubTokenSchema.parse(token))}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }

  private tokenPath(hostId: string): string {
    const safeHostId = z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .parse(hostId);
    return path.join(this.secretsDir, `${HUB_TOKEN_PREFIX}${safeHostId}.json`);
  }

  private async serialized<T>(
    hostId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.hostLocks.get(hostId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.hostLocks.set(hostId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.hostLocks.get(hostId) === tail) this.hostLocks.delete(hostId);
    }
  }
}

function matchesStoredToken(
  token: StoredHubToken,
  presented: string,
  now: number,
): boolean {
  const currentMatches = safeTokenEqual(presented, token.value);
  let previousMatches = false;
  for (const previous of token.previous) {
    const equal = safeTokenEqual(presented, previous.value);
    if (previous.expiresAt > now && equal) previousMatches = true;
  }
  return currentMatches || previousMatches;
}

export class RoutingStore {
  constructor(
    private readonly kv: PluginKvStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async isBypassed(threadId: string): Promise<boolean> {
    return (await this.kv.get(this.bypassKey(threadId))) === true;
  }

  async isProviderEnabled(provider: "claude" | "codex"): Promise<boolean> {
    return (await this.kv.get(`routing.${provider}`)) !== false;
  }

  async setProviderEnabled(
    provider: "claude" | "codex",
    enabled: boolean,
  ): Promise<void> {
    await this.kv.set(`routing.${provider}`, enabled);
  }

  async setBypassed(threadId: string, bypassed: boolean): Promise<void> {
    if (bypassed) await this.kv.set(this.bypassKey(threadId), true);
    else await this.kv.delete(this.bypassKey(threadId));
  }

  async recordRouted(threadId: string, hostId: string): Promise<void> {
    await this.kv.set(this.routedKey(threadId), {
      hostId,
      routedAt: this.now(),
    });
  }

  async listRoutedSince(cutoff: number): Promise<RoutedThread[]> {
    const routed: RoutedThread[] = [];
    for (const key of await this.kv.list("routed:")) {
      const value = routedThreadSchema.parse(await this.kv.get(key));
      if (value.routedAt < cutoff) {
        await this.kv.delete(key);
        continue;
      }
      routed.push({ threadId: key.slice("routed:".length), ...value });
    }
    return routed;
  }

  private bypassKey(threadId: string): string {
    return `bypass:${z.string().min(1).parse(threadId)}`;
  }

  private routedKey(threadId: string): string {
    return `routed:${z.string().min(1).parse(threadId)}`;
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

const quotaRowSchema = z
  .object({
    account_id: z.string().uuid(),
    five_hour_utilization: z.number().nullable(),
    five_hour_reset_at: z.number().int().nullable(),
    five_hour_status: z.string().nullable(),
    seven_day_utilization: z.number().nullable(),
    seven_day_reset_at: z.number().int().nullable(),
    seven_day_status: z.string().nullable(),
    representative_claim: z.string().nullable(),
    bucket_exhaustion_json: z.string(),
    family_weekly_json: z.string(),
    limit_windows_json: z.string(),
    observed_at: z.number().int().nullable(),
    held_until: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .strict();

const EMPTY_QUOTA = {
  fiveHourUtilization: null,
  fiveHourResetAt: null,
  fiveHourStatus: null,
  sevenDayUtilization: null,
  sevenDayResetAt: null,
  sevenDayStatus: null,
  representativeClaim: null,
  familyWeekly: {
    fable: null,
    sonnet: null,
    opus: null,
    haiku: null,
    other: null,
  },
  limitWindows: [],
  observedAt: null,
  heldUntil: null,
  error: null,
};

export class QuotaStore {
  constructor(private readonly db: Database.Database) {}

  get(accountId: string): AccountQuota {
    const row = quotaRowSchema
      .optional()
      .parse(
        this.db
          .prepare("SELECT * FROM account_quota WHERE account_id = ?")
          .get(accountId),
      );
    if (row === undefined) {
      return quotaSchema.parse({ accountId, ...EMPTY_QUOTA });
    }
    return quotaSchema.parse({
      accountId: row.account_id,
      fiveHourUtilization: row.five_hour_utilization,
      fiveHourResetAt: row.five_hour_reset_at,
      fiveHourStatus: row.five_hour_status,
      sevenDayUtilization: row.seven_day_utilization,
      sevenDayResetAt: row.seven_day_reset_at,
      sevenDayStatus: row.seven_day_status,
      representativeClaim: row.representative_claim,
      familyWeekly: JSON.parse(row.family_weekly_json),
      limitWindows: JSON.parse(row.limit_windows_json),
      observedAt: row.observed_at,
      heldUntil: row.held_until,
      error: row.error,
    });
  }

  put(quota: AccountQuota): void {
    const value = quotaSchema.parse(quota);
    this.db
      .prepare(
        `INSERT INTO account_quota (
          account_id, five_hour_utilization, five_hour_reset_at,
          five_hour_status, seven_day_utilization, seven_day_reset_at,
          seven_day_status, representative_claim, bucket_exhaustion_json,
          family_weekly_json, limit_windows_json, observed_at, held_until, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          five_hour_utilization = excluded.five_hour_utilization,
          five_hour_reset_at = excluded.five_hour_reset_at,
          five_hour_status = excluded.five_hour_status,
          seven_day_utilization = excluded.seven_day_utilization,
          seven_day_reset_at = excluded.seven_day_reset_at,
          seven_day_status = excluded.seven_day_status,
          representative_claim = excluded.representative_claim,
          family_weekly_json = excluded.family_weekly_json,
          limit_windows_json = excluded.limit_windows_json,
          observed_at = excluded.observed_at,
          held_until = excluded.held_until,
          error = excluded.error`,
      )
      .run(
        value.accountId,
        value.fiveHourUtilization,
        value.fiveHourResetAt,
        value.fiveHourStatus,
        value.sevenDayUtilization,
        value.sevenDayResetAt,
        value.sevenDayStatus,
        value.representativeClaim,
        JSON.stringify(value.familyWeekly),
        JSON.stringify(value.limitWindows),
        value.observedAt,
        value.heldUntil,
        value.error,
      );
  }

  remove(accountId: string): void {
    this.db
      .prepare("DELETE FROM account_quota WHERE account_id = ?")
      .run(accountId);
  }
}

const affinityRowSchema = z.object({
  affinity_key: z.string(),
  account_id: z.string().uuid(),
  last_used_at: z.number().int(),
});

const activeAccountRowSchema = z.object({
  provider: providerSchema,
  account_id: z.string().uuid(),
});

export interface AccountBinding {
  accountId: string;
  lastUsedAt: number;
}

export class PoolAffinityStore {
  constructor(private readonly db: Database.Database) {}

  loadBindings(since: number, limit: number): Map<string, AccountBinding> {
    this.db
      .prepare("DELETE FROM pool_affinity WHERE last_used_at <= ?")
      .run(since);
    this.db
      .prepare(
        `DELETE FROM pool_affinity WHERE affinity_key NOT IN (
        SELECT affinity_key FROM pool_affinity ORDER BY last_used_at DESC, rowid DESC LIMIT ?
      )`,
      )
      .run(limit);
    return new Map(
      z
        .array(affinityRowSchema)
        .parse(
          this.db
            .prepare("SELECT * FROM pool_affinity ORDER BY last_used_at, rowid")
            .all(),
        )
        .map((row) => [
          row.affinity_key,
          { accountId: row.account_id, lastUsedAt: row.last_used_at },
        ]),
    );
  }

  loadActiveAccounts(): Map<PoolProvider, { accountId: string }> {
    return new Map(
      z
        .array(activeAccountRowSchema)
        .parse(this.db.prepare("SELECT * FROM pool_active_account").all())
        .map((row) => [row.provider, { accountId: row.account_id }]),
    );
  }

  putBinding(key: string, binding: AccountBinding): void {
    this.db
      .prepare(
        `INSERT INTO pool_affinity (affinity_key, account_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT(affinity_key) DO UPDATE SET account_id = excluded.account_id, last_used_at = excluded.last_used_at`,
      )
      .run(key, binding.accountId, binding.lastUsedAt);
  }

  removeBinding(key: string): void {
    this.db
      .prepare("DELETE FROM pool_affinity WHERE affinity_key = ?")
      .run(key);
  }

  putActiveAccount(provider: PoolProvider, accountId: string): void {
    this.db
      .prepare(
        `INSERT INTO pool_active_account (provider, account_id) VALUES (?, ?)
       ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(provider, accountId);
  }
}

export const QUOTA_MIGRATIONS = [
  `CREATE TABLE account_quota (
    account_id TEXT PRIMARY KEY,
    five_hour_utilization REAL,
    five_hour_reset_at INTEGER,
    five_hour_status TEXT,
    seven_day_utilization REAL,
    seven_day_reset_at INTEGER,
    seven_day_status TEXT,
    representative_claim TEXT,
    bucket_exhaustion_json TEXT NOT NULL DEFAULT '{}',
    observed_at INTEGER,
    held_until INTEGER,
    error TEXT
  )`,
  `ALTER TABLE account_quota ADD COLUMN family_weekly_json TEXT NOT NULL DEFAULT '{"fable":null,"sonnet":null,"opus":null,"haiku":null,"other":null}'`,
  `ALTER TABLE account_quota ADD COLUMN limit_windows_json TEXT NOT NULL DEFAULT '[]'`,
  `CREATE TABLE pool_affinity (
    affinity_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE TABLE pool_active_account (
    provider TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
  )`,
];
