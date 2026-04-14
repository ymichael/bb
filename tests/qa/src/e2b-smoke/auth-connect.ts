import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  getCloudAuthProviderDefinition,
  type StoredCloudAuthCredential,
} from "../../../../packages/agent-provider-auth/src/index.js";
import type {
  CloudAuthProviderDefinition,
} from "../../../../packages/agent-provider-auth/src/provider-definitions.js";
import {
  startOAuthCallbackServer,
  type OAuthCallbackPayload,
} from "../../../../apps/server/src/services/cloud-auth/callback-server.js";
import {
  DEFAULT_QA_AUTH_FIXTURE_PATH,
  loadSmokeQaProviderId,
  upsertQaAuthFixtureCredential,
  type SmokeQaAuthProviderId,
} from "./fixture.js";

const QA_AUTH_APP_ORIGIN = "http://localhost:5173";

interface AuthConnectCliArgs {
  callbackInput: string | null;
  fixturePath: string;
  providerId: SmokeQaAuthProviderId;
  showHelp: boolean;
}

interface ParseCliArgsResult {
  args: AuthConnectCliArgs | null;
}

interface ProviderAuthorizationFlow {
  authorizationUrl: string;
  state: string;
  verifier: string;
}

interface WaitForCallbackArgs {
  callbackInput: string | null;
  callbackPayloadPromise: Promise<OAuthCallbackPayload | null>;
  expectedState: string;
  providerDisplayName: string;
  server: {
    cancelWait(): void;
    close(): Promise<void>;
  };
}

interface ParseManualCallbackInputArgs {
  expectedState: string;
  input: string;
}

function printHelp(): void {
  console.log("Acquire local QA auth fixture credentials for the E2B smoke.");
  console.log("");
  console.log("Usage:");
  console.log(
    "  pnpm --filter @bb/qa auth:e2b-smoke --provider <claude-code|codex>",
  );
  console.log("");
  console.log("Options:");
  console.log("  --provider <id>       Required. claude-code or codex.");
  console.log(
    `  --fixture-path <path> Optional. Defaults to ${DEFAULT_QA_AUTH_FIXTURE_PATH}.`,
  );
  console.log(
    "  --callback-url <url> Optional. Paste a final redirect URL or code#state instead of waiting for localhost.",
  );
  console.log("  --help                Show this help text.");
}

function requireOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseCliArgs(argv: string[]): ParseCliArgsResult {
  let callbackInput: string | null = null;
  let fixturePath = DEFAULT_QA_AUTH_FIXTURE_PATH;
  let providerInput: string | null = null;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
        showHelp = true;
        break;
      case "--callback-url":
        callbackInput = requireOptionValue(argv, index, "--callback-url");
        index += 1;
        break;
      case "--fixture-path":
        fixturePath = requireOptionValue(argv, index, "--fixture-path");
        index += 1;
        break;
      case "--provider":
        providerInput = requireOptionValue(argv, index, "--provider");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (showHelp) {
    return {
      args: {
        callbackInput,
        fixturePath,
        providerId: "claude-code",
        showHelp,
      },
    };
  }

  if (!providerInput) {
    throw new Error("--provider is required");
  }

  return {
    args: {
      callbackInput,
      fixturePath,
      providerId: loadSmokeQaProviderId(providerInput),
      showHelp,
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseFragmentState(fragment: string): string | null {
  if (fragment.length === 0) {
    return null;
  }

  if (!fragment.includes("=")) {
    return fragment;
  }

  const fragmentParams = new URLSearchParams(fragment);
  return fragmentParams.get("state");
}

function parseManualCallbackInput(
  args: ParseManualCallbackInputArgs,
): OAuthCallbackPayload {
  const trimmedInput = args.input.trim();
  if (trimmedInput.length === 0) {
    throw new Error("OAuth callback input cannot be empty");
  }

  let code: string | null = null;
  let state: string | null = null;

  if (
    trimmedInput.startsWith("http://")
    || trimmedInput.startsWith("https://")
  ) {
    const url = new URL(trimmedInput);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state")
      ?? parseFragmentState(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  } else if (trimmedInput.includes("code=")) {
    const [queryPart, rawFragment = ""] = trimmedInput.split("#", 2);
    const query = queryPart.startsWith("?") ? queryPart.slice(1) : queryPart;
    const params = new URLSearchParams(query);
    code = params.get("code");
    state = params.get("state") ?? parseFragmentState(rawFragment);
  } else if (trimmedInput.includes("#")) {
    const [rawCode, rawState] = trimmedInput.split("#", 2);
    code = rawCode;
    state = parseFragmentState(rawState);
  }

  if (!code || !state) {
    throw new Error(
      "Expected a full redirect URL, a code=...&state=... string, or a code#state value.",
    );
  }

  if (state !== args.expectedState) {
    throw new Error("The pasted OAuth state does not match the active auth attempt.");
  }

  return {
    code,
    state,
  };
}

async function waitForManualInput(
  args: {
    abortController: AbortController;
    providerDisplayName: string;
    rl: ReturnType<typeof createInterface>;
  },
): Promise<string | null> {
  try {
    const answer = await args.rl.question(
      `Paste the final redirect URL or code#state for ${args.providerDisplayName} if localhost does not work, or press Enter to keep waiting: `,
      {
        signal: args.abortController.signal,
      },
    );
    return answer.trim();
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }
    throw error;
  }
}

async function waitForCallbackPayload(
  args: WaitForCallbackArgs,
): Promise<OAuthCallbackPayload> {
  if (args.callbackInput) {
    return parseManualCallbackInput({
      expectedState: args.expectedState,
      input: args.callbackInput,
    });
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    const callbackPayload = await args.callbackPayloadPromise;
    if (!callbackPayload) {
      throw new Error("OAuth callback wait was cancelled before a code arrived.");
    }
    return callbackPayload;
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const abortController = new AbortController();
      const winner = await Promise.race([
        args.callbackPayloadPromise.then((callbackPayload) => ({
          kind: "callback" as const,
          callbackPayload,
        })),
        waitForManualInput({
          abortController,
          providerDisplayName: args.providerDisplayName,
          rl,
        }).then((manualInput) => ({
          kind: "manual" as const,
          manualInput,
        })),
      ]);

      if (winner.kind === "callback") {
        abortController.abort();
        if (!winner.callbackPayload) {
          throw new Error("OAuth callback wait was cancelled before a code arrived.");
        }
        return winner.callbackPayload;
      }

      const manualInput = winner.manualInput;
      if (!manualInput) {
        console.log("Still waiting for the localhost callback...");
        continue;
      }

      args.server.cancelWait();
      return parseManualCallbackInput({
        expectedState: args.expectedState,
        input: manualInput,
      });
    }
  } finally {
    rl.close();
  }
}

function printFlowInstructions(
  args: {
    fixturePath: string;
    flow: ProviderAuthorizationFlow;
    providerDisplayName: string;
  },
): void {
  console.log(`${args.providerDisplayName} QA auth helper`);
  console.log(`Fixture path: ${args.fixturePath}`);
  console.log("");
  console.log("Open this URL in a browser:");
  console.log(args.flow.authorizationUrl);
  console.log("");
  console.log("The helper is listening for the localhost OAuth callback.");
  console.log(
    "If the browser cannot reach localhost, paste the full final redirect URL or code#state into this terminal when prompted.",
  );
  console.log(
    "If another person is helping, send them the URL above and ask them to return the final redirect URL from the browser address bar.",
  );
  console.log("");
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const args = parsed.args;
  if (!args) {
    throw new Error("Failed to parse CLI arguments");
  }

  if (args.showHelp) {
    printHelp();
    return;
  }

  const providerDefinition: CloudAuthProviderDefinition<StoredCloudAuthCredential> =
    getCloudAuthProviderDefinition(args.providerId);
  const flow = await providerDefinition.createAuthorizationFlow();
  const callbackServer = await startOAuthCallbackServer({
    appOrigin: QA_AUTH_APP_ORIGIN,
    errorTitle: providerDefinition.callback.errorTitle,
    expectedState: flow.state,
    listenHost: providerDefinition.callback.listenHost,
    path: providerDefinition.callback.path,
    port: providerDefinition.callback.port,
    successTitle: providerDefinition.callback.successTitle,
  });

  printFlowInstructions({
    fixturePath: args.fixturePath,
    flow,
    providerDisplayName: providerDefinition.displayName,
  });

  try {
    const callbackPayload = await waitForCallbackPayload({
      callbackInput: args.callbackInput,
      callbackPayloadPromise: callbackServer.waitForCode(),
      expectedState: flow.state,
      providerDisplayName: providerDefinition.displayName,
      server: callbackServer,
    });
    const credential = await providerDefinition.exchangeCode({
      code: callbackPayload.code,
      state: callbackPayload.state,
      verifier: flow.verifier,
    });
    const fixturePath = await upsertQaAuthFixtureCredential({
      credential,
      fixturePath: args.fixturePath,
    });
    const label = providerDefinition.getConnectionLabel(credential);

    console.log(`${providerDefinition.displayName} auth saved to ${fixturePath}`);
    if (label) {
      console.log(`Connected account: ${label}`);
    }
    console.log(`Credential expires at: ${new Date(credential.expiresAt).toISOString()}`);
    console.log("You can now run:");
    console.log("  pnpm exec turbo run test:e2b-smoke --filter=@bb/qa");
  } finally {
    await callbackServer.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
