import { authApiKeys, closeSession, getHost } from "@bb/db";
import { eq } from "drizzle-orm";
import { hostDaemonEnrollResponseSchema } from "@bb/host-daemon-contract";
import { createHostJoinResponseSchema } from "@bb/server-contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorToResponse } from "../src/errors.js";
import { TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY } from "../src/request-context.js";
import { registerHostRoutes } from "../src/routes/hosts.js";
import type { AppDeps } from "../src/types.js";
import { readJson } from "./helpers/json.js";
import { seedSession } from "./helpers/seed.js";
import { createTestAppHarness, testLogger } from "./helpers/test-app.js";

interface CreateHostRouteAppArgs {
  deps: AppDeps;
  trustedRemoteAddress: string | undefined;
}

async function parseHostJoinResponse(response: Response) {
  return createHostJoinResponseSchema.parse(await readJson(response));
}

function createHostRouteApp(args: CreateHostRouteAppArgs): Hono {
  const app = new Hono();
  app.onError((error) => errorToResponse(error, testLogger));
  app.use("*", async (context, next) => {
    context.set(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY, args.trustedRemoteAddress);
    await next();
  });
  registerHostRoutes(app, args.deps);
  return app;
}

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
      const body = await parseHostJoinResponse(response);
      expect(body.hostId).toMatch(/^host_/u);
      expect(body.joinCode).toMatch(/^bbde_/u);
      expect(body.joinCommand).toContain("npx bb-app");
      expect(body.joinCommand).toContain("host-daemon");
      expect(body.joinCommand).toContain(
        "--server-url 'https://bb.example.test'",
      );
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

  it("creates local auto-join material without BB_APP_URL", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });
    const app = createHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "127.0.0.1",
    });

    try {
      const response = await app.request(
        "http://spoofed.example.test/hosts/join",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host_local_auto_join",
            hostType: "persistent",
            joinMode: "local",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = await parseHostJoinResponse(response);
      expect(body.hostId).toBe("host_local_auto_join");
      expect(body.joinCode).toMatch(/^bbde_/u);
      expect(body.joinCommand).toContain(
        "--server-url 'http://127.0.0.1:3334'",
      );
      expect(getHost(harness.db, "host_local_auto_join")).toMatchObject({
        id: "host_local_auto_join",
        type: "persistent",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects join with app_url_required and no side effects when BB_APP_URL is unset", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });

    try {
      const response = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_app_url_required",
          hostType: "persistent",
        }),
      });

      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        code: "app_url_required",
      });
      expect(getHost(harness.db, "host_app_url_required")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects spoofed Host loopback for local join without BB_APP_URL", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });
    const app = createHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "192.168.1.50",
    });

    try {
      const response = await app.request("http://127.0.0.1:3334/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3334",
        },
        body: JSON.stringify({
          hostId: "host_spoofed_local_join",
          hostType: "persistent",
          joinMode: "local",
        }),
      });

      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        code: "app_url_required",
      });
      expect(getHost(harness.db, "host_spoofed_local_join")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("uses BB_APP_URL for non-loopback local join requests when configured", async () => {
    const harness = await createTestAppHarness();
    const app = createHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "192.168.1.50",
    });

    try {
      const response = await app.request("http://127.0.0.1:3334/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3334",
        },
        body: JSON.stringify({
          hostId: "host_remote_local_join",
          hostType: "persistent",
          joinMode: "local",
        }),
      });

      expect(response.status).toBe(201);
      const body = await parseHostJoinResponse(response);
      expect(body.joinCommand).toContain(
        "--server-url 'https://bb.example.test'",
      );
      expect(getHost(harness.db, "host_remote_local_join")).toMatchObject({
        id: "host_remote_local_join",
        type: "persistent",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("cancels pending host joins by revoking the enroll key and deleting the unconnected stub", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_cancel_pending_join",
          hostType: "persistent",
        }),
      });
      const joinBody = await parseHostJoinResponse(joinResponse);

      const cancelResponse = await harness.app.request(
        `/api/v1/hosts/${joinBody.hostId}/join`,
        {
          method: "DELETE",
        },
      );

      expect(cancelResponse.status).toBe(200);
      expect(await readJson(cancelResponse)).toEqual({ ok: true });
      expect(getHost(harness.db, joinBody.hostId)).toBeNull();

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${joinBody.joinCode}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: joinBody.hostId,
            hostName: "canceled-host",
            hostType: "persistent",
          }),
        },
      );

      expect(enrollResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps hosts that have connected when canceling outstanding join material", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_cancel_connected_join",
          hostType: "persistent",
        }),
      });
      const joinBody = await parseHostJoinResponse(joinResponse);
      const session = seedSession(harness.deps, joinBody.hostId);
      closeSession(harness.db, harness.hub, session.id, "test-disconnect");

      const cancelResponse = await harness.app.request(
        `/api/v1/hosts/${joinBody.hostId}/join`,
        {
          method: "DELETE",
        },
      );

      expect(cancelResponse.status).toBe(200);
      expect(getHost(harness.db, joinBody.hostId)).toMatchObject({
        id: joinBody.hostId,
        type: "persistent",
      });

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${joinBody.joinCode}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: joinBody.hostId,
            hostName: "canceled-connected-host",
            hostType: "persistent",
          }),
        },
      );

      expect(enrollResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps active hosts when canceling outstanding join material", async () => {
    const harness = await createTestAppHarness();

    try {
      const joinResponse = await harness.app.request("/api/v1/hosts/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_cancel_active_join",
          hostType: "persistent",
        }),
      });
      const joinBody = await parseHostJoinResponse(joinResponse);
      seedSession(harness.deps, joinBody.hostId);

      const cancelResponse = await harness.app.request(
        `/api/v1/hosts/${joinBody.hostId}/join`,
        {
          method: "DELETE",
        },
      );

      expect(cancelResponse.status).toBe(200);
      expect(getHost(harness.db, joinBody.hostId)).toMatchObject({
        id: joinBody.hostId,
        type: "persistent",
      });

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${joinBody.joinCode}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: joinBody.hostId,
            hostName: "canceled-active-host",
            hostType: "persistent",
          }),
        },
      );

      expect(enrollResponse.status).toBe(401);
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
      const joinBody = await parseHostJoinResponse(joinResponse);

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
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
        },
      );

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

      const replayResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
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
        },
      );

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
      const joinBody = await parseHostJoinResponse(joinResponse);

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
      const firstJoinResponse = await harness.app.request(
        "/api/v1/hosts/join",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host_reissue_join",
            hostType: "persistent",
          }),
        },
      );
      const firstJoinBody = await parseHostJoinResponse(firstJoinResponse);

      const secondJoinResponse = await harness.app.request(
        "/api/v1/hosts/join",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host_reissue_join",
            hostType: "persistent",
          }),
        },
      );
      const secondJoinBody = await parseHostJoinResponse(secondJoinResponse);

      expect(secondJoinBody.joinCode).not.toBe(firstJoinBody.joinCode);

      const firstEnrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
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
        },
      );

      expect(firstEnrollResponse.status).toBe(401);

      const secondEnrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
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
        },
      );

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
      const joinBody = await parseHostJoinResponse(joinResponse);

      const issuedKey = harness.db
        .select({
          expiresAt: authApiKeys.expiresAt,
          id: authApiKeys.id,
        })
        .from(authApiKeys)
        .where(eq(authApiKeys.configId, "daemon-enroll"))
        .get();

      expect(issuedKey?.id).toBeTruthy();
      expect(issuedKey?.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());

      await harness.db
        .update(authApiKeys)
        .set({
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(eq(authApiKeys.id, issuedKey?.id ?? ""))
        .run();

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
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
        },
      );

      expect(enrollResponse.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });
});
