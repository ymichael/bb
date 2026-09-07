import { describe, expect, it, vi } from "vitest";
import {
  ConnectListError,
  ConnectMachineRedeemError,
  connectPublicProtocol,
  encodeMobilePairingPayload,
  deriveConnectBaseUrl,
  listAccountServers,
  mobilePairingPayload,
  parseMobilePairingPayload,
  redeemMachineCredential,
  serverUrlForHandle,
} from "../src/index.js";

const CREDENTIAL = {
  credential: "bbcm_desktop",
  handle: "laptop",
  serverUrl: "https://laptop.getbb.app",
};

describe("connect URL helpers", () => {
  it("drops and re-adds the routing label", () => {
    expect(deriveConnectBaseUrl("https://laptop.getbb.app")).toBe(
      "https://getbb.app",
    );
    expect(serverUrlForHandle("https://getbb.app", "phone")).toBe(
      "https://phone.getbb.app",
    );
    expect(deriveConnectBaseUrl("https://laptop.bb.example:8443")).toBe(
      "https://bb.example:8443",
    );
    expect(connectPublicProtocol("bb.localhost:42745")).toBe("http:");
    expect(connectPublicProtocol("getbb.app")).toBe("https:");
  });
});

describe("listAccountServers", () => {
  it("adds a public URL per handle and reports the self handle", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            servers: [
              { handle: "laptop", name: "Laptop", live: true },
              { handle: "phone", name: "Phone", live: false },
            ],
          }),
        ),
    );

    await expect(listAccountServers(CREDENTIAL, fetchImpl)).resolves.toEqual({
      selfHandle: "laptop",
      servers: [
        {
          handle: "laptop",
          name: "Laptop",
          live: true,
          url: "https://laptop.getbb.app",
        },
        {
          handle: "phone",
          name: "Phone",
          live: false,
          url: "https://phone.getbb.app",
        },
      ],
    });
  });

  it("marks a refused credential unauthorized", async () => {
    await expect(
      listAccountServers(
        CREDENTIAL,
        async () => new Response("no", { status: 401 }),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      listAccountServers(CREDENTIAL, async () => {
        throw new Error("offline");
      }),
    ).rejects.toBeInstanceOf(ConnectListError);
  });
});

describe("redeemMachineCredential", () => {
  it("labels the credential with the target server, not the account handle", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            credential: "bbcm_desktop",
            machineId: "machine-1",
            handle: "sawyer",
            serverUrl: "https://laptop.getbb.app",
          }),
        ),
    );

    await expect(
      redeemMachineCredential(
        { apexUrl: "https://getbb.app", code: "ABCD-1234" },
        fetchImpl,
      ),
    ).resolves.toEqual(CREDENTIAL);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://getbb.app/api/connect/redeem-machine",
      expect.objectContaining({
        body: JSON.stringify({ code: "ABCD-1234" }),
        method: "POST",
      }),
    );
  });

  it("maps the gate's rejections to stable codes", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "already-used", "already_used"],
      [409, "machine-limit", "machine_limit"],
      [410, "expired", "expired"],
      [404, "invalid-code", "invalid_code"],
      [500, "boom", "network"],
    ];
    for (const [status, wireError, expected] of cases) {
      await expect(
        redeemMachineCredential(
          { apexUrl: "https://getbb.app", code: "ABCD-1234" },
          async () =>
            new Response(JSON.stringify({ error: wireError }), { status }),
        ),
      ).rejects.toMatchObject({ code: expected });
    }
  });

  it("rejects a response with no server to point at", async () => {
    await expect(
      redeemMachineCredential(
        { apexUrl: "https://getbb.app", code: "ABCD-1234" },
        async () =>
          new Response(
            JSON.stringify({
              credential: "bbcm_desktop",
              machineId: "machine-1",
              serverUrl: null,
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(ConnectMachineRedeemError);
  });

  it("rejects a server URL the asked-for apex does not own", async () => {
    const outsiders = [
      "https://laptop.evil.app",
      "https://laptop.getbb.app.evil.app",
      "http://laptop.getbb.app",
      "https://getbb.app",
    ];
    for (const serverUrl of outsiders) {
      await expect(
        redeemMachineCredential(
          { apexUrl: "https://getbb.app", code: "ABCD-1234" },
          async () =>
            new Response(
              JSON.stringify({
                credential: "bbcm_desktop",
                machineId: "machine-1",
                serverUrl,
              }),
            ),
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("accepts a self-hosted apex", async () => {
    await expect(
      redeemMachineCredential(
        { apexUrl: "https://bb.example", code: "ABCD-1234" },
        async () =>
          new Response(
            JSON.stringify({
              credential: "bbcm_desktop",
              machineId: "machine-1",
              serverUrl: "https://laptop.bb.example",
            }),
          ),
      ),
    ).resolves.toMatchObject({ handle: "laptop" });
  });
});

describe("mobile pairing payload", () => {
  it("derives the apex from the server URL and round-trips through QR text", () => {
    const payload = mobilePairingPayload({
      code: "K7QP-2M4X",
      serverUrl: "https://laptop.getbb.app",
      expiresAt: 1_700_000_600_000,
    });
    expect(payload).toEqual({
      code: "K7QP-2M4X",
      serverUrl: "https://laptop.getbb.app",
      apex: "https://getbb.app",
      expiresAt: 1_700_000_600_000,
    });
    const text = encodeMobilePairingPayload(payload);
    expect(JSON.parse(text)).toEqual(payload);
    expect(parseMobilePairingPayload(text)).toEqual(payload);
  });

  it("keeps a local Cloud apex's scheme and port", () => {
    expect(
      mobilePairingPayload({
        code: "AAAA-BBBB",
        serverUrl: "http://laptop.bb.localhost:42745",
        expiresAt: 1,
      }).apex,
    ).toBe("http://bb.localhost:42745");
  });

  it("rejects text that is not a pairing payload", () => {
    expect(parseMobilePairingPayload("https://laptop.getbb.app")).toBeNull();
    expect(parseMobilePairingPayload("{not json")).toBeNull();
    expect(parseMobilePairingPayload('{"code":"K7QP-2M4X"}')).toBeNull();
    expect(
      parseMobilePairingPayload(
        JSON.stringify({
          code: "K7QP-2M4X",
          serverUrl: "laptop.getbb.app",
          apex: "https://getbb.app",
          expiresAt: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseMobilePairingPayload(
        JSON.stringify({
          code: "K7QP-2M4X",
          serverUrl: "https://laptop.getbb.app",
          apex: "https://getbb.app",
          expiresAt: "soon",
        }),
      ),
    ).toBeNull();
  });

  it("ignores extra fields from a newer producer", () => {
    expect(
      parseMobilePairingPayload(
        JSON.stringify({
          code: "K7QP-2M4X",
          serverUrl: "https://laptop.getbb.app",
          apex: "https://getbb.app",
          expiresAt: 1,
          label: "Sawyer's Mac",
        }),
      ),
    ).toEqual({
      code: "K7QP-2M4X",
      serverUrl: "https://laptop.getbb.app",
      apex: "https://getbb.app",
      expiresAt: 1,
    });
  });
});
