import { dirname } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
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
  env?: NodeJS.ProcessEnv;
  customTools?: ToolDefinition[];
  sessionFilePath?: string;
  systemPrompt?: string;
}

type PiSessionEventHandler = (event: AgentSessionEvent) => void;
type PiSessionDoneHandler = (error?: unknown) => void;

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

    // Pass custom system prompt (e.g. manager instructions) via ResourceLoader
    if (this.options.systemPrompt) {
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.options.cwd,
        systemPrompt: this.options.systemPrompt,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await resourceLoader.reload();
      sessionOptions.resourceLoader = resourceLoader;
    }

    // Resolve model if specified
    if (this.options.model) {
      const model = resolveModel(this.options.model);
      if (model) {
        sessionOptions.model = model;
      }
    }

    // Register custom tools
    if (this.options.customTools && this.options.customTools.length > 0) {
      sessionOptions.customTools = this.options.customTools;
    }

    // The Pi SDK does not support per-session environment variables — its
    // built-in tools (bash, etc.) inherit from process.env. BB therefore
    // isolates Pi bridge subprocesses per thread at the host-daemon layer.
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
    }

    try {
      const { session } = await createAgentSession(sessionOptions);
      this.session = session;

      this.ensureCustomToolsActive();

      // Subscribe to session events
      this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.trackProcessingState(event);
        this.onEvent(event);
      });
    } catch (error) {
      this.onDone(error);
    }
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session) return;
    this.isProcessing = true;
    try {
      this.ensureCustomToolsActive();
      if (this.session.isStreaming) {
        await this.session.prompt(text, {
          streamingBehavior: "steer",
          ...(images && images.length > 0 ? { images } : {}),
        });
      } else {
        await this.session.prompt(text, {
          ...(images && images.length > 0 ? { images } : {}),
        });
      }
    } catch (error) {
      this.isProcessing = false;
      this.onDone(error);
    }
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.session) return;
    try {
      this.ensureCustomToolsActive();
      if (this.session.isStreaming) {
        await this.session.prompt(text, {
          streamingBehavior: "steer",
          ...(images && images.length > 0 ? { images } : {}),
        });
      } else {
        await this.session.prompt(text, {
          ...(images && images.length > 0 ? { images } : {}),
        });
      }
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
    if (!this.session || !this.options.customTools || this.options.customTools.length === 0) {
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
}

/**
 * Resolve a model string like "anthropic/claude-sonnet-4-20250514" to a
 * Pi Model object. Returns undefined if the model can't be resolved.
 */
function resolveModel(modelStr: string): ReturnType<typeof getModel> | undefined {
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
      case "google":
        return getModel("google", modelId as never);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
