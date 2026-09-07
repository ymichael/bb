import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createCodexWebSocketHandlers } from "./codex-websocket.js";
import { createHub } from "./hub.js";
import { PoolOperations } from "./operations.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  usageRefreshIntervalMs?: number;
  drainTimeoutMs?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    let currentSettings = accountPoolConfigSchema.parse(
      (await bb.storage.kv.get("config")) ?? {},
    );
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      getSettings: () => currentSettings,
      fetch: options.fetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      usageRefreshIntervalMs: options.usageRefreshIntervalMs,
      drainTimeoutMs: options.drainTimeoutMs,
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
    });
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
    );
    const login = new ClaudeOAuthLogin({
      fetch: options.fetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: options.fetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config),
    );
    registerPoolCli(bb, operations, login, codexLogin, config);
    bb.providers.experimental_contributeEnv("claude-code", async (context) => {
      if (
        !(await operations.isRoutingEnabled("claude")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("claude"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      await routing.recordRouted(context.threadId, context.hostId);
      return [
        {
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/account-pool/http",
          },
          reason: "Routed through the Account Pooler hub",
          secret: false,
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
          secret: true,
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
          secret: false,
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("claude-code", async () =>
      (await operations.isRoutingEnabled("claude")) &&
      (await operations.hasUsableEnabledAccount("claude"))
        ? {
            label: "Proxied",
            statusMessage:
              "Credentials are provided by the Account Pooler hub.",
          }
        : null,
    );
    bb.providers.experimental_contributeEnv("codex", async (context) => {
      if (
        !(await operations.isRoutingEnabled("codex")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("codex"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      return [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/account-pool/http/v1",
          },
          reason: "Routed through the Account Pooler hub",
          secret: false,
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
          secret: true,
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("codex", async () =>
      (await operations.isRoutingEnabled("codex")) &&
      (await operations.hasUsableEnabledAccount("codex"))
        ? {
            label: "Proxied",
            statusMessage:
              "Credentials are provided by the Account Pooler hub.",
          }
        : null,
    );
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    bb.http.route(
      "POST",
      "/v1/messages",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/messages/count_tokens",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/responses",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    bb.http.experimental_websocket(
      "/v1/responses",
      (context) => createCodexWebSocketHandlers(context, hub, bb.log),
      { auth: "none" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
