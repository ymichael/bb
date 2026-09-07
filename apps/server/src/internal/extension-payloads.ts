import { getThread } from "@bb/db";
import type { ExtensionKind, JsonValue, ThreadEvent } from "@bb/domain";
import { parseExtensionKind } from "@bb/domain";
import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "@get-bb/plugin-sdk";
import type { AppDeps } from "../types.js";

export const EXTENSION_PAYLOAD_MAX_BYTES = 64 * 1024;

export type ExtensionPayloadValidationDeps = Pick<
  AppDeps,
  "db" | "logger" | "providerRegistry"
>;

interface ExtensionPayloadSite {
  surface: "item" | "state";
  kind: ExtensionKind;
  payload: JsonValue;
  eventType: ThreadEvent["type"];
  threadId: string;
  providerThreadId: string;
  scope: ThreadEvent["scope"];
  parentToolCallId: string | undefined;
}

function extensionSiteOf(event: ThreadEvent): ExtensionPayloadSite | null {
  switch (event.type) {
    case "item/started":
    case "item/completed":
      return event.item.type === "extension"
        ? {
            surface: "item",
            kind: event.item.kind,
            payload: event.item.payload,
            eventType: event.type,
            threadId: event.threadId,
            providerThreadId: event.providerThreadId,
            scope: event.scope,
            parentToolCallId: event.item.parentToolCallId,
          }
        : null;
    case "thread/extensionState/updated":
      return {
        surface: "state",
        kind: event.kind,
        payload: event.payload,
        eventType: event.type,
        threadId: event.threadId,
        providerThreadId: event.providerThreadId,
        scope: event.scope,
        parentToolCallId: undefined,
      };
    default:
      return null;
  }
}

type ValidationOutcome = { ok: true } | { ok: false; reason: string };

function issuePathSegments(path: StandardSchemaV1Issue["path"]): string[] {
  if (path === undefined) {
    return [];
  }
  if (!Array.isArray(path)) {
    return [String(path)];
  }
  return path.map((segment) =>
    typeof segment === "object" && segment !== null
      ? String(segment.key)
      : String(segment),
  );
}

async function validateAgainstSchema(
  schema: StandardSchemaV1,
  payload: JsonValue,
): Promise<ValidationOutcome> {
  let result: StandardSchemaV1Result<unknown>;
  try {
    result = await schema["~standard"].validate(payload);
  } catch (error) {
    return {
      ok: false,
      reason: `validator threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.issues !== undefined) {
    return {
      ok: false,
      reason: result.issues
        .map((issue) => {
          const path = issuePathSegments(issue.path).join(".");
          return path === "" ? issue.message : `${path}: ${issue.message}`;
        })
        .join("; "),
    };
  }
  return { ok: true };
}

function extensionOwnershipProblem(
  deps: ExtensionPayloadValidationDeps,
  site: ExtensionPayloadSite,
  providerId: string | null,
): string | null {
  const { pluginId } = parseExtensionKind(site.kind);
  const registration =
    providerId === null ? null : deps.providerRegistry.get(providerId);
  if (registration === null) {
    const provider =
      providerId === null
        ? "the thread's provider"
        : `the thread's provider "${providerId}"`;
    return `extension kind "${site.kind}" names plugin "${pluginId}", but ${provider} has no live registration to check it against`;
  }
  if (registration.pluginId !== pluginId) {
    return `extension kind "${site.kind}" is owned by plugin "${pluginId}", but the thread's provider "${providerId}" is registered by plugin "${registration.pluginId}"`;
  }
  return null;
}

async function validateSite(
  deps: ExtensionPayloadValidationDeps,
  site: ExtensionPayloadSite,
  providerId: string | null,
): Promise<ValidationOutcome> {
  const ownership = extensionOwnershipProblem(deps, site, providerId);
  if (ownership !== null) {
    return { ok: false, reason: ownership };
  }
  const declared = deps.providerRegistry.getExtensionKindSchemas(site.kind);
  const schema = declared?.[site.surface];
  if (schema === undefined) {
    const { pluginId, name } = parseExtensionKind(site.kind);
    return {
      ok: false,
      reason:
        declared === null
          ? `plugin "${pluginId}" declares no extension kind "${name}"`
          : `plugin "${pluginId}" declares extension kind "${name}" with no ${site.surface} schema`,
    };
  }
  const bytes = Buffer.byteLength(JSON.stringify(site.payload));
  if (bytes > EXTENSION_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      reason: `payload is ${bytes} bytes; the limit is ${EXTENSION_PAYLOAD_MAX_BYTES}`,
    };
  }
  return validateAgainstSchema(schema, site.payload);
}

function toUnhandledEvent(
  site: ExtensionPayloadSite,
  providerId: string | null,
  reason: string,
): ThreadEvent {
  return {
    type: "provider/unhandled",
    threadId: site.threadId,
    providerThreadId: site.providerThreadId,
    providerId: providerId ?? parseExtensionKind(site.kind).pluginId,
    rawType: `extension/${site.surface}:${site.kind}`,
    rawEvent: {
      jsonrpc: "2.0",
      method: site.eventType,
      params: { kind: site.kind, payload: site.payload, reason },
    },
    scope: site.scope,
    ...(site.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: site.parentToolCallId }),
  };
}

export async function validateExtensionPayloads(
  deps: ExtensionPayloadValidationDeps,
  envelopes: readonly HostDaemonEventEnvelope[],
): Promise<HostDaemonEventEnvelope[]> {
  return Promise.all(
    envelopes.map(async (envelope) => {
      const site = extensionSiteOf(envelope.event);
      if (site === null) {
        return envelope;
      }
      const providerId = getThread(deps.db, site.threadId)?.providerId ?? null;
      const outcome = await validateSite(deps, site, providerId);
      if (outcome.ok) {
        return envelope;
      }
      deps.logger.warn(
        {
          threadId: envelope.threadId,
          eventType: envelope.event.type,
          extensionKind: site.kind,
          surface: site.surface,
          reason: outcome.reason,
        },
        "Rejected provider extension payload at ingest",
      );
      return {
        ...envelope,
        event: toUnhandledEvent(site, providerId, outcome.reason),
      };
    }),
  );
}
