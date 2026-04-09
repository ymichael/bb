import { describe, expect, it, vi } from "vitest";

const statusGet = vi.fn();

vi.mock("@bb/host-daemon-contract", () => ({
  createHostDaemonLocalClient: () => ({
    status: { $get: statusGet },
  }),
}));

const { fetchHostId, fetchHostStatus } = await import("./api-host-daemon");

describe("fetchHostStatus", () => {
  it("returns the daemon status when the daemon is reachable", async () => {
    statusGet.mockResolvedValue({
      ok: true,
      json: async () => ({
        hostId: "host_1",
        connected: true,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
      }),
    });

    await expect(fetchHostStatus(3002)).resolves.toEqual({
      hostId: "host_1",
      connected: true,
      serverUrl: "http://localhost:3334",
      supportsNativeFolderPicker: true,
    });
  });

  it("returns null when daemon is unreachable", async () => {
    statusGet.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchHostStatus(3002)).resolves.toBeNull();
  });

  it("returns null when status response is not ok", async () => {
    statusGet.mockResolvedValue({ ok: false });

    await expect(fetchHostStatus(3002)).resolves.toBeNull();
  });
});

describe("fetchHostId", () => {
  it("returns hostId when daemon is connected", async () => {
    statusGet.mockResolvedValue({
      ok: true,
      json: async () => ({
        hostId: "host_1",
        connected: true,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
      }),
    });

    await expect(fetchHostId(3002)).resolves.toBe("host_1");
  });

  it("returns null when daemon is not connected to the server", async () => {
    statusGet.mockResolvedValue({
      ok: true,
      json: async () => ({
        hostId: "host_1",
        connected: false,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
      }),
    });

    await expect(fetchHostId(3002)).resolves.toBeNull();
  });

  it("returns null when daemon is unreachable", async () => {
    statusGet.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchHostId(3002)).resolves.toBeNull();
  });

  it("returns null when status response is not ok", async () => {
    statusGet.mockResolvedValue({ ok: false });

    await expect(fetchHostId(3002)).resolves.toBeNull();
  });
});
