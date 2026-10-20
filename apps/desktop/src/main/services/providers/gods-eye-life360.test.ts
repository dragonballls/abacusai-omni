import { describe, expect, it, vi } from "vitest";

import {
  LIFE360_MAX_RESPONSE_BYTES,
  Life360HomeAssistantProvider,
  isPrivateOrLoopbackAddress,
  validateHomeAssistantBaseUrl,
} from "./gods-eye-life360";

const state = (entity_id: string, attributes: Record<string, unknown>) => ({
  entity_id,
  state: "home",
  last_updated: "2026-10-19T12:00:00Z",
  attributes,
});

describe("Life360 Home Assistant provider", () => {
  it("accepts private/loopback addresses and rejects public or link-local hosts", () => {
    expect(isPrivateOrLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("192.168.1.12")).toBe(true);
    expect(isPrivateOrLoopbackAddress("10.2.3.4")).toBe(true);
    expect(isPrivateOrLoopbackAddress("172.20.1.3")).toBe(true);
    expect(isPrivateOrLoopbackAddress("169.254.169.254")).toBe(false);
    expect(isPrivateOrLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrLoopbackAddress("fd00::12")).toBe(true);
  });

  it("refuses a public host before sending the bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      validateHomeAssistantBaseUrl("https://example.com", async () => [
        "8.8.8.8",
      ])
    ).rejects.toThrow(/private-network/);
    const provider = new Life360HomeAssistantProvider(
      {
        enabled: true,
        baseUrl: "https://example.com",
        token: "never-return-this-token",
      },
      {
        fetchImpl,
        lookupAddresses: async () => ["8.8.8.8"],
      }
    );
    const result = await provider.locations();
    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("never-return-this-token");
  });

  it("reads only explicit tracker allowlist entries and never returns the token", async () => {
    const states = [
      state("device_tracker.alice_phone", {
        latitude: 34.1,
        longitude: -117.8,
        gps_accuracy: 9,
        friendly_name: "Alice phone",
      }),
      state("device_tracker.bob_phone", {
        latitude: 34.2,
        longitude: -117.9,
        friendly_name: "Bob phone",
      }),
      state("device_tracker.life360_guest", {
        latitude: 999,
        longitude: -117.9,
        source: "Life360",
      }),
      state("sensor.alice", { latitude: 34.1, longitude: -117.8 }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith("/api/")
        ? new Response(JSON.stringify({ message: "API running." }), {
            status: 200,
          })
        : new Response(JSON.stringify(states), { status: 200 });
    });
    const provider = new Life360HomeAssistantProvider(
      {
        enabled: true,
        baseUrl: "http://192.168.1.12:8123",
        token: "do-not-leak",
        entityIds: ["device_tracker.alice_phone"],
      },
      { fetchImpl }
    );
    const result = await provider.locations();

    expect(result.success).toBe(true);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({
      id: "device_tracker.alice_phone",
      label: "Alice phone",
      latitude: 34.1,
      longitude: -117.8,
      accuracyM: 9,
    });
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
    expect(
      fetchImpl.mock.calls.every((call) => call[1]?.redirect === "error")
    ).toBe(true);
  });

  it("auto-selects only Life360-attributed trackers when there is no explicit allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/api/")
        ? new Response('{"message":"API running."}', { status: 200 })
        : new Response(
            JSON.stringify([
              state("device_tracker.life360_family", {
                latitude: 33,
                longitude: -117,
              }),
              state("device_tracker.wifi_guest", {
                latitude: 34,
                longitude: -118,
                source: "router",
              }),
            ]),
            { status: 200 }
          )
    );
    const provider = new Life360HomeAssistantProvider(
      {
        enabled: true,
        baseUrl: "http://127.0.0.1:8123",
        token: "secret",
      },
      { fetchImpl }
    );
    const result = await provider.locations();
    expect(result.success).toBe(true);
    expect(result.locations.map((location) => location.id)).toEqual([
      "device_tracker.life360_family",
    ]);
  });

  it("caps Home Assistant responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/api/")
        ? new Response('{"message":"API running."}', { status: 200 })
        : new Response("x".repeat(LIFE360_MAX_RESPONSE_BYTES + 1), {
            status: 200,
          })
    );
    const provider = new Life360HomeAssistantProvider(
      {
        enabled: true,
        baseUrl: "http://127.0.0.1:8123",
        token: "secret",
      },
      { fetchImpl }
    );
    const result = await provider.locations();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeded the safety limit/);
  });

  it("does not follow credential-bearing redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("redirect", {
          status: 302,
          headers: { Location: "https://evil.example/" },
        })
    );
    const provider = new Life360HomeAssistantProvider(
      {
        enabled: true,
        baseUrl: "http://127.0.0.1:8123",
        token: "secret",
      },
      { fetchImpl }
    );
    const result = await provider.locations();
    expect(result.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
