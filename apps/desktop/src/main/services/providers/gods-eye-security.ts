export function supportsOsBackedSecureStorage(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  selectedBackend?: string
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== "linux") return true;
  return (
    selectedBackend !== undefined &&
    selectedBackend !== "basic_text" &&
    selectedBackend !== "unknown"
  );
}
