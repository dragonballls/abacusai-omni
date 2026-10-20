import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareGodsEyeRuntime } from "./gods-eye-runtime.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeSource(root: string): string {
  const source = join(root, "packaged-source");
  mkdirSync(join(source, "node_modules", "vite", "bin"), { recursive: true });
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, ".gev-cache"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"gods-eye"}\n');
  writeFileSync(
    join(source, "node_modules", "vite", "bin", "vite.js"),
    "// vite"
  );
  writeFileSync(join(source, "src", "main.js"), "// main");
  writeFileSync(join(source, ".env.example"), "PUBLIC_PLACEHOLDER=example\n");
  writeFileSync(join(source, ".env"), "DO_NOT_COPY=build-host-secret\n");
  writeFileSync(join(source, ".gev-cache", "stale.json"), "{}");
  return source;
}

describe("prepareGodsEyeRuntime", () => {
  it(
    "replaces stale runtime files and preserves user provider settings",
    () => {
    const base = join(
      tmpdir(),
      "abacus-gods-eye-runtime-test-" + process.pid + "-" + Date.now()
    );
    tempRoots.push(base);
    const source = makeSource(base);
    const root = join(base, "profile", "integrations", "runtime");
    mkdirSync(join(root, "node_modules", "vite", "bin"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "pinokio"), { recursive: true });
    writeFileSync(join(root, ".abacus-gods-eye-revision"), "old-revision\n");
    writeFileSync(join(root, "stale-from-old-release.js"), "// stale");
    writeFileSync(
      join(root, "node_modules", "vite", "bin", "vite.js"),
      "// old vite"
    );
    writeFileSync(join(root, "src", "main.js"), "// old main");
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=user-value\n");
    writeFileSync(
      join(root, "pinokio", "ENVIRONMENT"),
      "GEMINI_API_KEY=pinokio-value\n"
    );

    expect(prepareGodsEyeRuntime(source, root, "new-revision")).toBe(root);
    expect(existsSync(join(root, "stale-from-old-release.js"))).toBe(false);
    expect(readFileSync(join(root, ".abacus-gods-eye-revision"), "utf8")).toBe(
      "new-revision\n"
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(
      "OPENAI_API_KEY=user-value\n"
    );
    expect(readFileSync(join(root, "pinokio", "ENVIRONMENT"), "utf8")).toBe(
      "GEMINI_API_KEY=pinokio-value\n"
    );
    expect(readFileSync(join(root, ".env.example"), "utf8")).toBe(
      "PUBLIC_PLACEHOLDER=example\n"
    );
    expect(existsSync(join(root, ".gev-cache", "stale.json"))).toBe(false);
    }
  );

  it(
    "does not copy build-host .env secrets on first launch",
    () => {
      const base = join(
        tmpdir(),
        "abacus-gods-eye-first-run-" + process.pid + "-" + Date.now()
      );
      tempRoots.push(base);
      const source = makeSource(base);
      const root = join(base, "profile", "integrations", "runtime");

      prepareGodsEyeRuntime(source, root, "first-revision");

      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(readFileSync(join(root, ".env.example"), "utf8")).toBe(
        "PUBLIC_PLACEHOLDER=example\n"
      );
    }
  );
});
