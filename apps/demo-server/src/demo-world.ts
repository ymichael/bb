import {
  defaultAppSettings,
  defaultAppTheme,
  defaultExperiments,
  defaultFeatureFlags,
  type PromptInput,
  type ThreadChangedMessage,
  type ThreadQueuedMessage,
} from "@bb/domain";
import {
  createQueuedMessageRequestSchema,
  pingMessageSchema,
  sendMessageRequestSchema,
  sendQueuedMessageRequestSchema,
  systemConfigResponseSchema,
  updateThreadTabsRequestSchema,
  type SendQueuedMessageResponse,
  type SystemConfigResponse,
  type ThreadChildSummaryResponse,
  type ThreadPendingInteractionsResponse,
  type ThreadQueuedMessageListResponse,
  type ThreadTabsResponse,
  type ThreadTimelineResponse,
} from "@bb/server-contract";
import { z } from "zod";
import configFixture from "./fixtures/system-config.json" with { type: "json" };
import { PROVIDERS, SYSTEM_EXECUTION_OPTIONS } from "./fixtures/providers.js";
import {
  commandRow,
  conversationRow,
  DEMO_REPLY,
  DEMO_REPLY_COMMAND,
  DEMO_THREADS,
  type DemoThreadSeed,
} from "./fixtures/timelines.js";
import {
  EMPTY_TABS,
  hosts,
  PLUGIN_CONTRIBUTIONS,
  queuedMessage,
  seedStartedAt,
  seedUpdatedAt,
  sidebarBootstrap,
  SYSTEM_VERSION,
  THREAD_DEFAULT_EXECUTION_OPTIONS,
  threadListEntry,
  threadResponse,
  type DemoThreadView,
} from "./fixtures/world.js";

const SYSTEM_CONFIG = systemConfigResponseSchema.parse({
  ...configFixture,
  generalSettings: defaultAppSettings,
  experiments: { ...defaultExperiments, mobileApp: true },
  appearance: defaultAppTheme,
  featureFlags: defaultFeatureFlags,
  serverUrl: "https://demo.invalid",
  aiServices: {
    inference: "codex/gpt-5.5",
    inferenceFallback: "codex/gpt-5.5",
    transcription: "openai/gpt-4o-transcribe",
    services: [],
  },
});

export const REPLY_DELAY_MS = 1_800;

export const MAX_MESSAGE_CHARS = 4_000;

export const MAX_TURNS_PER_THREAD = 20;

const THREAD_PATH =
  /^\/threads\/(thr_[a-z0-9]+)(?:\/([a-z-]+(?:\/[a-z0-9_-]+)*))?$/u;

interface SentTurn {
  text: string;
  sentAt: number;
}

interface ThreadState {
  seed: DemoThreadSeed;
  turns: SentTurn[];
}

interface DemoWorldOptions {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function notImplemented(method: string, path: string): Response {
  return json(
    {
      error: {
        code: "not_implemented",
        message: `The bb demo server does not implement ${method} ${path}. This server exists for App Store review and product demos; it serves fixed data and runs nothing.`,
      },
    },
    501,
  );
}

function badRequest(error: z.ZodError): Response {
  return json(
    { error: { code: "bad_request", message: z.prettifyError(error) } },
    400,
  );
}

function notFound(threadId: string): Response {
  return json(
    { error: { code: "not_found", message: `No thread ${threadId}` } },
    404,
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .slice(0, MAX_MESSAGE_CHARS);
}

export class DemoWorld {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly threads = new Map<string, ThreadState>(
    DEMO_THREADS.map((seed) => [seed.id, { seed, turns: [] }]),
  );
  private readonly queued = new Map<string, ThreadQueuedMessage[]>();
  private readonly listeners = new Set<
    (message: ThreadChangedMessage) => void
  >();
  private nextQueuedId = 1;

  constructor(options: DemoWorldOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  onChanged(listener: (message: ThreadChangedMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  socketReply(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return pingMessageSchema.safeParse(parsed).success
      ? JSON.stringify({ type: "pong" })
      : null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    if (path === "/health") return json({ ok: true });
    if (!path.startsWith("/api/v1/"))
      return notImplemented(request.method, path);

    const api = path.slice("/api/v1".length);
    const response = await this.handleApi(request, api, url.origin);
    return response ?? notImplemented(request.method, path);
  }

  private async handleApi(
    request: Request,
    api: string,
    origin: string,
  ): Promise<Response | null> {
    const now = this.now();
    if (request.method === "GET") {
      switch (api) {
        case "/system/config":
          return json(this.systemConfig(origin));
        case "/system/version":
          return json(SYSTEM_VERSION);
        case "/system/execution-options":
          return json(SYSTEM_EXECUTION_OPTIONS);
        case "/system/providers":
          return json(PROVIDERS);
        case "/hosts":
          return json(hosts(now));
        case "/plugins/contributions":
          return json(PLUGIN_CONTRIBUTIONS);
        case "/sidebar-bootstrap":
          return json(sidebarBootstrap(this.views(now), now));
        case "/threads":
          return json(
            this.views(now).map((view) => threadListEntry(view, now)),
          );
        default:
          break;
      }
    }

    const match = THREAD_PATH.exec(api);
    if (!match) return null;
    const [, threadId, sub = ""] = match;
    const state = this.threads.get(threadId);
    if (!state) return notFound(threadId);

    if (request.method === "GET") return this.handleThreadGet(state, sub, now);
    if (request.method === "POST")
      return this.handleThreadPost(request, state, sub, now);
    if (request.method === "PUT" && sub === "tabs")
      return this.handleUpdateTabs(request);
    return null;
  }

  private handleThreadGet(
    state: ThreadState,
    sub: string,
    now: number,
  ): Response | null {
    const view = this.view(state, now);
    switch (sub) {
      case "":
        return json(threadResponse(view, now));
      case "timeline":
        return json(this.timeline(state, now));
      case "interactions":
        return json([] satisfies ThreadPendingInteractionsResponse);
      case "queued-messages":
        return json(
          this.queuedFor(
            state.seed.id,
          ) satisfies ThreadQueuedMessageListResponse,
        );
      case "tabs":
        return json(EMPTY_TABS);
      case "default-execution-options":
        return json(THREAD_DEFAULT_EXECUTION_OPTIONS);
      case "child-summary":
        return json({
          nonDeletedChildCount: 0,
        } satisfies ThreadChildSummaryResponse);
      default:
        return null;
    }
  }

  private async handleThreadPost(
    request: Request,
    state: ThreadState,
    sub: string,
    now: number,
  ): Promise<Response | null> {
    const threadId = state.seed.id;
    if (sub === "send") {
      const body = sendMessageRequestSchema.safeParse(await readJson(request));
      if (!body.success) return badRequest(body.error);
      this.appendTurn(state, promptText(body.data.input), now);
      return json({ ok: true });
    }
    if (sub === "read") {
      return json(threadResponse(this.view(state, now), now));
    }
    if (sub === "stop") {
      const pending = state.turns.find((turn) => this.replyPending(turn, now));
      if (pending) {
        pending.sentAt = now - REPLY_DELAY_MS;
        this.emit(threadId, ["events-appended", "status-changed"]);
      }
      return json({ ok: true });
    }
    if (sub === "queued-messages") {
      const body = createQueuedMessageRequestSchema.safeParse(
        await readJson(request),
      );
      if (!body.success) return badRequest(body.error);
      const message = queuedMessage({
        id: `qm_demo${this.nextQueuedId++}`,
        threadId,
        content: body.data.input,
        now,
      });
      this.queued.set(threadId, [...this.queuedFor(threadId), message]);
      this.emit(threadId, ["queue-changed"]);
      return json(message);
    }
    const sendQueued = /^queued-messages\/([a-z0-9_]+)\/send$/u.exec(sub);
    if (sendQueued) {
      const body = sendQueuedMessageRequestSchema.safeParse(
        await readJson(request),
      );
      if (!body.success) return badRequest(body.error);
      const queuedMessageId = sendQueued[1];
      const message = this.queuedFor(threadId).find(
        (entry) => entry.id === queuedMessageId,
      );
      if (!message) {
        return json({ message: "Queued message not found" }, 404);
      }
      this.queued.set(
        threadId,
        this.queuedFor(threadId).filter(
          (entry) => entry.id !== queuedMessageId,
        ),
      );
      this.emit(threadId, ["queue-changed"]);
      this.appendTurn(state, promptText(message.content), now);
      return json({
        ok: true,
        delivery: "sent",
      } satisfies SendQueuedMessageResponse);
    }
    return null;
  }

  private async handleUpdateTabs(request: Request): Promise<Response> {
    const body = updateThreadTabsRequestSchema.safeParse(
      await readJson(request),
    );
    if (!body.success) return badRequest(body.error);
    const response: ThreadTabsResponse = {
      revision: body.data.expectedRevision + 1,
      tabs: body.data.tabs,
    };
    return json(response);
  }

  private systemConfig(origin: string): SystemConfigResponse {
    return { ...SYSTEM_CONFIG, serverUrl: origin };
  }

  private views(now: number): DemoThreadView[] {
    return [...this.threads.values()].map((state) => this.view(state, now));
  }

  private view(state: ThreadState, now: number): DemoThreadView {
    const last = state.turns.at(-1);
    return {
      seed: state.seed,
      busy: last !== undefined && this.replyPending(last, now),
      updatedAt: last?.sentAt ?? seedUpdatedAt(state.seed, now),
    };
  }

  private replyPending(turn: SentTurn, now: number): boolean {
    return now < turn.sentAt + REPLY_DELAY_MS;
  }

  private queuedFor(threadId: string): ThreadQueuedMessage[] {
    return this.queued.get(threadId) ?? [];
  }

  private timeline(state: ThreadState, now: number): ThreadTimelineResponse {
    const threadId = state.seed.id;
    const rows = state.seed.rows(threadId, seedStartedAt(state.seed, now));
    let seq = rows.length;
    for (const [index, turn] of state.turns.entries()) {
      const turnId = `${threadId}-sent-${index + 1}`;
      rows.push(
        conversationRow({
          threadId,
          turnId,
          seq: ++seq,
          at: turn.sentAt,
          role: "user",
          text: turn.text,
        }),
      );
      if (this.replyPending(turn, now)) continue;
      rows.push(
        commandRow({
          threadId,
          turnId,
          seq: ++seq,
          at: turn.sentAt + 400,
          ...DEMO_REPLY_COMMAND,
        }),
        conversationRow({
          threadId,
          turnId,
          seq: ++seq,
          at: turn.sentAt + REPLY_DELAY_MS,
          role: "assistant",
          text: DEMO_REPLY,
        }),
      );
    }
    return {
      rows,
      contextBoundarySeq: null,
      maxSeq: seq,
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos: null,
      goal: null,
      modelFallback: null,
      contextWindowUsage: {
        estimated: false,
        modelContextWindow: 258_400,
        usedTokens: 12_400,
      },
      timelinePage: {
        kind: "latest",
        segmentLimit: 20,
        returnedSegmentCount: 1,
        hasOlderRows: false,
        olderCursor: null,
      },
    };
  }

  private appendTurn(state: ThreadState, text: string, now: number): void {
    state.turns.push({ text, sentAt: now });
    if (state.turns.length > MAX_TURNS_PER_THREAD) {
      state.turns.splice(0, state.turns.length - MAX_TURNS_PER_THREAD);
    }
    const threadId = state.seed.id;
    this.emit(threadId, ["events-appended", "status-changed"]);
    this.schedule(() => {
      this.emit(threadId, ["events-appended", "status-changed"]);
    }, REPLY_DELAY_MS);
  }

  private emit(
    threadId: string,
    changes: ThreadChangedMessage["changes"],
  ): void {
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id: threadId,
      changes,
    };
    for (const listener of this.listeners) listener(message);
  }
}
