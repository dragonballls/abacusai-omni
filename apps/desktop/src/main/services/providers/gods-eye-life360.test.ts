import { describe, expect, it, vi } from "vitest";

import {
  LIFE360_MAX_RESPONSE_BYTES,
  Life360HomeAssistantProvider,
  isPrivateOrLoopbackAddress,
  validateHomeAssistantBaseUrl,
  validateHomeAssistantBaseUrlWhenEnabled,
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

  it("allows disabling Life360 when Home Assistant is offline", async () => {
    const lookupAddresses = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      validateHomeAssistantBaseUrlWhenEnabled(
        false,
        "https://home.example",
        lookupAddresses
      )
    ).resolves.toBeUndefined();
    expect(lookupAddresses).not.toHaveBeenCalled();
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
    const alice = state("device_tracker.alice_phone", {
      latitude: 34.1,
      longitude: -117.8,
      gps_accuracy: 9,
      friendly_name: "Alice phone",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith("/api/")
        ? new Response(JSON.stringify({ message: "API running." }), {
            status: 200,
          })
        : url.endsWith("/api/states/device_tracker.alice_phone")
          ? new Response(JSON.stringify(alice), { status: 200 })
          : new Response("not found", { status: 404 });
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
    const life360 = state("device_tracker.life360_family", {
      latitude: 33,
      longitude: -117,
    });
    const sourceAttributed = state("device_tracker.family_phone", {
      latitude: 33.1,
      longitude: -117.1,
      attribution: "Home Assistant",
      source: "Life360",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/"))
        return new Response('{"message":"API running."}', { status: 200 });
      if (url.endsWith("/api/template")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          template?: string;
        };
        expect(body.template).toContain("states.device_tracker");
        expect(body.template).toContain("to_json");
        return new Response(
          JSON.stringify([
            "device_tracker.life360_family",
            "device_tracker.family_phone",
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith("/api/states/device_tracker.life360_family"))
        return new Response(JSON.stringify(life360), { status: 200 });
      if (url.endsWith("/api/states/device_tracker.family_phone"))
        return new Response(JSON.stringify(sourceAttributed), { status: 200 });
      return new Response("not found", { status: 404 });
    });
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
      "device_tracker.family_phone",
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
