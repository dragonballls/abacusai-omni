import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export function prepareGodsEyeRuntime(
  source: string,
  root: string,
  revision: string
): string {
  const marker = join(root, ".abacus-gods-eye-revision");
  const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
  let installedRevision = "";
  try {
    installedRevision = readFileSync(marker, "utf8").trim();
  } catch {
    /* First launch, or an older runtime without a marker. */
  }

  if (
    installedRevision === revision &&
    existsSync(viteCli) &&
    existsSync(join(root, "src", "main.js"))
  ) {
    return root;
  }

  // Provider Settings are written into the writable runtime profile. Preserve
  // those user-owned files before replacing the tree, but never follow symlinks.
  const preservedSettings = [".env", join("pinokio", "ENVIRONMENT")].flatMap(
    (relativePath) => {
      const path = join(root, relativePath);
      try {
        if (!lstatSync(path).isFile()) return [];
        return [{ relativePath, contents: readFileSync(path) }];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }
  );

  mkdirSync(dirname(root), { recursive: true });
  rmSync(root, { recursive: true, force: true });
  cpSync(source, root, {
    recursive: true,
    force: true,
    filter: (path) => {
      const relativePath = relative(source, path);
      const parts = relativePath.split(/[\\/]/);
      const basename = parts.at(-1) ?? "";
      if (
        parts.includes(".git") ||
        parts.includes(".gev-cache") ||
        parts.includes(".gev-logs")
      ) {
        return false;
      }
      if (parts.includes(".cache") && parts.includes("node_modules")) {
        return false;
      }
      if (basename.startsWith(".env") && basename !== ".env.example") {
        return false;
      }
      return true;
    },
  });

  for (const setting of preservedSettings) {
    const target = join(root, setting.relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, setting.contents, { mode: 0o600 });
    try {
      chmodSync(target, 0o600);
    } catch {
      /* Windows ACLs are per-user. */
    }
  }

  if (!existsSync(viteCli)) {
    throw new Error(
      "God's Eye dependencies are not packaged. Rebuild the installer."
    );
  }
  writeFileSync(marker, revision + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return root;
}
