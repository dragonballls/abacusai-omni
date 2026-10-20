import { describe, expect, it } from "vitest";

import type { Life360Location } from "./gods-eye-life360";
import { buildGodsEyeRefreshUrl } from "./gods-eye-view-url";

const alice: Life360Location = {
  id: "device_tracker.alice",
  label: "Alice phone",
  latitude: 34.1,
  longitude: -117.8,
  accuracyM: 8,
  place: null,
  lastSeen: null,
};

describe("God's Eye Life360 view handoff", () => {
  it("adds Life360 pins while preserving the map view and user annotations", () => {
    const source =
      "http://127.0.0.1:4173/#v=2&lat=33.9&lon=-117.9&alt=1200000&pitch=-80&layers=flights&an=" +
      encodeURIComponent(
        JSON.stringify([
          { type: "pin", latitude: 40, longitude: -73, label: "User note" },
          {
            type: "pin",
            latitude: 0,
            longitude: 0,
            label: "Life360 · Old phone",
          },
        ])
      );
    const result = new URL(buildGodsEyeRefreshUrl(source, [alice]));
    const params = new URLSearchParams(result.hash.slice(1));
    const annotations = JSON.parse(params.get("an") ?? "[]") as Array<{
      label: string;
    }>;
    expect(result.origin).toBe("http://127.0.0.1:4173");
    expect(params.get("lat")).toBe("33.9");
    expect(params.get("lon")).toBe("-117.9");
    expect(params.get("layers")).toBe("flights");
    expect(annotations).toHaveLength(2);
    expect(annotations[0].label).toBe("User note");
    expect(annotations[1].label).toBe("Life360 · Alice phone");
  });

  it("opens over the first authorized location on first launch and bounds annotations", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...alice,
      id: "device_tracker.person_" + index,
      label: "Person " + index,
      latitude: 34 + index / 100,
    }));
    const result = new URL(
      buildGodsEyeRefreshUrl("http://127.0.0.1:4173/", many)
    );
    const params = new URLSearchParams(result.hash.slice(1));
    const annotations = JSON.parse(params.get("an") ?? "[]") as Array<unknown>;
    expect(params.get("lat")).toBe("34.0000");
    expect(params.get("lon")).toBe("-117.8000");
    expect(annotations).toHaveLength(24);
  });


  it("removes Life360 pins on disconnect without deleting user pins or view state", () => {
    const source =
      "http://127.0.0.1:4173/#v=2&lat=33.9&lon=-117.9&alt=1200000&pitch=-80&an=" +
      encodeURIComponent(
        JSON.stringify([
          { type: "pin", latitude: 40, longitude: -73, label: "User note" },
          {
            type: "pin",
            latitude: 34.1,
            longitude: -117.8,
            label: "Life360 · Alice phone",
            color: "amber",
          },
        ])
      );
    const result = new URL(buildGodsEyeRefreshUrl(source, []));
    const params = new URLSearchParams(result.hash.slice(1));
    const annotations = JSON.parse(params.get("an") ?? "[]") as Array<{
      label: string;
    }>;
    expect(params.get("lat")).toBe("33.9");
    expect(params.get("lon")).toBe("-117.9");
    expect(annotations).toHaveLength(1);
    expect(annotations[0].label).toBe("User note");
  });

  it("refuses non-loopback app URLs", () => {
    expect(() =>
      buildGodsEyeRefreshUrl("https://example.com/", [alice])
    ).toThrow(/local app origin/);
  });
});
