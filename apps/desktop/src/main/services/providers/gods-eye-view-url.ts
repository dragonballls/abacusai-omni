import type { Life360Location } from "./gods-eye-life360";

const MAX_ANNOTATIONS = 24;
const LIFE360_LABEL_PREFIX = "Life360 · ";

const validLocation = (location: Life360Location): boolean =>
  Number.isFinite(location.latitude) &&
  Number.isFinite(location.longitude) &&
  location.latitude >= -90 &&
  location.latitude <= 90 &&
  location.longitude >= -180 &&
  location.longitude <= 180;

const isLife360Annotation = (item: unknown): boolean =>
  item != null &&
  typeof item === "object" &&
  !Array.isArray(item) &&
  typeof (item as { label?: unknown }).label === "string" &&
  (item as { label: string }).label.startsWith(LIFE360_LABEL_PREFIX);

/** Preserve the upstream share-link view while refreshing only Life360 pins. */
export function buildGodsEyeRefreshUrl(
  currentUrl: string,
  locations: readonly Life360Location[]
): string {
  const url = new URL(currentUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "God's Eye refresh URLs must stay on the local app origin."
    );
  }

  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  let existing: unknown[] = [];
  const raw = params.get("an");
  if (raw && raw.length <= 6000) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) existing = value;
    } catch {
      existing = [];
    }
  }
  const manual = existing
    .filter((item) => !isLife360Annotation(item))
    .slice(0, MAX_ANNOTATIONS);
  const availableSlots = Math.max(0, MAX_ANNOTATIONS - manual.length);
  const family = locations
    .filter(validLocation)
    .slice(0, availableSlots)
    .map((location) => ({
      type: "pin",
      latitude: location.latitude,
      longitude: location.longitude,
      label: ("Life360 · " + location.label).slice(0, 120),
      color: "amber",
    }));
  const annotations = [...manual, ...family];
  if (annotations.length) params.set("an", JSON.stringify(annotations));
  else params.delete("an");

  if (!params.has("lat") && family.length > 0) {
    params.set("v", "2");
    params.set("lat", family[0].latitude.toFixed(4));
    params.set("lon", family[0].longitude.toFixed(4));
    params.set("alt", "800000");
    params.set("heading", "0");
    params.set("pitch", "-90");
    params.set("roll", "0");
  }

  url.hash = params.toString();
  return url.href;
}
