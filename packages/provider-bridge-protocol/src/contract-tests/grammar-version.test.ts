import { describe, expect, it } from "vitest";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  bridgeCapabilitiesSchema,
  deltaItemShapeSchema,
  deltaPresentationSchema,
  providerRecoveryNotificationSchema,
  threadDeltaSchema,
} from "../index.js";
import type { z } from "zod";
import {
  zodLiteralValue,
  zodObjectFields,
  zodObjectShape,
  zodUnionOptions,
  type ZodFieldPresence,
} from "./zod-shape.js";

function fieldsByDiscriminator(
  union: z.ZodType,
  discriminator: string,
): Record<string, Record<string, ZodFieldPresence>> {
  const entries = zodUnionOptions(union).map((option) => {
    const fields = zodObjectFields(option);
    const discriminatorSchema = zodObjectShape(option)[discriminator];
    const value = discriminatorSchema
      ? zodLiteralValue(discriminatorSchema)
      : undefined;
    if (typeof value !== "string") {
      throw new Error(
        `union member without a string "${discriminator}" literal: ${JSON.stringify(Object.keys(fields))}`,
      );
    }
    return [value, fields] as const;
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

describe("guardrail G3: delta grammar shape is paired with the protocol version", () => {
  it("matches the committed grammar snapshot", async () => {
    const grammar = {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      deltaKinds: fieldsByDiscriminator(threadDeltaSchema, "kind"),
      itemShapes: fieldsByDiscriminator(deltaItemShapeSchema, "type"),
      presentation: zodObjectFields(deltaPresentationSchema),
      capabilities: zodObjectFields(bridgeCapabilitiesSchema),
      recoveryNotification: zodObjectFields(providerRecoveryNotificationSchema),
      requestMethods: Object.values(BRIDGE_REQUEST_METHODS).sort(),
      notificationMethods: Object.values(BRIDGE_NOTIFICATION_METHODS).sort(),
      inboundRequestMethods: Object.values(
        BRIDGE_INBOUND_REQUEST_METHODS,
      ).sort(),
    };
    await expect(`${JSON.stringify(grammar, null, 2)}\n`).toMatchFileSnapshot(
      `./provider-bridge-grammar.v${PROVIDER_BRIDGE_PROTOCOL_VERSION}.snapshot.json`,
    );
  });

  it("keeps the protocol at version 2 while v3 is additive", () => {
    expect(PROVIDER_BRIDGE_PROTOCOL_VERSION).toBe(2);
  });
});
