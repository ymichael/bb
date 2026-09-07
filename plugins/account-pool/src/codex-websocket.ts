import { z } from "zod";
import type {
  ExperimentalPluginWebSocket,
  ExperimentalPluginWebSocketContext,
  ExperimentalPluginWebSocketHandlers,
} from "@get-bb/plugin-sdk";
import type { AccountPoolHub } from "./hub.js";

const envelopeSchema = z
  .object({
    type: z.literal("response.create"),
    generate: z.boolean().optional(),
    previous_response_id: z.string().min(1).optional(),
    input: z.array(z.json()).default([]),
  })
  .passthrough();
const completedSchema = z
  .object({
    type: z.literal("response.completed"),
    response: z
      .object({ id: z.string().min(1), output: z.array(z.json()).default([]) })
      .passthrough(),
  })
  .passthrough();

interface SocketLog {
  debug(message: string): void;
}

export function createCodexWebSocketHandlers(
  context: ExperimentalPluginWebSocketContext,
  hub: AccountPoolHub,
  log: SocketLog,
): ExperimentalPluginWebSocketHandlers {
  let authenticatedHostId: string | null = null;
  let lastId: string | null = null;
  let lastInput: z.infer<typeof envelopeSchema>["input"] = [];
  let lastOutput: z.infer<typeof envelopeSchema>["input"] = [];
  let prewarms = 0;
  let closed = false;
  let activeForward: AbortController | null = null;
  let forwardQueue = Promise.resolve();

  function failure(message: string, code: string): string {
    return JSON.stringify({
      type: "response.failed",
      sequence_number: 0,
      response: { status: "failed", error: { message, code } },
    });
  }

  function send(socket: ExperimentalPluginWebSocket, data: string): boolean {
    if (socket.readyState !== 1) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  async function forward(
    socket: ExperimentalPluginWebSocket,
    raw: string,
    controller: AbortController,
  ): Promise<void> {
    const parsed = envelopeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      send(
        socket,
        failure("Invalid response.create frame.", "invalid_request"),
      );
      return;
    }
    const {
      type: _type,
      generate,
      previous_response_id: previousId,
      ...body
    } = parsed.data;
    if (previousId !== undefined) {
      if (lastId === null || previousId !== lastId) {
        send(
          socket,
          failure(
            `Unknown previous_response_id ${JSON.stringify(previousId)}; reconnect and resend full input.`,
            "unknown_previous_response_id",
          ),
        );
        socket.close(1011, "unknown previous_response_id");
        return;
      }
      body.input = [...lastInput, ...lastOutput, ...body.input];
    }
    if (generate === false) {
      prewarms += 1;
      lastId = `resp_account_pool_prewarm_${prewarms}`;
      lastInput = [...body.input];
      lastOutput = [];
      send(
        socket,
        JSON.stringify({
          type: "response.completed",
          sequence_number: 0,
          response: {
            id: lastId,
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 0,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 0,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 0,
            },
          },
        }),
      );
      return;
    }
    lastId = null;
    lastInput = [...body.input];
    lastOutput = [];
    const headers = new Headers(context.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    const response = await hub.handleAuthenticated(
      new Request("http://account-pool/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      "codex",
      authenticatedHostId,
    );
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => "");
      send(
        socket,
        failure(
          detail || `Upstream returned HTTP ${response.status}.`,
          "upstream_error",
        ),
      );
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let reachedEof = false;
    const emit = (block: string) => {
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length === 0 || data === "[DONE]") return;
      const event = JSON.parse(data);
      const completed = completedSchema.safeParse(event);
      if (completed.success) {
        lastId = completed.data.response.id;
        lastOutput = completed.data.response.output;
      }
      send(socket, JSON.stringify(event));
    };
    try {
      while (true) {
        const chunk = await reader.read();
        buffered += decoder.decode(chunk.value, { stream: !chunk.done });
        const blocks = buffered.split(/\r?\n\r?\n/u);
        buffered = blocks.pop() ?? "";
        for (const block of blocks) emit(block);
        if (chunk.done) {
          reachedEof = true;
          break;
        }
      }
      if (buffered.trim().length > 0) emit(buffered);
    } finally {
      if (!reachedEof) {
        controller.abort(
          new Error("Codex upstream response ended before reaching EOF."),
        );
        await reader.cancel().catch(() => undefined);
      }
    }
  }

  return {
    async onOpen(socket) {
      authenticatedHostId = await hub.authenticate(context.request);
      if (authenticatedHostId === null) {
        socket.close(1008, "invalid Account Pooler token");
        return;
      }
      log.debug(
        "Account Pooler Codex transport: WebSocket downstream, HTTPS SSE upstream.",
      );
    },
    async onMessage(socket, data) {
      if (authenticatedHostId === null) return;
      if (typeof data !== "string") {
        socket.close(1003, "text frames required");
        return;
      }
      forwardQueue = forwardQueue.then(async () => {
        if (closed) return;
        const controller = new AbortController();
        activeForward = controller;
        try {
          await forward(socket, data, controller);
        } catch (error) {
          if (!closed) {
            send(
              socket,
              failure(
                error instanceof Error ? error.message : String(error),
                "proxy_error",
              ),
            );
          }
        } finally {
          if (activeForward === controller) activeForward = null;
        }
      });
    },
    onClose() {
      closed = true;
      activeForward?.abort(
        new Error("Codex WebSocket closed before the response completed."),
      );
    },
  };
}
