import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  deleteSandboxProviderCredentialByProviderId,
} from "@bb/db";
import type { ServerRuntimeConfig } from "../../../apps/server/src/types.js";
import { buildSandboxRuntimeMaterialSnapshot } from "../../../apps/server/src/services/hosts/sandbox-runtime-material-snapshot.js";
import {
  createSandbox,
  resumeSandbox,
  runSandboxCommand,
  writeSandboxFile,
} from "@bb/sandbox-host";
import { resolveSandboxImageTemplate } from "@bb/sandbox-image";
import {
  createProject,
  killProcess,
  loadDotEnv,
  reservePort,
  startQuickTunnel,
  startQaServer,
} from "./shared.js";
import {
  buildQaAuthCoverageSummary,
  loadQaAuthFixture,
  renderQaAuthCoverageSummary,
} from "./e2b-smoke/fixture.js";
import {
  DAEMON_BOOTSTRAP_TIMEOUT_MS,
  INITIAL_SANDBOX_TIMEOUT_MS,
  SANDBOX_HOST_RUNTIME_MATERIAL_PATH,
  SMOKE_CLAUDE_PATH,
  SMOKE_CODEX_PATH,
  SMOKE_PI_AUTH_PATH,
  SMOKE_PROVIDER_OUTPUT_TOKENS,
  SMOKE_PROVIDER_WORKSPACES,
  SMOKE_SANDBOX_ENV_NAME,
  SMOKE_SANDBOX_ENV_VALUE,
  SMOKE_TIMEOUT_MS,
  STALE_CODEX_ACCESS_TOKEN,
  assertBundledBbCli,
  assertSandboxFileAbsent,
  assertSandboxFileContains,
  assertSandboxFileOmits,
  buildHostWorkspaceEnvironment,
  buildReuseEnvironment,
  choosePreferredModel,
  createEphemeralHostJoin,
  createSmokeHostIdentity,
  createSmokeRuntimeMaterialContext,
  createSmokeThread,
  expireSmokeCodexCredential,
  fetchProviderModels,
  fetchThreadOutput,
  formatError,
  requirePiDefaultModel,
  runSmokeProviderTurn,
  seedSmokeCloudAuthFixture,
  shellQuote,
  startRealDaemon,
  toSandboxShellPath,
  waitForConnectedSmokeHost,
  waitForDaemonHealth,
  waitForExtendedSandboxTimeout,
  waitForHostStatus,
  waitForPersistedHostAuth,
  waitForPersistedRuntimeMaterial,
  waitForPublicServerHealth,
  waitForThreadIdle,
  type SmokeSandbox,
} from "./e2b-smoke/support.js";

async function main(): Promise<void> {
  await loadDotEnv();

  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is required");
  }

  const smokeHost = createSmokeHostIdentity();
  const serverPort = await reservePort();
  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "bb-e2b-smoke-"));
  const logsDir = path.join(tmpRoot, "logs");
  const serverDataDir = path.join(tmpRoot, "server-data");
  const serverLogPath = path.join(logsDir, "server.log");
  const tunnelLogPath = path.join(logsDir, "tunnel.log");
  const loadedAuthFixture = await loadQaAuthFixture();
  const authCoverageSummary = buildQaAuthCoverageSummary(loadedAuthFixture);
  const authFixture = loadedAuthFixture.fixture;
  const smokeGithubPat = process.env.BB_GITHUB_PAT ?? "";
  const runtimeConfig: ServerRuntimeConfig = {
    anthropicApiKey: "",
    dataDir: serverDataDir,
    e2bApiKey: process.env.E2B_API_KEY,
    e2bTemplate: process.env.BB_E2B_TEMPLATE ?? "sandbox",
    githubPat: smokeGithubPat,
    hostDaemonPort: 3_001,
    inferenceModel: "gpt-5",
    openAiApiKey: "",
    publicUrl: "https://placeholder.example.test",
    sandboxActivityExtensionDebounceMs: 30_000,
    sandboxIdleThresholdMs: 60_000,
  };
  await fs.mkdir(serverDataDir, { recursive: true });
  const runtimeMaterialContext = await createSmokeRuntimeMaterialContext(
    serverDataDir,
    runtimeConfig,
  );

  for (const notice of loadedAuthFixture.notices) {
    console.warn(`Auth fixture notice: ${notice}`);
  }
  for (const line of renderQaAuthCoverageSummary(authCoverageSummary)) {
    console.log(line);
  }
  if (
    process.env.BB_E2B_SMOKE_REQUIRE_FULL_AUTH === "1"
    && !authCoverageSummary.hasFullSubscriptionCoverage
  ) {
    throw new Error(
      "BB_E2B_SMOKE_REQUIRE_FULL_AUTH=1 but the local cloud-auth fixture is missing Claude or Codex subscription coverage. Acquire the missing credentials with the commands printed above, then rerun the smoke.",
    );
  }

  await fs.mkdir(logsDir, { recursive: true });
  await seedSmokeCloudAuthFixture(runtimeMaterialContext, authFixture);
  await runtimeMaterialContext.sandboxEnv.upsertEnvVar({
    name: SMOKE_SANDBOX_ENV_NAME,
    value: SMOKE_SANDBOX_ENV_VALUE,
  });
  const expectedRuntimeSnapshot = await buildSandboxRuntimeMaterialSnapshot(
    runtimeMaterialContext,
  );

  const tunnel = await startQuickTunnel({
    logPath: tunnelLogPath,
    port: serverPort,
  });
  const publicUrl = tunnel.publicUrl;
  const qaServer = await startQaServer({
    dataDir: serverDataDir,
    env: {
      ANTHROPIC_API_KEY: "",
      BB_SANDBOX_IDLE_THRESHOLD_MS: "60000",
      OPENAI_API_KEY: "",
    },
    logPath: serverLogPath,
    port: serverPort,
    publicUrl,
  });
  const localServerUrl = qaServer.serverUrl;
  let activeSandbox: SmokeSandbox | null = null;
  let completed = false;
  let codexEnvironmentId: string | null = null;
  let piEnvironmentId: string | null = null;
  let sharedEnvironmentId: string | null = null;

  try {
    console.log(`Started quick tunnel at ${publicUrl}`);
    console.log(`Started real server at ${localServerUrl}`);

    console.log("Creating sandbox");
    const sandbox = await createSandbox({
      timeoutMs: INITIAL_SANDBOX_TIMEOUT_MS,
    });
    activeSandbox = sandbox;
    console.log(`Created sandbox ${sandbox.sandboxId}`);

    console.log("Writing /tmp/hello.txt");
    await writeSandboxFile(sandbox, "/tmp/hello.txt", "hello from bb");

    console.log("Reading /tmp/hello.txt");
    const helloResult = await runSandboxCommand(sandbox, "cat /tmp/hello.txt");
    if (helloResult.stdout.trim() !== "hello from bb") {
      throw new Error(`Unexpected hello output: ${helloResult.stdout}`);
    }

    console.log("Checking Node.js availability");
    const nodeResult = await runSandboxCommand(sandbox, "node --version");
    if (!nodeResult.stdout.trim().startsWith("v")) {
      throw new Error(`Unexpected node version output: ${nodeResult.stdout}`);
    }

    const templateId = resolveSandboxImageTemplate();
    console.log(`Checking template tools for ${templateId}`);
    await runSandboxCommand(sandbox, "codex --version");
    await runSandboxCommand(sandbox, "git --version");
    await runSandboxCommand(sandbox, "gh --version");

    console.log(`Checking sandbox to server connectivity via ${publicUrl}`);
    await waitForPublicServerHealth(sandbox, publicUrl);

    console.log("Refreshing sandbox timeout before daemon bootstrap");
    await sandbox.setTimeout(DAEMON_BOOTSTRAP_TIMEOUT_MS);
    const daemonBootstrapSandboxInfo = await sandbox.getInfo();

    console.log("Requesting real ephemeral host join material");
    const join = await createEphemeralHostJoin(localServerUrl, {
      externalId: sandbox.sandboxId,
      hostId: smokeHost.hostId,
    });

    console.log("Starting real bundled daemon");
    await startRealDaemon(sandbox, {
      enrollKey: join.joinCode,
      hostId: smokeHost.hostId,
      hostName: smokeHost.hostName,
      serverUrl: publicUrl,
    });
    await waitForDaemonHealth(sandbox);

    console.log("Waiting for real server to mark the host connected");
    await waitForConnectedSmokeHost(localServerUrl, smokeHost.hostId);

    console.log("Preparing provider workspaces");
    await runSandboxCommand(
      sandbox,
      [
        "mkdir -p",
        shellQuote(SMOKE_PROVIDER_WORKSPACES.codex),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.claude),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.pi),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.shared),
      ].join(" "),
    );

    console.log("Checking persisted daemon auth");
    await waitForPersistedHostAuth(sandbox, {
      hostId: smokeHost.hostId,
      serverUrl: publicUrl,
    });

    console.log("Checking persisted runtime material");
    await waitForPersistedRuntimeMaterial(sandbox, expectedRuntimeSnapshot);
    await assertSandboxFileOmits(
      sandbox,
      SANDBOX_HOST_RUNTIME_MATERIAL_PATH,
      SMOKE_SANDBOX_ENV_NAME,
    );

    if (authFixture?.claude) {
      console.log("Checking Claude auth material");
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CLAUDE_PATH,
        "\"refreshToken\": \"\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"anthropic\"",
      );
    }

    if (authFixture?.["openai-codex"]) {
      console.log("Checking Codex auth material");
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CODEX_PATH,
        "\"refresh_token\": \"\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CODEX_PATH,
        "\"id_token\":",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"openai-codex\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"refresh\": \"\"",
      );
    }

    console.log("Checking sandbox timeout extension after daemon activity");
    await waitForExtendedSandboxTimeout(sandbox);
    const extendedSandboxInfo = await sandbox.getInfo();
    if (
      extendedSandboxInfo.endAt.getTime()
      <= daemonBootstrapSandboxInfo.endAt.getTime()
    ) {
      throw new Error("Sandbox timeout did not extend past the bootstrap expiration");
    }

    console.log("Checking bundled bb CLI");
    await assertBundledBbCli(sandbox);

    console.log("Creating project for resume smoke coverage");
    const project = await createProject(localServerUrl, {
      name: "E2B Smoke Project",
      source: {
        type: "local_path",
        hostId: smokeHost.hostId,
        path: "/tmp",
      },
    });

    console.log("Resolving provider models from the connected sandbox");
    const [codexModels, claudeModels, piModels] = await Promise.all([
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "codex",
      }),
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "claude-code",
      }),
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "pi",
      }),
    ]);
    const codexModel = choosePreferredModel("codex", codexModels, []);
    const claudeModel = authFixture?.claude
      ? choosePreferredModel("claude-code", claudeModels, [])
      : null;
    const initialPiModel = choosePreferredModel("pi", piModels, [
      "openai-codex/",
      "anthropic/",
    ]);
    const sharedPiAnthropicModel = authFixture?.claude
      ? requirePiDefaultModel(piModels, "anthropic")
      : null;
    const sharedPiOpenaiCodexModel = requirePiDefaultModel(piModels, "openai-codex");
    const resumedPiModel = choosePreferredModel("pi", piModels, [
      "openai-codex/",
    ]);

    console.log(`Running shared-environment Codex thread with model ${codexModel.model}`);
    const sharedCodexThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.shared,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedCodex,
      model: codexModel.model,
      projectId: project.id,
      providerId: "codex",
    });
    sharedEnvironmentId = sharedCodexThread.environmentId;
    if (!sharedEnvironmentId) {
      throw new Error("Expected the shared Codex thread to create an environment");
    }

    if (claudeModel) {
      console.log(`Running shared-environment Claude thread with model ${claudeModel.model}`);
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedClaude,
        model: claudeModel.model,
        projectId: project.id,
        providerId: "claude-code",
      });
    }

    console.log(
      `Running shared-environment Pi thread with model ${sharedPiOpenaiCodexModel.model}`,
    );
    await runSmokeProviderTurn(localServerUrl, {
      environment: buildReuseEnvironment(sharedEnvironmentId),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedPiOpenaiCodex,
      model: sharedPiOpenaiCodexModel.model,
      projectId: project.id,
      providerId: "pi",
    });

    if (sharedPiAnthropicModel) {
      console.log(
        `Running shared-environment Pi thread with model ${sharedPiAnthropicModel.model}`,
      );
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedPiAnthropic,
        model: sharedPiAnthropicModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    console.log(`Running live Codex thread with model ${codexModel.model}`);
    const codexThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.codex,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.codexInitial,
      model: codexModel.model,
      projectId: project.id,
      providerId: "codex",
    });
    codexEnvironmentId = codexThread.environmentId;
    if (!codexEnvironmentId) {
      throw new Error("Expected the initial Codex thread to create an environment");
    }

    if (claudeModel) {
      console.log(`Running live Claude thread with model ${claudeModel.model}`);
      const claudeThread = await runSmokeProviderTurn(localServerUrl, {
        environment: buildHostWorkspaceEnvironment(
          smokeHost.hostId,
          SMOKE_PROVIDER_WORKSPACES.claude,
        ),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.claude,
        model: claudeModel.model,
        projectId: project.id,
        providerId: "claude-code",
      });
      if (!claudeThread.environmentId) {
        throw new Error("Expected the initial Claude thread to create an environment");
      }
    }

    console.log(`Running live Pi thread with model ${initialPiModel.model}`);
    const initialPiThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.pi,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.piInitial,
      model: initialPiModel.model,
      projectId: project.id,
      providerId: "pi",
    });
    piEnvironmentId = initialPiThread.environmentId;
    if (!piEnvironmentId) {
      throw new Error("Expected the initial Pi thread to create an environment");
    }

    console.log("Waiting for server-driven idle suspension");
    await waitForHostStatus(localServerUrl, smokeHost.hostId, "suspended", 120_000);
    const pausedSandboxInfo = await sandbox.getInfo();
    if (pausedSandboxInfo.state !== "paused") {
      throw new Error(`Expected paused sandbox after idle suspend, got ${pausedSandboxInfo.state}`);
    }

    if (authFixture?.claude) {
      console.log("Removing Claude credential before resume");
      deleteSandboxProviderCredentialByProviderId(
        runtimeMaterialContext.db,
        "claude-code",
      );
    }
    if (authFixture?.["openai-codex"]) {
      console.log("Expiring Codex credential before resume");
      await expireSmokeCodexCredential(runtimeMaterialContext, authFixture);
    }
    console.log("Removing custom sandbox env var before resume");
    await runtimeMaterialContext.sandboxEnv.deleteEnvVar({
      name: SMOKE_SANDBOX_ENV_NAME,
    });

    console.log("Triggering server-driven resume with follow-up thread work");
    if (!codexEnvironmentId) {
      throw new Error("Expected a reusable Codex environment ID before resume");
    }
    const createdThread = await createSmokeThread(localServerUrl, {
      environment: buildReuseEnvironment(codexEnvironmentId),
      model: codexModel.model,
      projectId: project.id,
      prompt: `Reply with exactly ${SMOKE_PROVIDER_OUTPUT_TOKENS.codexResume} and no other text.`,
      providerId: "codex",
    });
    if (
      createdThread.status !== "created"
      && createdThread.status !== "provisioning"
    ) {
      throw new Error(`Unexpected resumed thread status: ${createdThread.status}`);
    }

    await waitForHostStatus(localServerUrl, smokeHost.hostId, "connected");
    const runningSandboxInfo = await sandbox.getInfo();
    if (runningSandboxInfo.state !== "running") {
      throw new Error(`Expected running sandbox after resume, got ${runningSandboxInfo.state}`);
    }

    console.log("Connecting to the resumed sandbox");
    const resumedSandbox = await resumeSandbox(sandbox.sandboxId, {
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    activeSandbox = resumedSandbox;

    console.log("Checking real daemon after server-driven resume");
    await waitForDaemonHealth(resumedSandbox);

    console.log("Checking runtime material after resume");
    const resumedRuntimeSnapshot = await buildSandboxRuntimeMaterialSnapshot(
      runtimeMaterialContext,
    );
    await waitForPersistedRuntimeMaterial(resumedSandbox, resumedRuntimeSnapshot);
    if (authFixture?.claude) {
      await assertSandboxFileAbsent(resumedSandbox, SMOKE_CLAUDE_PATH);
    }
    if (authFixture?.["openai-codex"]) {
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_PI_AUTH_PATH,
        "\"openai-codex\"",
      );
      const piAuthResult = await runSandboxCommand(
        resumedSandbox,
        `cat ${toSandboxShellPath(SMOKE_PI_AUTH_PATH)}`,
      );
      if (piAuthResult.stdout.includes("\"anthropic\"")) {
        throw new Error("Pi auth file still contains the removed Claude credential");
      }
    } else {
      await assertSandboxFileAbsent(resumedSandbox, SMOKE_PI_AUTH_PATH);
    }
    const resumedRuntimeMaterial = await runSandboxCommand(
      resumedSandbox,
      `cat ${shellQuote(SANDBOX_HOST_RUNTIME_MATERIAL_PATH)}`,
    );
    if (resumedRuntimeMaterial.stdout.includes(SMOKE_SANDBOX_ENV_NAME)) {
      throw new Error("Runtime material still contains the removed sandbox env var");
    }

    if (authFixture?.["openai-codex"]) {
      console.log("Checking refreshed Codex material after resume");
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_CODEX_PATH,
        "\"refresh_token\": \"\"",
      );
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_CODEX_PATH,
        "\"id_token\":",
      );
      const codexResult = await runSandboxCommand(
        resumedSandbox,
        `cat ${toSandboxShellPath(SMOKE_CODEX_PATH)}`,
      );
      if (codexResult.stdout.includes(STALE_CODEX_ACCESS_TOKEN)) {
        throw new Error("Codex auth file still contains the stale access token");
      }
    }

    console.log("Waiting for resumed Codex thread output");
    await waitForThreadIdle(localServerUrl, createdThread.id);
    const resumedCodexOutput = await fetchThreadOutput(localServerUrl, createdThread.id);
    if (!resumedCodexOutput.output?.includes(SMOKE_PROVIDER_OUTPUT_TOKENS.codexResume)) {
      throw new Error(
        `Unexpected resumed Codex output: ${resumedCodexOutput.output ?? "(no output)"}`,
      );
    }

    if (authFixture?.["openai-codex"]) {
      console.log(`Running live Pi thread after resume with model ${resumedPiModel.model}`);
      if (!piEnvironmentId) {
        throw new Error("Expected a reusable Pi environment ID before resume");
      }
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(piEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.piResume,
        model: resumedPiModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    if (sharedEnvironmentId && authFixture?.["openai-codex"]) {
      console.log(
        `Running shared-environment Pi thread after resume with model ${sharedPiOpenaiCodexModel.model}`,
      );
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedResume,
        model: sharedPiOpenaiCodexModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    console.log("Checking bundled bb CLI after server-driven resume");
    await assertBundledBbCli(resumedSandbox);
    completed = true;
  } finally {
    await runtimeMaterialContext.cloudAuth.dispose().catch(() => undefined);
    console.log("Destroying sandbox");
    await activeSandbox?.kill().catch((error) => {
      console.error(`Failed to destroy sandbox: ${formatError(error)}`);
    });

    await killProcess(tunnel.process?.pid).catch((error) => {
      console.error(`Failed to stop smoke tunnel: ${formatError(error)}`);
    });
    await killProcess(qaServer.process?.pid).catch((error) => {
      console.error(`Failed to stop QA server: ${formatError(error)}`);
    });
    if (completed) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch((error) => {
        console.error(`Failed to remove smoke temp dir: ${formatError(error)}`);
      });
    } else {
      console.error(`Preserving smoke temp dir at ${tmpRoot}`);
    }
  }
}

void main().then(
  () => {
    console.log("E2B smoke test passed");
  },
  (error) => {
    console.error("E2B smoke test failed");
    console.error(formatError(error));
    process.exitCode = 1;
  },
);
