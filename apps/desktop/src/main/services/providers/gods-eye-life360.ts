import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const LIFE360_MAX_RESPONSE_BYTES = 64 * 1024;
export const LIFE360_MAX_ENTITY_IDS = 100;

export interface Life360HomeAssistantConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  entityIds?: string[];
}

export interface Life360Location {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  place: string | null;
  lastSeen: string | null;
}

export interface Life360ReadResult {
  success: boolean;
  locations: Life360Location[];
  error?: string;
}

export interface Life360ProviderDependencies {
  fetchImpl?: typeof fetch;
  lookupAddresses?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

const defaultLookupAddresses = async (hostname: string): Promise<string[]> => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

const normalizedHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export function isPrivateOrLoopbackAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [first = -1, second = -1] = address.split(".").map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (version !== 6) return false;
  const value = address.toLowerCase();
  if (value === "::1" || value.startsWith("fc") || value.startsWith("fd"))
    return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped != null && isPrivateOrLoopbackAddress(mapped[1]);
}

/**
 * Validate Home Assistant's base URL before sending a bearer token.
 * Only loopback/private hosts are accepted; redirects are disabled on every
 * request so a private URL cannot forward the token to another host.
 */
export async function validateHomeAssistantBaseUrl(
  input: string,
  lookupAddresses: (
    hostname: string
  ) => Promise<string[]> = defaultLookupAddresses
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new Error("Enter a valid Home Assistant URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "Use a credential-free HTTP(S) Home Assistant base URL, without a path, query, or fragment."
    );
  }

  const hostname = normalizedHostname(url.hostname);
  if (hostname === "localhost") return url;

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookupAddresses(hostname);
    } catch {
      throw new Error(
        "Home Assistant host could not be resolved on the local network."
      );
    }
  }
  if (addresses.length === 0 || !addresses.every(isPrivateOrLoopbackAddress)) {
    throw new Error(
      "Life360 can connect only to a loopback or private-network Home Assistant host."
    );
  }
  return url;
}

async function readJsonCapped(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > LIFE360_MAX_RESPONSE_BYTES
  )
    throw new Error("Home Assistant response exceeded the safety limit.");

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > LIFE360_MAX_RESPONSE_BYTES)
      throw new Error("Home Assistant response exceeded the safety limit.");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Home Assistant returned invalid JSON.");
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > LIFE360_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Home Assistant response exceeded the safety limit.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size
      ).toString("utf8")
    ) as unknown;
  } catch {
    throw new Error("Home Assistant returned invalid JSON.");
  }
}

const finiteNumber = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const textValue = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export class Life360HomeAssistantProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly lookupAddresses: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private lastError: string | null = null;

  constructor(
    private readonly config: Life360HomeAssistantConfig,
    dependencies: Life360ProviderDependencies = {}
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.lookupAddresses =
      dependencies.lookupAddresses ?? defaultLookupAddresses;
    this.timeoutMs = Math.max(
      500,
      Math.min(dependencies.timeoutMs ?? 4000, 15000)
    );
  }

  status(): {
    enabled: boolean;
    configured: boolean;
    baseUrl: string;
    lastError: string | null;
  } {
    return {
      enabled: this.config.enabled,
      configured: this.config.token.trim().length > 0,
      baseUrl: this.config.baseUrl,
      lastError: this.lastError,
    };
  }

  async locations(): Promise<Life360ReadResult> {
    this.lastError = null;
    if (!this.config.enabled)
      return {
        success: false,
        locations: [],
        error: "Life360 sharing is disabled.",
      };
    if (!this.config.token.trim())
      return {
        success: false,
        locations: [],
        error: "Add a Home Assistant long-lived access token first.",
      };

    let baseUrl: URL;
    try {
      baseUrl = await validateHomeAssistantBaseUrl(
        this.config.baseUrl,
        this.lookupAddresses
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid Home Assistant URL.";
      this.lastError = message;
      return { success: false, locations: [], error: message };
    }

    try {
      await this.requestJson(new URL("/api/", baseUrl).href);
      const rawStates = await this.requestJson(
        new URL("/api/states", baseUrl).href
      );
      if (!Array.isArray(rawStates))
        throw new Error("Home Assistant returned malformed state data.");

      const allowlist = new Set(
        (this.config.entityIds ?? [])
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      );
      const locations: Life360Location[] = [];
      for (const item of rawStates) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const state = item as Record<string, unknown>;
        const entityId = String(state.entity_id ?? "");
        if (!/^device_tracker\.[a-z0-9_]+$/i.test(entityId)) continue;
        const attrs =
          state.attributes != null &&
          typeof state.attributes === "object" &&
          !Array.isArray(state.attributes)
            ? (state.attributes as Record<string, unknown>)
            : {};
        const attribution = String(
          attrs.attribution ?? attrs.source ?? ""
        ).toLowerCase();
        const inferredLife360 =
          entityId.toLowerCase().includes("life360") ||
          attribution.includes("life360");
        if (
          allowlist.size > 0
            ? !allowlist.has(entityId.toLowerCase())
            : !inferredLife360
        )
          continue;

        const latitude = finiteNumber(attrs.latitude);
        const longitude = finiteNumber(attrs.longitude);
        if (
          latitude == null ||
          longitude == null ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        )
          continue;

        const rawAccuracy = finiteNumber(attrs.gps_accuracy);
        locations.push({
          id: entityId,
          label: String(attrs.friendly_name ?? entityId).slice(0, 120),
          latitude,
          longitude,
          accuracyM:
            rawAccuracy != null && rawAccuracy >= 0 ? rawAccuracy : null,
          place: textValue(attrs.place ?? attrs.zone, 120),
          lastSeen: textValue(
            attrs.last_seen ?? state.last_updated ?? state.last_changed,
            80
          ),
        });
        if (locations.length >= LIFE360_MAX_ENTITY_IDS) break;
      }
      return { success: true, locations };
    } catch (error) {
      const message =
        error instanceof Error &&
        (error.message.startsWith("Home Assistant") ||
          error.message.startsWith("Life360"))
          ? error.message
          : "Could not contact Home Assistant on the configured private network; check its URL, access token, and connection.";
      this.lastError = message;
      return { success: false, locations: [], error: message };
    }
  }

  private async requestJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + this.config.token,
          Accept: "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new Error("Home Assistant rejected the access token.");
        throw new Error(
          "Home Assistant request failed (" + response.status + ")."
        );
      }
      return await readJsonCapped(response);
    } finally {
      clearTimeout(timer);
    }
  }
}
