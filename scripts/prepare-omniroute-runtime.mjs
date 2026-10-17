#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3.8.50";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const runtimeRoot = join(
  repoRoot,
  "apps",
  "desktop",
  "resources",
  "omniroute-runtime"
);
const sourceNode = process.execPath;
const sourceNodeDir = dirname(sourceNode);
const npmCli = join(sourceNodeDir, "node_modules", "npm", "bin", "npm-cli.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, { cwd = runtimeRoot, env = process.env, timeout = 15 * 60_000 } = {}) {
  const result = spawnSync(sourceNode, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-16_000);
    throw new Error(`Command failed with exit code ${result.status}: ${args.join(" ")}\n${details}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function npm(args, env) {
  return runNode([npmCli, ...args], { env });
}

function copyNodeRuntime() {
  copyFileSync(sourceNode, join(runtimeRoot, "node.exe"));
  // Node distributions can include runtime DLL/data companions beside node.exe.
  // Copy only such runtime files, not npm, headers, or development tooling.
  for (const entry of readdirSync(sourceNodeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:dll|dat|bin|cnf|pem)$/i.test(entry.name)) continue;
    const source = join(sourceNodeDir, entry.name);
    if (source.toLowerCase() === sourceNode.toLowerCase()) continue;
    copyFileSync(source, join(runtimeRoot, entry.name));
  }
  for (const name of ["LICENSE", "LICENSE.txt"]) {
    const source = join(sourceNodeDir, name);
    if (existsSync(source) && statSync(source).isFile()) {
      copyFileSync(source, join(runtimeRoot, name));
    }
  }
  const bundledNode = join(runtimeRoot, "node.exe");
  const version = runNode(["--version"], { cwd: runtimeRoot, timeout: 10_000 }).trim();
  const copied = spawnSync(bundledNode, ["--version"], {
    cwd: runtimeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert(!copied.error && copied.status === 0, "The staged node.exe could not start independently.");
  assert(copied.stdout.trim() === version, "The staged Node.js version does not match the build Node.js version.");
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  const supported =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major >= 24 && major < 27);
  assert(supported, `Unsupported bundled Node.js version: ${version}`);
  return version;
}

function copyFallbackPackages(modulesRoot) {
  const standaloneRoot = join(modulesRoot, "omniroute", "dist", "node_modules");
  for (const packageName of ["@swc/helpers", "sql.js", "node-machine-id"]) {
    const source = join(modulesRoot, packageName);
    assert(existsSync(source), `OmniRoute runtime is missing ${packageName}.`);
    cpSync(source, join(standaloneRoot, packageName), {
      recursive: true,
      force: true,
    });
  }

  const esbuildManifest = join(modulesRoot, "esbuild", "package.json");
  assert(existsSync(esbuildManifest), "OmniRoute runtime is missing esbuild.");
  const esbuild = JSON.parse(readFileSync(esbuildManifest, "utf8"));
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const platformVersion = esbuild.optionalDependencies?.[platformPackage];
  assert(
    typeof platformVersion === "string",
    `esbuild ${esbuild.version} does not declare ${platformPackage}.`
  );
  const [scope, packageName] = platformPackage.split("/");
  const destination = join(modulesRoot, scope, packageName);
  if (!existsSync(join(destination, "package.json"))) {
    const tempDir = mkdtempSync(join(runtimeRoot, ".esbuild-"));
    try {
      npm(
        [
          "install",
          "--prefix",
          tempDir,
          "--no-fund",
          "--no-audit",
          "--fetch-retries=1",
          "--fetch-timeout=120000",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-save",
          `${platformPackage}@${platformVersion}`,
        ],
        {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          PUPPETEER_SKIP_DOWNLOAD: "1",
          OMNIROUTE_TELEMETRY: "false",
        }
      );
      const source = join(tempDir, "node_modules", scope, packageName);
      assert(existsSync(join(source, "package.json")), `Could not stage ${platformPackage}.`);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, force: true });
    } finally {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }
}

function collectPackageNotices(modulesRoot) {
  const packages = [];
  const visited = new Set();
  function visitModules(dir) {
    if (!existsSync(dir) || visited.has(dir)) return;
    visited.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visitScoped(child);
        continue;
      }
      addPackage(child);
    }
  }
  function visitScoped(scopeDir) {
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (entry.isDirectory()) addPackage(join(scopeDir, entry.name));
    }
  }
  function addPackage(packageDir) {
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return;
    }
    if (typeof pkg.name === "string" && typeof pkg.version === "string") {
      const license =
        typeof pkg.license === "string"
          ? pkg.license
          : Array.isArray(pkg.licenses)
            ? pkg.licenses.map((item) => item?.type).filter(Boolean).join(" OR ")
            : "unspecified; inspect package license files";
      const relative = packageDir.slice(modulesRoot.length + 1).replaceAll("\\", "/");
      packages.push({ name: pkg.name, version: pkg.version, license, path: relative });
    }
    const nested = join(packageDir, "node_modules");
    if (existsSync(nested)) visitModules(nested);
  }
  visitModules(modulesRoot);
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const lines = [
    "OmniRoute bundled runtime - third-party package inventory",
    `Pinned top-level package: omniroute@${VERSION}`,
    "Each package's license/copyright files are shipped with the package where provided.",
    "Review the corresponding package directory below for the license text.",
    "",
    ...packages.map((pkg) => `- ${pkg.name}@${pkg.version} — ${pkg.license} — node_modules/${pkg.path}`),
    "",
  ];
  writeFileSync(join(runtimeRoot, "THIRD_PARTY_NOTICES.txt"), lines.join("\n"), "utf8");
  return packages;
}

async function main() {
  assert(process.platform === "win32", "The portable OmniRoute runtime bundle is Windows-only.");
  assert(existsSync(npmCli), `npm's JavaScript CLI is missing beside the CI Node runtime: ${npmCli}`);

  rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  mkdirSync(runtimeRoot, { recursive: true });
  const nodeVersion = copyNodeRuntime();
  const modulesRoot = join(runtimeRoot, "node_modules");
  const installEnv = {
    ...process.env,
    NODE_ENV: "production",
    OMNIROUTE_SKIP_POSTINSTALL: "1",
    OMNIROUTE_TELEMETRY: "false",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
  };

  console.info(`[omniroute-bundle] staging OmniRoute ${VERSION} with Node.js ${nodeVersion}`);
  npm(
    [
      "install",
      "--prefix",
      runtimeRoot,
      "--no-fund",
      "--no-audit",
      "--fetch-retries=1",
      "--fetch-timeout=120000",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      `omniroute@${VERSION}`,
    ],
    installEnv
  );

  const packageManifest = join(modulesRoot, "omniroute", "package.json");
  assert(existsSync(packageManifest), "OmniRoute package manifest was not staged.");
  const pkg = JSON.parse(readFileSync(packageManifest, "utf8"));
  assert(pkg.name === "omniroute" && pkg.version === VERSION, `Expected omniroute@${VERSION}, got ${pkg.name}@${pkg.version}.`);
  copyFallbackPackages(modulesRoot);
  const packages = collectPackageNotices(modulesRoot);
  writeFileSync(
    join(runtimeRoot, "runtime-manifest.json"),
    JSON.stringify(
      {
        name: "AbacusAI Bot bundled OmniRoute runtime",
        omnirouteVersion: VERSION,
        nodeVersion,
        platform: process.platform,
        architecture: process.arch,
        productionPackageCount: packages.length,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  console.info(
    `[omniroute-bundle] verified omniroute@${VERSION}; inventoried ${packages.length} packages. Bundle source: ${runtimeRoot}`
  );
  console.info("[omniroute-bundle] runtime stays under apps/desktop/resources so electron-builder copies it into the portable app.");
}

main().catch((error) => {
  console.error("[omniroute-bundle] failed:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
