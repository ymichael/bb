// Bridge protocol between the bb app frontend and a STATUS.html iframe rendered
// inside the manager-thread storage panel. The iframe sends `bb-status:tell`
// requests; the app forwards each one as a new user turn in the manager
// thread, then posts a `bb-status:tell-result` reply back to the iframe.
//
// The bridge is intentionally narrow: it does not write files, expose tool
// access, or echo manager output. The manager itself decides how to react to
// the incoming message — typically by editing STATUS.html or spawning work.

export const BB_STATUS_TELL_MESSAGE_TYPE = "bb-status:tell" as const;
export const BB_STATUS_TELL_RESULT_MESSAGE_TYPE = "bb-status:tell-result" as const;
export const BB_STATUS_TELL_MAX_BYTES = 4096;

export interface BbStatusTellMessage {
  id: number | null;
  text: string;
}

export type BbStatusTellParseResult =
  | { ok: true; message: BbStatusTellMessage }
  | { ok: false; id: number | null; error: string };

export interface BbStatusTellResultPayload {
  type: typeof BB_STATUS_TELL_RESULT_MESSAGE_TYPE;
  id: number | null;
  ok: boolean;
  error?: string;
}

export interface BbStatusTellRequest {
  threadId: string;
  text: string;
}

export type BbStatusTellSender = (request: BbStatusTellRequest) => Promise<void>;

export interface HandleBbStatusMessageArgs {
  data: unknown;
  replyTo: Window;
  threadId: string | null;
  send: BbStatusTellSender;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isBbStatusTellEnvelope(data: unknown): boolean {
  return isObject(data) && data.type === BB_STATUS_TELL_MESSAGE_TYPE;
}

export function parseBbStatusTellMessage(data: unknown): BbStatusTellParseResult {
  if (!isObject(data) || data.type !== BB_STATUS_TELL_MESSAGE_TYPE) {
    return { ok: false, id: null, error: "Not a bb-status:tell message" };
  }
  const rawId = data.id;
  const id =
    typeof rawId === "number" && Number.isInteger(rawId) ? rawId : null;
  const text = data.text;
  if (typeof text !== "string") {
    return { ok: false, id, error: "Message text must be a string" };
  }
  if (text.length === 0) {
    return { ok: false, id, error: "Message text must not be empty" };
  }
  if (utf8ByteLength(text) > BB_STATUS_TELL_MAX_BYTES) {
    return {
      ok: false,
      id,
      error: `Message exceeds ${BB_STATUS_TELL_MAX_BYTES}-byte limit`,
    };
  }
  return { ok: true, message: { id, text } };
}

export function buildBbStatusTellResult(args: {
  id: number | null;
  ok: true;
}): BbStatusTellResultPayload;
export function buildBbStatusTellResult(args: {
  id: number | null;
  ok: false;
  error: string;
}): BbStatusTellResultPayload;
export function buildBbStatusTellResult(args: {
  id: number | null;
  ok: boolean;
  error?: string;
}): BbStatusTellResultPayload {
  if (args.ok) {
    return {
      type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
      id: args.id,
      ok: true,
    };
  }
  return {
    type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
    id: args.id,
    ok: false,
    error: args.error ?? "Unknown error",
  };
}

export async function handleBbStatusMessage(
  args: HandleBbStatusMessageArgs,
): Promise<void> {
  const { data, replyTo, threadId, send } = args;
  if (!isBbStatusTellEnvelope(data)) return;
  const parsed = parseBbStatusTellMessage(data);
  if (!parsed.ok) {
    postReply(
      replyTo,
      buildBbStatusTellResult({ id: parsed.id, ok: false, error: parsed.error }),
    );
    return;
  }
  if (threadId === null) {
    postReply(
      replyTo,
      buildBbStatusTellResult({
        id: parsed.message.id,
        ok: false,
        error: "No manager thread context available for STATUS.html bridge",
      }),
    );
    return;
  }
  try {
    await send({ threadId, text: parsed.message.text });
    postReply(
      replyTo,
      buildBbStatusTellResult({ id: parsed.message.id, ok: true }),
    );
  } catch (cause) {
    const error =
      cause instanceof Error ? cause.message : "Failed to deliver message";
    postReply(
      replyTo,
      buildBbStatusTellResult({ id: parsed.message.id, ok: false, error }),
    );
  }
}

function postReply(replyTo: Window, payload: BbStatusTellResultPayload): void {
  // STATUS.html is rendered via `srcdoc`, which gives the iframe an opaque
  // "null" origin. The exact-window equality check at the listener gate
  // already scopes delivery to the right iframe, so "*" is the appropriate
  // target origin here.
  replyTo.postMessage(payload, "*");
}
