import { dirname } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  defineTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type BashSpawnHook,
  type ContextUsage,
  type CreateAgentSessionOptions,
  type SessionStats,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { ImageContent } from "@mariozechner/pi-ai";

export interface PiSdkSessionOptions {
  cwd: string;
  model?: string;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  shellEnvOverrides?: ShellEnvOverrides;
  customTools?: ToolDefinition[];
  sessionFilePath?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

export type ShellEnvOverrides = Record<string, string>;

type PiSessionEventHandler = (event: AgentSessionEvent) => void;
type PiSessionDoneHandler = (error?: unknown) => void;
type AppendSystemPromptOverride = (base: string[]) => string[];

interface RunPromptArgs {
  images?: ImageContent[];
  text: string;
}

const PI_TRANSIENT_AUTH_RETRY_DELAY_MS = 250;
// Pi auth storage can briefly miss credentials during concurrent session startup;
// allow roughly two seconds before surfacing a real auth failure.
const PI_TRANSIENT_AUTH_MAX_RETRIES = 8;

interface CreateBashToolWithShellEnvOverlayArgs {
  cwd: string;
  shellEnvOverrides: ShellEnvOverrides;
}

interface BuildSessionCustomToolsArgs {
  customTools?: ToolDefinition[];
  cwd: string;
  shellEnvOverrides?: ShellEnvOverrides;
}

function assertExclusivePiPromptOverrides(options: PiSdkSessionOptions): void {
  if (
    options.systemPrompt !== undefined &&
    options.appendSystemPrompt !== undefined
  ) {
    throw new Error(
      "Pi sessions accept either systemPrompt or appendSystemPrompt, not both",
    );
  }
}

function buildAppendSystemPromptOverride(
  appendSystemPrompt: string,
): AppendSystemPromptOverride {
  return (base) => [...base, appendSystemPrompt];
}

function hasShellEnvOverrides(
  shellEnvOverrides: ShellEnvOverrides | undefined,
): shellEnvOverrides is ShellEnvOverrides {
  return (
    shellEnvOverrides !== undefined && Object.keys(shellEnvOverrides).length > 0
  );
}

function createBashToolWithShellEnvOverlay(
  args: CreateBashToolWithShellEnvOverlayArgs,
): ToolDefinition {
  const shellEnvOverrides = args.shellEnvOverrides;
  const spawnHook: BashSpawnHook = (context) => ({
    ...context,
    env: {
      ...context.env,
      ...shellEnvOverrides,
    },
  });

  // Pi exposes shell env customization through bash spawn options today. This is
  // intentionally bash-only; non-bash tools must not depend on per-thread env in
  // this shared bridge process.
  return defineTool(createBashToolDefinition(args.cwd, { spawnHook }));
}

function buildSessionCustomTools(
  args: BuildSessionCustomToolsArgs,
): ToolDefinition[] {
  const customTools = [...(args.customTools ?? [])];
  if (hasShellEnvOverrides(args.shellEnvOverrides)) {
    customTools.push(
      createBashToolWithShellEnvOverlay({
        cwd: args.cwd,
        shellEnvOverrides: args.shellEnvOverrides,
      }),
    );
  }
  return customTools;
}

function isTransientPiAuthStorageError(error: Error): boolean {
  return error.message.startsWith("No API key found for ");
}

async function waitForTransientAuthRetry(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, PI_TRANSIENT_AUTH_RETRY_DELAY_MS),
  );
}

/**
 * Wraps the Pi programmatic SDK (`@mariozechner/pi-coding-agent`) in a
 * session object that bridges between the BB JSON-RPC protocol and
 * the Pi agent's event-driven API.
 */
export class PiSdkSession {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private isProcessing = false;

  constructor(
    private readonly options: PiSdkSessionOptions,
    private readonly onEvent: PiSessionEventHandler,
    private readonly onDone: PiSessionDoneHandler,
  ) {}

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  getSessionStats(): SessionStats | undefined {
    return this.session?.getSessionStats();
  }

  getContextUsage(): ContextUsage | undefined {
    return this.session?.getContextUsage();
  }

  async start(): Promise<void> {
    assertExclusivePiPromptOverrides(this.options);

    const sessionOptions: CreateAgentSessionOptions = {
      cwd: this.options.cwd,
      sessionManager: this.options.sessionFilePath
        ? SessionManager.open(
            this.options.sessionFilePath,
            dirname(this.options.sessionFilePath),
          )
        : SessionManager.inMemory(this.options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
    };

    const appendSystemPrompt = this.options.appendSystemPrompt?.trim();

    // Pass custom prompt overrides through ResourceLoader. systemPrompt is the
    // replacement path; appendSystemPrompt layers BB instructions on top of Pi's
    // normal discovered APPEND_SYSTEM.md prompt. The two are mutually exclusive
    // in BB's bridge contract and asserted here for direct SDK-session callers.
    if (this.options.systemPrompt || appendSystemPrompt) {
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.options.cwd,
        agentDir: getAgentDir(),
        ...(this.options.systemPrompt
          ? {
              systemPrompt: this.options.systemPrompt,
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
            }
          : {}),
        ...(appendSystemPrompt
          ? {
              appendSystemPromptOverride:
                buildAppendSystemPromptOverride(appendSystemPrompt),
            }
          : {}),
      });
      await resourceLoader.reload();
      sessionOptions.resourceLoader = resourceLoader;
    }

    const configuredModel = resolveConfiguredModel(this.options.model);
    if (configuredModel) {
      sessionOptions.model = configuredModel;
    }
    if (this.options.thinkingLevel) {
      sessionOptions.thinkingLevel = this.options.thinkingLevel;
    }

    const customTools = buildSessionCustomTools({
      customTools: this.options.customTools,
      cwd: this.options.cwd,
      shellEnvOverrides: this.options.shellEnvOverrides,
    });
    sessionOptions.customTools = customTools;

    const { session } = await createAgentSession(sessionOptions);
    this.session = session;

    this.ensureCustomToolsActive();

    // Subscribe to session events
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.trackProcessingState(event);
      this.onEvent(event);
    });
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session) return;
    this.isProcessing = true;
    try {
      await this.runPromptWithTransientAuthRetry({
        images,
        text,
      });
    } catch (error) {
      this.isProcessing = false;
      this.onDone(error);
    }
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session) return;
    try {
      await this.runPromptWithTransientAuthRetry({
        images,
        text,
      });
    } catch (error) {
      this.onDone(error);
    }
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.isProcessing = false;
  }

  stop(): void {
    this.detach();
    if (this.session) {
      this.session.dispose();
      this.session = undefined;
    }
  }

  async closeGracefully(timeoutMs: number): Promise<void> {
    const session = this.session;
    this.detach();
    if (!session) {
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortCompleted = session.abort().catch(() => undefined);
    const timeoutReached = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([abortCompleted, timeoutReached]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      session.dispose();
      if (this.session === session) {
        this.session = undefined;
      }
      this.isProcessing = false;
    }
  }

  private trackProcessingState(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      this.isProcessing = true;
    }
    if (event.type === "agent_end") {
      this.isProcessing = false;
      // NOTE: Do NOT call onDone() here. agent_end signals "turn complete,
      // ready for next input" — NOT session termination. The session stays
      // alive across multiple turns. onDone() is only called on fatal errors
      // (prompt() catch) or explicit stop().
    }
  }

  private ensureCustomToolsActive(): void {
    if (
      !this.session ||
      !this.options.customTools ||
      this.options.customTools.length === 0
    ) {
      return;
    }

    const activeToolNames = new Set(this.session.getActiveToolNames());
    let missingCustomTool = false;
    for (const tool of this.options.customTools) {
      if (!activeToolNames.has(tool.name)) {
        missingCustomTool = true;
        activeToolNames.add(tool.name);
      }
    }

    if (missingCustomTool) {
      this.session.setActiveToolsByName(Array.from(activeToolNames));
    }
  }

  private async runPromptWithTransientAuthRetry(
    args: RunPromptArgs,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.runPromptOnce(args);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !isTransientPiAuthStorageError(error) ||
          attempt >= PI_TRANSIENT_AUTH_MAX_RETRIES
        ) {
          throw error;
        }
        await waitForTransientAuthRetry();
      }
    }
  }

  private async runPromptOnce(args: RunPromptArgs): Promise<void> {
    if (!this.session) {
      return;
    }
    this.ensureCustomToolsActive();
    if (this.session.isStreaming) {
      await this.session.prompt(args.text, {
        streamingBehavior: "steer",
        ...(args.images && args.images.length > 0
          ? { images: args.images }
          : {}),
      });
      return;
    }
    await this.session.prompt(args.text, {
      ...(args.images && args.images.length > 0
        ? { images: args.images }
        : {}),
    });
  }
}

/**
 * Resolve a model string like "anthropic/claude-sonnet-4-20250514" to a
 * Pi Model object. Returns undefined if the model can't be resolved.
 */
function resolveConfiguredModel(
  modelStr: string | undefined,
): ReturnType<typeof getModel> | undefined {
  if (!modelStr) {
    return undefined;
  }

  const model = resolveModel(modelStr);
  if (!model) {
    throw new Error(`Failed to resolve Pi model "${modelStr}"`);
  }
  return model;
}

function resolveModel(
  modelStr: string,
): ReturnType<typeof getModel> | undefined {
  // Parse "provider/model-id" format
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx === -1) return undefined;

  const provider = modelStr.slice(0, slashIdx);
  const modelId = modelStr.slice(slashIdx + 1);

  try {
    // getModel is generic over known providers; we try the common ones
    switch (provider) {
      case "anthropic":
        return getModel("anthropic", modelId as never);
      case "openai":
        return getModel("openai", modelId as never);
      case "openai-codex":
        return getModel("openai-codex", modelId as never);
      case "google":
        return getModel("google", modelId as never);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
