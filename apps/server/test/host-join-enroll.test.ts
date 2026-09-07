import { authApiKeys, getHost } from "@bb/db";
import { eq } from "drizzle-orm";
import {
  hostDaemonEnrollKeyResponseSchema,
  hostDaemonEnrollResponseSchema,
  type HostDaemonEnrollKeyResponse,
} from "@bb/host-daemon-contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorToResponse } from "../src/errors.js";
import { TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY } from "../src/request-context.js";
import { registerInternalHostRoutes } from "../src/internal/hosts.js";
import type { AppDeps } from "../src/types.js";
import { readJson } from "./helpers/json.js";
import {
  createTestAppHarness,
  testLogger,
  withTestHarness,
} from "./helpers/test-app.js";

interface CreateHostRouteAppArgs {
  deps: AppDeps;
  trustedRemoteAddress: string | undefined;
}

async function parseHostEnrollKeyResponse(response: Response) {
  return hostDaemonEnrollKeyResponseSchema.parse(await readJson(response));
}

function createInternalHostRouteApp(args: CreateHostRouteAppArgs): Hono {
  const app = new Hono();
  app.onError((error) => errorToResponse(error, testLogger));
  app.use("*", async (context, next) => {
    context.set(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY, args.trustedRemoteAddress);
    await next();
  });
  registerInternalHostRoutes(app, args.deps);
  return app;
}

async function requestHostEnrollKey(
  deps: AppDeps,
  hostId: string,
): Promise<HostDaemonEnrollKeyResponse> {
  const app = createInternalHostRouteApp({
    deps,
    trustedRemoteAddress: "127.0.0.1",
  });
  const response = await app.request("/hosts/enroll-key", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ hostId }),
  });

  expect(response.status).toBe(201);
  return parseHostEnrollKeyResponse(response);
}

describe("host enroll routes", () => {
  it("creates local enroll-key material without BB_APP_URL", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });
    const app = createInternalHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "127.0.0.1",
    });

    try {
      const response = await app.request("/hosts/enroll-key", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_local_enroll_key",
        }),
      });

      expect(response.status).toBe(201);
      const body = await parseHostEnrollKeyResponse(response);
      expect(body.hostId).toBe("host_local_enroll_key");
      expect(body.enrollKey).toMatch(/^bbde_/u);
      expect(getHost(harness.db, "host_local_enroll_key")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects non-loopback enroll-key requests without side effects", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });
    const app = createInternalHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "192.168.1.50",
    });

    try {
      const response = await app.request("/hosts/enroll-key", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_remote_enroll_key",
        }),
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "unsupported_host",
      });
      expect(getHost(harness.db, "host_remote_enroll_key")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects machine-gated enroll-key requests even from loopback", async () => {
    const harness = await createTestAppHarness({ appUrl: undefined });
    const app = createInternalHostRouteApp({
      deps: harness.deps,
      trustedRemoteAddress: "127.0.0.1",
    });
    try {
      const response = await app.request("/hosts/enroll-key", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-gate-auth": "machine",
        },
        body: JSON.stringify({ hostId: "host_forbidden_machine" }),
      });
      expect(response.status).toBe(403);
      expect(await readJson(response)).toMatchObject({
        code: "machine_host_management_forbidden",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("exchanges enroll-key material for a daemon host key exactly once", async () => {
    await withTestHarness(async (harness) => {
      const enrollKeyBody = await requestHostEnrollKey(
        harness.deps,
        "host_enroll_once",
      );

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${enrollKeyBody.enrollKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: enrollKeyBody.hostId,
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
        hostId: enrollKeyBody.hostId,
      });
      expect(enrollBody.hostKey).toMatch(/^bbdh_/u);
      expect(getHost(harness.db, enrollKeyBody.hostId)).toMatchObject({
        id: enrollKeyBody.hostId,
        name: "real-host-name",
      });

      const replayResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${enrollKeyBody.enrollKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: enrollKeyBody.hostId,
            hostName: "real-host-name",
            hostType: "persistent",
          }),
        },
      );

      expect(replayResponse.status).toBe(401);
    });
  });

  it("rejects enrollment when the enroll key is presented for a different host", async () => {
    await withTestHarness(async (harness) => {
      const enrollKeyBody = await requestHostEnrollKey(
        harness.deps,
        "host_expected",
      );

      const response = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${enrollKeyBody.enrollKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host_other",
          hostName: "wrong-host",
          hostType: "persistent",
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  it("invalidates older enroll keys when the same host requests a new one", async () => {
    await withTestHarness(async (harness) => {
      const firstEnrollKeyBody = await requestHostEnrollKey(
        harness.deps,
        "host_reissue_enroll_key",
      );
      const secondEnrollKeyBody = await requestHostEnrollKey(
        harness.deps,
        "host_reissue_enroll_key",
      );

      expect(secondEnrollKeyBody.enrollKey).not.toBe(
        firstEnrollKeyBody.enrollKey,
      );

      const firstEnrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${firstEnrollKeyBody.enrollKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: firstEnrollKeyBody.hostId,
            hostName: "stale-enroll-key-host",
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
            authorization: `Bearer ${secondEnrollKeyBody.enrollKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: secondEnrollKeyBody.hostId,
            hostName: "fresh-enroll-key-host",
            hostType: "persistent",
          }),
        },
      );

      expect(secondEnrollResponse.status).toBe(201);
    });
  });

  it("rejects enrollment after the enroll key expires", async () => {
    await withTestHarness(async (harness) => {
      const enrollKeyBody = await requestHostEnrollKey(
        harness.deps,
        "host_expired_enroll_key",
      );

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
            authorization: `Bearer ${enrollKeyBody.enrollKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: enrollKeyBody.hostId,
            hostName: "expired-host",
            hostType: "persistent",
          }),
        },
      );

      expect(enrollResponse.status).toBe(401);
    });
  });
});
