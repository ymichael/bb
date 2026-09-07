import { describe, expect, it, vi } from "vitest";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { seedHostSession, seedPrimaryHost } from "../../helpers/seed.js";
import {
  installTestBuiltinPlugin,
  startTestServer,
} from "../../helpers/test-app.js";

describe("builtin Keep Awake plugin", () => {
  it("owns its configuration and reconciles it without a core adapter", async () => {
    const server = await startTestServer();
    try {
      const { host, session } = seedHostSession(server.deps);
      seedPrimaryHost(server.deps, host.id);
      const responder = registerHostRpcResponder(server, {
        hostId: host.id,
        sessionId: session.id,
        handle(request) {
          if (request.command.type !== "plugin.host.call") {
            throw new Error(`unexpected command ${request.command.type}`);
          }
          const input = request.command.input;
          if (typeof input !== "object" || input === null) {
            throw new Error("expected host RPC input object");
          }
          const enabled = Reflect.get(input, "enabled");
          if (typeof enabled !== "boolean") {
            throw new Error("expected host RPC enabled boolean");
          }
          return {
            ok: true,
            result: { output: { enabled, supported: true } },
          };
        },
      });

      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      await installTestBuiltinPlugin(server, "keep-awake");

      await vi.waitFor(() => expect(responder.requests).toHaveLength(1));
      expect(responder.requests[0]?.command).toMatchObject({
        type: "plugin.host.call",
        pluginId: "keep-awake",
        method: "setEnabled",
        input: { enabled: false },
      });

      const response = await server.app.request(
        "/api/v1/plugins/keep-awake/rpc/setConfiguration",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: true,
            selection: { mode: "all" },
          }),
        },
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(responder.requests).toHaveLength(2));
      expect(responder.requests[1]?.command).toMatchObject({
        type: "plugin.host.call",
        pluginId: "keep-awake",
        method: "setEnabled",
        input: { enabled: true },
      });
    } finally {
      await server.pluginService.stop();
      await server.close();
    }
  }, 30_000);
});
