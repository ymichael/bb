export const PROTOCOL_VERSION = 1;

export const TUNNEL_PROTOCOL_QUERY_PARAM = "v";

export const HEARTBEAT_REQUEST = "bbt:hb";
export const HEARTBEAT_RESPONSE = "bbt:hb-ack";

export const MAX_CHUNK_BYTES = 1024 * 1024;

const FRAME_TYPE = {
  openHttp: 1,
  bodyChunk: 2,
  bodyEnd: 3,
  respHead: 4,
  openWs: 5,
  wsOpenAck: 6,
  wsData: 7,
  closeStream: 8,
} as const;

export type HeaderPair = [name: string, value: string];

export interface OpenHttpFrame {
  type: "open-http";
  streamId: number;
  method: string;
  path: string;
  headers: HeaderPair[];
  hasBody: boolean;
  target?: string;
}

interface BodyChunkFrame {
  type: "body-chunk";
  streamId: number;
  data: Uint8Array;
}

interface BodyEndFrame {
  type: "body-end";
  streamId: number;
}

interface RespHeadFrame {
  type: "resp-head";
  streamId: number;
  status: number;
  headers: HeaderPair[];
}

export interface OpenWsFrame {
  type: "open-ws";
  streamId: number;
  path: string;
  headers: HeaderPair[];
  protocols: string[];
  target?: string;
}

interface WsOpenAckFrame {
  type: "ws-open-ack";
  streamId: number;
  protocol: string | null;
}

interface WsDataFrame {
  type: "ws-data";
  streamId: number;
  isBinary: boolean;
  data: Uint8Array;
}

interface CloseStreamFrame {
  type: "close-stream";
  streamId: number;
  code: number;
  reason: string;
}

export type Frame =
  | OpenHttpFrame
  | BodyChunkFrame
  | BodyEndFrame
  | RespHeadFrame
  | OpenWsFrame
  | WsOpenAckFrame
  | WsDataFrame
  | CloseStreamFrame;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function withHeader(
  type: number,
  streamId: number,
  payload: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new Error(`tunnel-contract: stream id out of range: ${streamId}`);
  }
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId);
  out.set(payload, 5);
  return out;
}

function jsonPayload(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case "open-http":
      return withHeader(
        FRAME_TYPE.openHttp,
        frame.streamId,
        jsonPayload({
          method: frame.method,
          path: frame.path,
          headers: frame.headers,
          hasBody: frame.hasBody,
          ...(frame.target !== undefined ? { target: frame.target } : {}),
        }),
      );
    case "body-chunk": {
      if (frame.data.length > MAX_CHUNK_BYTES) {
        throw new Error(
          `tunnel-contract: body chunk of ${frame.data.length} bytes exceeds MAX_CHUNK_BYTES`,
        );
      }
      return withHeader(FRAME_TYPE.bodyChunk, frame.streamId, frame.data);
    }
    case "body-end":
      return withHeader(FRAME_TYPE.bodyEnd, frame.streamId, new Uint8Array(0));
    case "resp-head":
      return withHeader(
        FRAME_TYPE.respHead,
        frame.streamId,
        jsonPayload({ status: frame.status, headers: frame.headers }),
      );
    case "open-ws":
      return withHeader(
        FRAME_TYPE.openWs,
        frame.streamId,
        jsonPayload({
          path: frame.path,
          headers: frame.headers,
          protocols: frame.protocols,
          ...(frame.target !== undefined ? { target: frame.target } : {}),
        }),
      );
    case "ws-open-ack":
      return withHeader(
        FRAME_TYPE.wsOpenAck,
        frame.streamId,
        jsonPayload({ protocol: frame.protocol }),
      );
    case "ws-data": {
      const payload = new Uint8Array(1 + frame.data.length);
      payload[0] = frame.isBinary ? 1 : 0;
      payload.set(frame.data, 1);
      return withHeader(FRAME_TYPE.wsData, frame.streamId, payload);
    }
    case "close-stream":
      return withHeader(
        FRAME_TYPE.closeStream,
        frame.streamId,
        jsonPayload({ code: frame.code, reason: frame.reason }),
      );
  }
}

function parseJson<T>(payload: Uint8Array, what: string): T {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw new Error(`tunnel-contract: malformed ${what} frame payload`);
  }
}

export function decodeFrame(message: ArrayBuffer | Uint8Array): Frame {
  const buf = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (buf.length < 5) {
    throw new Error(`tunnel-contract: frame too short (${buf.length} bytes)`);
  }
  const type = buf[0];
  const streamId = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
  const payload = buf.subarray(5);
  switch (type) {
    case FRAME_TYPE.openHttp: {
      const meta = parseJson<{
        method: string;
        path: string;
        headers: HeaderPair[];
        hasBody: boolean;
        target?: unknown;
      }>(payload, "open-http");
      return {
        type: "open-http",
        streamId,
        method: meta.method,
        path: meta.path,
        headers: meta.headers,
        hasBody: meta.hasBody,
        ...(typeof meta.target === "string" ? { target: meta.target } : {}),
      };
    }
    case FRAME_TYPE.bodyChunk:
      return { type: "body-chunk", streamId, data: payload };
    case FRAME_TYPE.bodyEnd:
      return { type: "body-end", streamId };
    case FRAME_TYPE.respHead: {
      const meta = parseJson<{ status: number; headers: HeaderPair[] }>(
        payload,
        "resp-head",
      );
      return { type: "resp-head", streamId, ...meta };
    }
    case FRAME_TYPE.openWs: {
      const meta = parseJson<{
        path: string;
        headers: HeaderPair[];
        protocols: string[];
        target?: unknown;
      }>(payload, "open-ws");
      return {
        type: "open-ws",
        streamId,
        path: meta.path,
        headers: meta.headers,
        protocols: meta.protocols,
        ...(typeof meta.target === "string" ? { target: meta.target } : {}),
      };
    }
    case FRAME_TYPE.wsOpenAck: {
      const meta = parseJson<{ protocol: string | null }>(
        payload,
        "ws-open-ack",
      );
      return { type: "ws-open-ack", streamId, protocol: meta.protocol };
    }
    case FRAME_TYPE.wsData: {
      if (payload.length < 1) {
        throw new Error("tunnel-contract: ws-data frame missing binary flag");
      }
      return {
        type: "ws-data",
        streamId,
        isBinary: payload[0] === 1,
        data: payload.subarray(1),
      };
    }
    case FRAME_TYPE.closeStream: {
      const meta = parseJson<{ code: number; reason: string }>(
        payload,
        "close-stream",
      );
      return { type: "close-stream", streamId, ...meta };
    }
    default:
      throw new Error(`tunnel-contract: unknown frame type ${type}`);
  }
}

export function* chunkBody(
  streamId: number,
  data: Uint8Array,
): Generator<BodyChunkFrame> {
  for (let offset = 0; offset < data.length; offset += MAX_CHUNK_BYTES) {
    yield {
      type: "body-chunk",
      streamId,
      data: data.subarray(
        offset,
        Math.min(offset + MAX_CHUNK_BYTES, data.length),
      ),
    };
  }
}
