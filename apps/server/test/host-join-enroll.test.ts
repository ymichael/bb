import { authApiKeys, getHost } from "@bb/db";
import { eq } from "drizzle-orm";
import {
  hostDaemonEnrollResponseSchema,
} from "@bb/host-daemon-contract";
import {
  createHostJoinResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "./helpers/json.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("host join and enroll routes", () => {
  it("creates join material for an additional host", async () => {
    const harness = await createTestAppHarness();

    try {
      const response = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostType: "persistent",
        }),
      });

      expect(response.status).toBe(201);
      const body = createHostJoinResponseSchema.parse(await readJson(response));
      expect(body.hostId).toMatch(/^host_/u);
      expect(body.joinCode).toMatch(/^bbde_/u);
      expect(body.joinCommand).toContain("pnpm start:host-daemon");
      expect(body.joinCommand).toContain(body.hostId);
      expect(body.joinCommand).toContain(body.joinCode);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(getHost(harness.db, body.hostId)).toMatchObject({
        id: body.hostId,
        type: "persistent",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("exchanges join material for a daemon host key exactly once", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_join_once",
          hostType: "persistent",
        }),
      });
      const joinBody = createHostJoinResponseSchema.parse(
        await readJson(joinResponse),
      );

      const enrollResponse = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${joinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: joinBody.hostId,
          hostName: "real-host-name",
          hostType: "persistent",
        }),
      });

      expect(enrollResponse.status).toBe(201);
      const enrollBody = hostDaemonEnrollResponseSchema.parse(
        await readJson(enrollResponse),
      );
      expect(enrollBody).toMatchObject({
        hostId: joinBody.hostId,
      });
      expect(enrollBody.hostKey).toMatch(/^bbdh_/u);
      expect(getHost(harness.db, joinBody.hostId)).toMatchObject({
        id: joinBody.hostId,
        name: "real-host-name",
      });

      const replayResponse = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${joinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: joinBody.hostId,
          hostName: "real-host-name",
          hostType: "persistent",
        }),
      });

      expect(replayResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects enrollment when the join material is presented for a different host", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_expected",
          hostType: "persistent",
        }),
      });
      const joinBody = createHostJoinResponseSchema.parse(
        await readJson(joinResponse),
      );

      const response = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${joinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_other",
          hostName: "wrong-host",
          hostType: "persistent",
        }),
      });

      expect(response.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("invalidates older join material when the same host requests a new join code", async () => {
    const harness = await createTestAppHarness();

    try {
      const firstJoinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_reissue_join",
          hostType: "persistent",
        }),
      });
      const firstJoinBody = createHostJoinResponseSchema.parse(
        await readJson(firstJoinResponse),
      );

      const secondJoinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_reissue_join",
          hostType: "persistent",
        }),
      });
      const secondJoinBody = createHostJoinResponseSchema.parse(
        await readJson(secondJoinResponse),
      );

      expect(secondJoinBody.joinCode).not.toBe(firstJoinBody.joinCode);

      const firstEnrollResponse = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstJoinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: firstJoinBody.hostId,
          hostName: "stale-join-host",
          hostType: "persistent",
        }),
      });

      expect(firstEnrollResponse.status).toBe(401);

      const secondEnrollResponse = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondJoinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: secondJoinBody.hostId,
          hostName: "fresh-join-host",
          hostType: "persistent",
        }),
      });

      expect(secondEnrollResponse.status).toBe(201);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects enrollment after the join material expires", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_expired_join",
          hostType: "persistent",
        }),
      });
      const joinBody = createHostJoinResponseSchema.parse(
        await readJson(joinResponse),
      );

      const issuedKey = harness.db
        .select({
          id: authApiKeys.id,
        })
        .from(authApiKeys)
        .where(eq(authApiKeys.configId, "daemon-enroll"))
        .get();

      expect(issuedKey?.id).toBeTruthy();

      await harness.db
        .update(authApiKeys)
        .set({
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(eq(authApiKeys.id, issuedKey?.id ?? ""))
        .run();

      const enrollResponse = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${joinBody.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: joinBody.hostId,
          hostName: "expired-host",
          hostType: "persistent",
        }),
      });

      expect(enrollResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });
});
