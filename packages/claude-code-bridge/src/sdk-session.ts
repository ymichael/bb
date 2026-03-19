import {
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface SdkSessionOptions {
  cwd: string;
  systemPrompt: string;
  model?: string;
  permissionMode?: string;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  tools?: string[];
  env?: NodeJS.ProcessEnv;
}

export type SdkSessionMessageHandler = (message: SDKMessage) => void;
export type SdkSessionDoneHandler = (error?: unknown) => void;

export class SdkSession {
  private query: Query | undefined;
  private sessionId: string | undefined;
  private sessionIdResolve: ((id: string) => void) | null = null;
  private inputResolve:
    | ((value: IteratorResult<SDKUserMessage>) => void)
    | null = null;
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputDone = false;
  private readonly abortController = new AbortController();
  private isProcessing = false;

  constructor(
    private readonly options: SdkSessionOptions,
    private readonly onMessage: SdkSessionMessageHandler,
    private readonly onDone: SdkSessionDoneHandler,
  ) {}

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Returns a promise that resolves with the SDK session ID once the first
   * message with a session_id arrives from the SDK stream.
   */
  waitForSessionId(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    return new Promise<string>((resolve) => {
      this.sessionIdResolve = resolve;
    });
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  start(resumeSessionId?: string): void {
    const sdkOptions: Options = {
      abortController: this.abortController,
      cwd: this.options.cwd,
      systemPrompt: this.options.systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: [],
      persistSession: true,
      env: this.options.env ?? process.env,
      ...(this.options.mcpServers
        ? { mcpServers: this.options.mcpServers }
        : {}),
      ...(this.options.allowedTools
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.tools ? { tools: this.options.tools } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
    };

    this.query = query({
      prompt: this.createInputIterable(),
      options: sdkOptions,
    });

    void this.consumeStream();
  }

  pushInput(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    };

    if (this.inputDone) return;

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({ value: message, done: false });
      return;
    }

    this.inputQueue.push(message);
  }

  stop(): void {
    this.inputDone = true;
    this.resolveInputDone();
    this.abortController.abort();
    this.query?.close();
    this.query = undefined;
    this.isProcessing = false;
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const value = self.inputQueue.shift()!;
              return { value, done: false };
            }
            if (self.inputDone) {
              return {
                value: undefined as unknown as SDKUserMessage,
                done: true,
              };
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            self.inputDone = true;
            self.resolveInputDone();
            return {
              value: undefined as unknown as SDKUserMessage,
              done: true,
            };
          },
        };
      },
    };
  }

  private resolveInputDone(): void {
    if (!this.inputResolve) return;
    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({
      value: undefined as unknown as SDKUserMessage,
      done: true,
    });
  }

  private async consumeStream(): Promise<void> {
    const q = this.query;
    if (!q) return;

    try {
      for await (const message of q) {
        this.captureSessionId(message);
        this.trackProcessingState(message);
        this.onMessage(message);
      }
      this.isProcessing = false;
      this.onDone();
    } catch (error) {
      this.isProcessing = false;
      this.onDone(error);
    }
  }

  private captureSessionId(message: SDKMessage): void {
    const maybeSessionId = (message as { session_id?: unknown }).session_id;
    if (
      typeof maybeSessionId === "string" &&
      maybeSessionId.trim().length > 0
    ) {
      this.sessionId = maybeSessionId;
      if (this.sessionIdResolve) {
        this.sessionIdResolve(maybeSessionId);
        this.sessionIdResolve = null;
      }
    }
  }

  private trackProcessingState(message: SDKMessage): void {
    if (message.type === "assistant" || message.type === "stream_event") {
      this.isProcessing = true;
    }
    if (message.type === "result") {
      this.isProcessing = false;
    }
  }
}
