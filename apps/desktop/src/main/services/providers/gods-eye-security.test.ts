import { describe, expect, it } from "vitest";

import { supportsOsBackedSecureStorage } from "./gods-eye-security.js";

describe("supportsOsBackedSecureStorage", () => {
  it("rejects unavailable encryption on every platform", () => {
    expect(supportsOsBackedSecureStorage("win32", false)).toBe(false);
    expect(supportsOsBackedSecureStorage("darwin", false)).toBe(false);
    expect(
      supportsOsBackedSecureStorage("linux", false, "gnome_libsecret")
    ).toBe(false);
  });

  it("accepts OS-backed Windows and macOS storage", () => {
    expect(supportsOsBackedSecureStorage("win32", true)).toBe(true);
    expect(supportsOsBackedSecureStorage("darwin", true)).toBe(true);
  });

  it("rejects weak or unknown Linux storage backends", () => {
    expect(supportsOsBackedSecureStorage("linux", true, "basic_text")).toBe(
      false
    );
    expect(supportsOsBackedSecureStorage("linux", true, "unknown")).toBe(false);
    expect(supportsOsBackedSecureStorage("linux", true)).toBe(false);
  });

  it("accepts recognized Linux secret stores", () => {
    for (const backend of [
      "gnome_libsecret",
      "kwallet",
      "kwallet5",
      "kwallet6",
    ]) {
      expect(supportsOsBackedSecureStorage("linux", true, backend)).toBe(true);
    }
  });
});
