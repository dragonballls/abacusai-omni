import { spawn, spawnSync, type ChildProcess } from "node:child_process";
/**
 * Local OmniRoute gateway integration for AbacusAI Bot.
 *
 * Matches Brahma Evo's pinned OmniRoute 3.8.50 runtime and shared Windows
 * data directory. Upstream provider credentials are entered in OmniRoute's
 * own dashboard and are never copied into AbacusAI Bot settings.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { CustomProviderEntry } from "@abacus-ai/contract/settings";
import { app, BrowserWindow, shell } from "electron";

import { isSafeExternalUrl } from "../../external-links.js";
import {
  readSettings,
  setDefaultModel,
  upsertCustomProvider,
} from "../config/settings.js";

const OMNIROUTE_VERSION = "3.8.50";
const OMNIROUTE_PORT = 20128;
const OMNIROUTE_ORIGIN = `http://127.0.0.1:${OMNIROUTE_PORT}`;
const OMNIROUTE_BASE_URL = `${OMNIROUTE_ORIGIN}/v1`;
const DEFAULT_MODEL = "omniroute/auto";
const PROVIDER_ID = "omniroute";
const OMNIROUTE_STARTUP_HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>OmniRoute Gateway</title>",
  "<style>",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}",
  "main{width:min(760px,100%);padding:48px}",
  ".eyebrow{color:#93c5fd;font-size:12px;letter-spacing:.16em;font-weight:700;margin-bottom:18px}",
  "h1{font-size:28px;margin:0 0 14px}",
  "p{color:#cbd5e1;line-height:1.6}",
  "pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;background:#030712;padding:16px;border-radius:8px;color:#fca5a5;font-size:12px}",
  "</style>",
  "</head>",
  "<body>",
  "<main>",
  '<div class="eyebrow">ABACUSAI BOT / OMNIROUTE</div>',
  '<h1 id="status-title">Starting OmniRoute</h1>',
  '<p id="status-message">Starting the secure local gateway.</p>',
  '<pre id="status-details" hidden></pre>',
  "</main>",
  "</body>",
  "</html>",
].join("");
const OMNIROUTE_STARTUP_PAGE_URL =
  "data:text/html;charset=utf-8," + encodeURIComponent(OMNIROUTE_STARTUP_HTML);

/**
 * Share the same per-user runtime/data folder Brahma Evo uses on Windows.
 * Other platforms keep OmniRoute inside AbacusAI Bot's own user-data folder.
 */
const omniRouteDataDir =
  process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA ||
          join(app.getPath("home"), "AppData", "Local"),
        "BrahmaAI",
        "OmniRoute"
      )
    : join(app.getPath("userData"), "OmniRoute");
const omniRouteEntry = join(
  omniRouteDataDir,
  "node_modules",
  "omniroute",
  "bin",
  "omniroute.mjs"
);
const omniRouteClientKeyPath = join(
  omniRouteDataDir,
  "abacusai-bot-client-api-key"
);
const omniRouteBundleRoot = join(process.resourcesPath, "omniroute-runtime");
const omniRouteBundleNode = join(omniRouteBundleRoot, "node.exe");
const omniRouteBundleModules = join(omniRouteBundleRoot, "node_modules");

let gatewayProcess: ChildProcess | null = null;
let dashboardWindow: BrowserWindow | null = null;
let ensurePromise: Promise<string> | null = null;
let gatewayOutputTail = "";

function captureGatewayOutput(
  stream: "stdout" | "stderr",
  chunk: unknown
): void {
  const lines = String(chunk)
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `[${stream}] ${line}`);
  gatewayOutputTail = (gatewayOutputTail + lines.join("\n") + "\n").slice(
    -12_000
  );
}

function gatewayOutputForError(): string {
  return gatewayOutputTail
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]"
    )
    .trim();
}

function redactStartupDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]"
    )
    .slice(-6_000);
}

function updateOmniRouteStartupPage(
  window: BrowserWindow,
  title: string,
  message: string,
  details = ""
): Promise<void> {
  const safeDetails = redactStartupDiagnostic(details);
  const script = [
    "(() => {",
    "const titleElement = document.getElementById('status-title');",
    "if (titleElement) titleElement.textContent = " +
      JSON.stringify(title) +
      ";",
    "const messageElement = document.getElementById('status-message');",
    "if (messageElement) messageElement.textContent = " +
      JSON.stringify(message) +
      ";",
    "const detailsElement = document.getElementById('status-details');",
    "if (detailsElement) {",
    "detailsElement.textContent = " + JSON.stringify(safeDetails) + ";",
    "detailsElement.hidden = " + JSON.stringify(safeDetails.length === 0) + ";",
    "}",
    "})();",
  ].join("\n");

  return window.webContents
    .executeJavaScript(script)
    .then(() => undefined)
    .catch(() => undefined);
}

type CommandResult = { code: number | null; output: string; stdout: string };

function pathEntries(): string[] {
  return (process.env.PATH || "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function findExecutable(names: string[]): string | null {
  const candidates: string[] = [];
  for (const entry of pathEntries()) {
    for (const name of names) candidates.push(join(entry, name));
  }
  if (process.env.BRAHMA_NODE_COMMAND) {
    candidates.unshift(process.env.BRAHMA_NODE_COMMAND);
  }
  if (process.env.PROGRAMFILES) {
    candidates.push(join(process.env.PROGRAMFILES, "nodejs", "node.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function bundledNodeExecutable(): string | null {
  if (process.platform !== "win32") return null;
  return existsSync(omniRouteBundleNode) &&
    existsSync(
      join(omniRouteBundleModules, "omniroute", "bin", "omniroute.mjs")
    )
    ? omniRouteBundleNode
    : null;
}

function nodeAndNpm(): { node: string; npmArgs: string[] } {
  // The Windows portable build carries its own supported Node runtime. Prefer
  // that pinned executable so first-run startup never depends on a system-wide
  // Node/npm installation or an npm registry connection.
  const bundledNode = bundledNodeExecutable();
  const node =
    bundledNode ??
    findExecutable(
      process.platform === "win32" ? ["node.exe", "node"] : ["node"]
    );
  if (!node) {
    throw new Error(
      "OmniRoute needs Node.js installed on this computer. " +
        "Install Node.js 24, reopen AbacusAI Bot, and try again."
    );
  }

  const versionResult = spawnSync(node, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const version = String(versionResult.stdout ?? "").trim();
  const versionMatch = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(versionMatch?.[1]);
  const minor = Number(versionMatch?.[2]);
  const patch = Number(versionMatch?.[3]);
  const supported22 =
    major === 22 && (minor > 22 || (minor === 22 && patch >= 2));
  const supported24Plus = major >= 24 && major < 27;
  const supported = supported22 || supported24Plus;
  if (
    versionResult.error ||
    versionResult.status !== 0 ||
    !versionMatch ||
    !supported
  ) {
    throw new Error(
      "OmniRoute 3.8.50 requires Node.js >=22.22.2 <23 or >=24 <27. " +
        `Found ${version || "an unreadable version"}. Install Node.js 24, ` +
        "reopen AbacusAI Bot, and try again."
    );
  }

  if (process.platform === "win32") {
    const npmCli = join(
      dirname(node),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
    if (!existsSync(npmCli)) {
      if (bundledNode && node === bundledNode) return { node, npmArgs: [] };
      throw new Error(
        "The Node.js installation was found, but npm's CLI is missing. " +
          "Repair/reinstall Node.js with npm, then retry OmniRoute."
      );
    }
    return { node, npmArgs: [npmCli] };
  }

  const npm = findExecutable(["npm"]);
  if (!npm) {
    throw new Error(
      "npm was not found. Install Node.js with npm, then retry OmniRoute."
    );
  }
  return { node, npmArgs: [npm] };
}

function runtimeEnvironment(requireApiKey = true): NodeJS.ProcessEnv {
  const initialPassword = readInitialManagementPassword();
  const environment = { ...process.env };
  // OmniRoute treats these as an opt-in split-port configuration. Never inherit
  // them from the parent app shell when this gateway expects one shared port.
  delete environment.API_PORT;
  delete environment.DASHBOARD_PORT;
  return {
    ...environment,
    ...(initialPassword ? { INITIAL_PASSWORD: initialPassword } : {}),
    DATA_DIR: omniRouteDataDir,
    PORT: String(OMNIROUTE_PORT),
    OMNIROUTE_PORT: String(OMNIROUTE_PORT),
    OMNIROUTE_SERVER_HOST: "127.0.0.1",
    OMNIROUTE_TELEMETRY: "false",
    NODE_ENV: "production",
    // App-owned gateways always start with API-key enforcement enabled.
    REQUIRE_API_KEY: requireApiKey ? "true" : "false",
  };
}

/**
 * Keep npm on its lightweight API-gateway install path: it does not need
 * browser downloads merely to route requests to remote API providers.
 */
function runtimeInstallEnvironment(): NodeJS.ProcessEnv {
  return {
    ...runtimeEnvironment(),
    OMNIROUTE_SKIP_POSTINSTALL: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
  };
}

/**
 * Install only the API-gateway dependency set without executing upstream
 * postinstall download/build scripts. OmniRoute's bundled dist uses native
 * SQLite when compatible, then node:sqlite (available in supported Node 22+
 * versions), then sql.js. Restore the three regular JS runtime packages that
 * upstream normally copies into its standalone dist tree during postinstall.
 */
async function ensureRuntimeFallbackPackages(
  node: string,
  npmArgs: string[]
): Promise<void> {
  const modulesRoot = join(omniRouteDataDir, "node_modules");
  const standaloneRoot = join(modulesRoot, "omniroute", "dist", "node_modules");
  for (const packageName of ["@swc/helpers", "sql.js", "node-machine-id"]) {
    const source = join(modulesRoot, packageName);
    if (!existsSync(source)) {
      throw new Error(
        `The OmniRoute install is missing required runtime package ${packageName}.`
      );
    }
    const destination = join(standaloneRoot, packageName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }

  const esbuildManifest = join(modulesRoot, "esbuild", "package.json");
  if (!existsSync(esbuildManifest)) {
    throw new Error(
      "The OmniRoute install is missing esbuild's runtime package."
    );
  }
  const esbuild = JSON.parse(readFileSync(esbuildManifest, "utf8")) as {
    version?: string;
    optionalDependencies?: Record<string, string>;
  };
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const platformVersion = esbuild.optionalDependencies?.[platformPackage];
  if (!esbuild.version || !platformVersion) {
    throw new Error(
      `esbuild ${esbuild.version ?? "(unknown)"} does not declare ${platformPackage}.`
    );
  }

  const [scope, packageName] = platformPackage.split("/");
  const binaryDestination = join(modulesRoot, scope!, packageName!);
  if (existsSync(join(binaryDestination, "package.json"))) return;

  const bundledBinary = join(omniRouteBundleModules, scope!, packageName!);
  if (existsSync(join(bundledBinary, "package.json"))) {
    mkdirSync(dirname(binaryDestination), { recursive: true });
    cpSync(bundledBinary, binaryDestination, { recursive: true, force: true });
    return;
  }
  if (npmArgs.length === 0) {
    throw new Error(
      `The OmniRoute install is missing ${platformPackage}, and npm is unavailable ` +
        "to repair it."
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), "abacus-omniroute-esbuild-"));
  try {
    const result = await runCommand(
      node,
      [
        ...npmArgs,
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
      120_000,
      {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PUPPETEER_SKIP_DOWNLOAD: "1",
      },
      tempDir
    );
    if (result.code !== 0) {
      throw new Error(
        `Could not install ${platformPackage}@${platformVersion}: ${result.output}`
      );
    }
    const binarySource = join(tempDir, "node_modules", scope!, packageName!);
    if (!existsSync(join(binarySource, "package.json"))) {
      throw new Error(
        `npm did not install the required package ${platformPackage}.`
      );
    }
    mkdirSync(dirname(binaryDestination), { recursive: true });
    cpSync(binarySource, binaryDestination, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = runtimeEnvironment(),
  cwd = omniRouteDataDir
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stdout = "";
    let settled = false;
    const append = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-5000);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-5000);
      append(chunk);
    });
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error("OmniRoute setup timed out. Check Node.js/npm and try again.")
      );
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start the OmniRoute setup command: ${error.message}`
        )
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, stdout });
    });
  });
}

async function installedVersion(
  node: string,
  entry = omniRouteEntry
): Promise<string | null> {
  if (!existsSync(entry)) return null;
  const result = await runCommand(node, [entry, "--version"], 15_000);
  if (result.code !== 0) return null;
  return result.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null;
}

/**
 * Prefer the complete, CI-tested runtime that ships alongside the portable
 * app when starting a new gateway. Keep configuration, credentials, database,
 * and session data in omniRouteDataDir. This avoids inheriting a partial or
 * stale node_modules tree from another installation sharing the data folder.
 * A live shared gateway is checked before this helper is called.
 */
async function resolveRuntimeForNewGateway(): Promise<{
  node: string;
  entry: string;
}> {
  const node = bundledNodeExecutable();
  const entry = join(
    omniRouteBundleModules,
    "omniroute",
    "bin",
    "omniroute.mjs"
  );
  const manifest = join(omniRouteBundleModules, "omniroute", "package.json");

  if (node && existsSync(entry) && existsSync(manifest)) {
    let packageVersion: string | undefined;
    try {
      packageVersion = (
        JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }
      ).version;
    } catch {
      throw new Error("The bundled OmniRoute package manifest is unreadable.");
    }

    if (packageVersion !== OMNIROUTE_VERSION) {
      throw new Error(
        `The bundled OmniRoute runtime must be ${OMNIROUTE_VERSION}; ` +
          `found ${packageVersion ?? "(unknown)"}.`
      );
    }

    if ((await installedVersion(node, entry)) === OMNIROUTE_VERSION) {
      return { node, entry };
    }
  }

  // Compatibility fallback for development/older builds without a complete
  // bundled runtime. Never run this path over a gateway already listening.
  const fallbackNode = await ensureRuntimeInstalled();
  return { node: fallbackNode, entry: omniRouteEntry };
}

/**
 * On a truly empty data directory, create the required persistent secrets
 * before npm's postinstall can copy the package's publicly known CHANGEME
 * starter password. A random INITIAL_PASSWORD enables management
 * authentication, and the embedded dashboard logs in with it automatically.
 * Existing data
 * directories are deliberately left alone so we cannot rotate secrets for a
 * database that already has keys.
 */
function prepareFreshOmniRouteEnvironment(): void {
  const envPath = join(omniRouteDataDir, ".env");
  try {
    if (readdirSync(omniRouteDataDir).length !== 0 || existsSync(envPath)) {
      return;
    }
  } catch {
    return;
  }

  const contents = [
    `JWT_SECRET=${randomBytes(48).toString("base64url")}`,
    `API_KEY_SECRET=${randomBytes(32).toString("hex")}`,
    // A per-install salt prevents unrelated local accounts from deriving the
    // management token; OmniRoute 3.8.50's bundled CLI honors this variable.
    `OMNIROUTE_CLI_SALT=${randomBytes(32).toString("hex")}`,
    // Keep first-run management endpoints authenticated without requiring the
    // user to manually type a password in Abacus' embedded dashboard.
    `INITIAL_PASSWORD=${randomBytes(32).toString("base64url")}`,
    "",
  ].join("\n");
  try {
    writeFileSync(envPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Windows ACLs inherit from the user's private AppData directory.
    }
  } catch (error) {
    // Another Abacus/Brahma process may have initialized it at the same time.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function findExistingPinnedRuntimeNode(): Promise<string | null> {
  let node: string;
  try {
    node = nodeAndNpm().node;
  } catch {
    return null;
  }
  if (!existsSync(omniRouteEntry)) return null;
  return (await installedVersion(node)) === OMNIROUTE_VERSION ? node : null;
}

async function ensureRuntimeInstalled(): Promise<string> {
  mkdirSync(omniRouteDataDir, { recursive: true });
  prepareFreshOmniRouteEnvironment();
  const { node, npmArgs } = nodeAndNpm();
  let version = await installedVersion(node);
  const bundledManifest = join(
    omniRouteBundleModules,
    "omniroute",
    "package.json"
  );

  if (version !== OMNIROUTE_VERSION && existsSync(bundledManifest)) {
    // A shared Brahma/OmniRoute process may have started since the initial
    // readiness check. Never copy runtime files underneath a live listener.
    if (await portIsOccupied()) {
      throw new Error(
        `Port ${OMNIROUTE_PORT} became occupied during OmniRoute setup; ` +
          "the existing service was left untouched."
      );
    }
    const bundledPackage = JSON.parse(
      readFileSync(bundledManifest, "utf8")
    ) as { version?: string };
    if (bundledPackage.version !== OMNIROUTE_VERSION) {
      throw new Error(
        `Bundled OmniRoute version mismatch; expected ${OMNIROUTE_VERSION}, ` +
          `got ${bundledPackage.version ?? "(unknown)"}.`
      );
    }
    // Copy only executable package dependencies into the shared data directory.
    // Secrets, database files, and existing provider configuration stay in place.
    cpSync(omniRouteBundleModules, join(omniRouteDataDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    version = await installedVersion(node);
  }

  if (version !== OMNIROUTE_VERSION) {
    if (npmArgs.length === 0) {
      throw new Error(
        "The bundled OmniRoute runtime is missing and npm is unavailable. " +
          "Repair the app installation or install Node.js with npm, then retry."
      );
    }
    const result = await runCommand(
      node,
      [
        ...npmArgs,
        "install",
        "--prefix",
        omniRouteDataDir,
        "--no-fund",
        "--no-audit",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=optional",
        `omniroute@${OMNIROUTE_VERSION}`,
      ],
      15 * 60_000,
      runtimeInstallEnvironment()
    );
    if (result.code !== 0) {
      throw new Error(
        "Could not install the pinned OmniRoute runtime. " +
          "Check your internet connection and Node.js/npm installation, " +
          "then retry."
      );
    }
  }

  const verifiedVersion = await installedVersion(node);
  if (verifiedVersion !== OMNIROUTE_VERSION) {
    throw new Error(
      `OmniRoute version verification failed; expected ${OMNIROUTE_VERSION}. ` +
        "No provider keys were changed."
    );
  }
  await ensureRuntimeFallbackPackages(node, npmArgs);
  return node;
}

async function waitForOmniRouteDashboard(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniRouteDashboardReachable()) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return isOmniRouteDashboardReachable();
}

async function waitForOmniRoute(
  child: ChildProcess,
  apiKey: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniRouteReady(apiKey)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return isOmniRouteReady(apiKey);
}

async function isOmniRouteDashboardReachable(): Promise<boolean> {
  try {
    const [modelsResponse, homeResponse] = await Promise.all([
      fetch(`${OMNIROUTE_BASE_URL}/models`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      }),
      // OmniRoute 3.8.50 intentionally redirects "/" to "/dashboard".
      // Inspect the redirect instead of treating a normal same-origin redirect
      // as a failed health check.
      fetch(`${OMNIROUTE_ORIGIN}/`, {
        headers: { Accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(1500),
      }),
    ]);
    if (![200, 401, 403].includes(modelsResponse.status)) return false;

    if (homeResponse.status >= 300 && homeResponse.status < 400) {
      const location = homeResponse.headers.get("location");
      if (!location) return false;
      const destination = new URL(location, OMNIROUTE_ORIGIN);
      return (
        destination.origin === OMNIROUTE_ORIGIN &&
        ["/dashboard", "/login"].includes(destination.pathname)
      );
    }

    if (!homeResponse.ok) return false;
    if (new URL(homeResponse.url).origin !== OMNIROUTE_ORIGIN) return false;
    const dashboard = (await homeResponse.text()).slice(0, 500_000);
    return /omniroute/i.test(dashboard);
  } catch {
    return false;
  }
}

async function isOmniRouteReady(apiKey: string): Promise<boolean> {
  try {
    const [modelsResponse, homeResponse] = await Promise.all([
      fetch(`${OMNIROUTE_BASE_URL}/models`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      }),
      fetch(`${OMNIROUTE_ORIGIN}/`, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(1500),
      }),
    ]);
    if (!modelsResponse.ok || !homeResponse.ok) return false;
    if (new URL(homeResponse.url).origin !== OMNIROUTE_ORIGIN) return false;
    const models = (await modelsResponse.json()) as { data?: unknown };
    const dashboard = (await homeResponse.text()).slice(0, 500_000);
    return Array.isArray(models.data) && /omniroute/i.test(dashboard);
  } catch {
    return false;
  }
}

function readOmniRouteClientKey(): string | null {
  try {
    const value = readFileSync(omniRouteClientKeyPath, "utf8").trim();
    return value.length >= 16 ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "The saved OmniRoute client key could not be read securely."
    );
  }
}

function persistOmniRouteClientKey(apiKey: string): string {
  writeFileSync(omniRouteClientKeyPath, `${apiKey.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(omniRouteClientKeyPath, 0o600);
  } catch {
    // On Windows, inherit the private ACL of the user's LocalAppData folder.
  }
  return apiKey.trim();
}

function readOmniRouteCliSalt(): string {
  const builtinDefaultSalt = "omniroute-cli-auth-v1";
  if (process.env.OMNIROUTE_CLI_SALT !== undefined) {
    return process.env.OMNIROUTE_CLI_SALT || builtinDefaultSalt;
  }

  try {
    const contents = readFileSync(join(omniRouteDataDir, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (
        separator < 0 ||
        trimmed.slice(0, separator).trim() !== "OMNIROUTE_CLI_SALT"
      ) {
        continue;
      }
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value || builtinDefaultSalt;
    }
  } catch {
    // Older shared installations may use OmniRoute's built-in salt.
  }
  return builtinDefaultSalt;
}

/**
 * Match OmniRoute 3.8.50's server-side machine-token derivation locally.
 * Only the HMAC token is sent, as a loopback-only CLI header; the machine ID
 * itself never leaves this process.
 */
function deriveOmniRouteCliToken(runtimeEntry = omniRouteEntry): string | null {
  try {
    const machineIdModule = createRequire(runtimeEntry)("node-machine-id") as {
      machineIdSync?: (original?: boolean) => string;
      default?: { machineIdSync?: (original?: boolean) => string };
    };
    const machineIdSync =
      machineIdModule.machineIdSync || machineIdModule.default?.machineIdSync;
    if (typeof machineIdSync !== "function") return null;
    const rawMachineId = machineIdSync(true);
    if (!rawMachineId) return null;
    return createHmac("sha256", rawMachineId)
      .update(readOmniRouteCliSalt())
      .digest("hex");
  } catch {
    return null;
  }
}

async function createOmniRouteClientKey(
  node: string | null,
  allowCliFallback: boolean,
  runtimeEntry = omniRouteEntry
): Promise<string> {
  const sessionToken = await loginOmniRouteManagement();
  if (sessionToken) {
    try {
      const response = await fetch(`${OMNIROUTE_ORIGIN}/api/keys`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: `auth_token=${sessionToken}`,
          Origin: OMNIROUTE_ORIGIN,
        },
        body: JSON.stringify({ name: "AbacusAI Bot" }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { key?: unknown };
        if (typeof payload.key === "string" && payload.key.length >= 16) {
          // A successful create response is not proof that OmniRoute accepts
          // the key on the OpenAI-compatible endpoint. Verify it before saving.
          if (await isOmniRouteReady(payload.key)) {
            return persistOmniRouteClientKey(payload.key);
          }
          // Continue to the CLI-token route below. Some 3.8.50 installs have
          // returned dashboard-created keys that fail Bearer authentication.
        }
      }
    } catch {
      // Existing shared runtimes may have a different dashboard password.
    }
  }

  if (!allowCliFallback) {
    throw new Error(
      "OmniRoute could not create a client key through its authenticated " +
        "management session. The local dashboard login or API-key setup failed."
    );
  }

  // When dashboard login is unavailable (for example on an existing install),
  // use OmniRoute's loopback-only machine-token header to provision the key.
  // This fallback does not turn off API-key enforcement for inference requests.
  if (!node) {
    throw new Error(
      "OmniRoute could not create the client key through its dashboard session, " +
        "and the matching pinned local runtime is unavailable. The shared gateway " +
        "was left untouched; verify dashboard login or the OmniRoute 3.8.50 install."
    );
  }
  const cliToken = deriveOmniRouteCliToken(runtimeEntry);
  if (!cliToken) {
    throw new Error(
      "OmniRoute's local machine token could not be derived from this installation. " +
        "The existing gateway was left running and untouched."
    );
  }
  let response: Response;
  try {
    response = await fetch(`${OMNIROUTE_ORIGIN}/api/keys`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-omniroute-cli-token": cliToken,
        Origin: OMNIROUTE_ORIGIN,
      },
      body: JSON.stringify({ name: "AbacusAI Bot" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "Could not reach OmniRoute's loopback key provisioning endpoint. " +
        "The existing gateway was left running and untouched."
    );
  }
  if (!response.ok) {
    throw new Error(
      `OmniRoute rejected loopback client-key provisioning ` +
        `(HTTP ${response.status}). ` +
        "The existing gateway was left running and untouched."
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    key?: unknown;
  } | null;
  const apiKey = payload?.key;
  if (typeof apiKey !== "string" || apiKey.length < 16) {
    throw new Error("OmniRoute did not return a valid client API key.");
  }
  if (!(await isOmniRouteReady(apiKey))) {
    throw new Error(
      "OmniRoute created a client key, but the authenticated /v1/models " +
        "check rejected it. No unverified client key was saved."
    );
  }
  return persistOmniRouteClientKey(apiKey);
}

function readInitialManagementPassword(): string | null {
  const environmentValue = process.env.INITIAL_PASSWORD;
  if (typeof environmentValue === "string" && environmentValue.length > 0) {
    return environmentValue;
  }

  try {
    const contents = readFileSync(join(omniRouteDataDir, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (
        separator < 0 ||
        trimmed.slice(0, separator).trim() !== "INITIAL_PASSWORD"
      ) {
        continue;
      }
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : null;
    }
  } catch {
    // Existing installs may manage their password in the dashboard instead.
  }
  return null;
}

async function loginOmniRouteManagement(): Promise<string | null> {
  const password = readInitialManagementPassword();
  if (!password) return null;

  try {
    const response = await fetch(`${OMNIROUTE_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: OMNIROUTE_ORIGIN,
      },
      body: JSON.stringify({ password }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const cookieHeaders = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookie =
      cookieHeaders.getSetCookie?.().join(", ") ||
      response.headers.get("set-cookie") ||
      "";
    return /(?:^|,\s*)auth_token=([^;,\s]+)/.exec(setCookie)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function authenticateOmniRouteDashboard(
  window: BrowserWindow
): Promise<void> {
  const token = await loginOmniRouteManagement();
  if (!token) return;

  try {
    await window.webContents.session.cookies.set({
      url: OMNIROUTE_ORIGIN,
      name: "auth_token",
      value: token,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    });
  } catch {
    // Never block the dashboard from opening if auto-login is unavailable.
  }
}

async function portIsOccupied(): Promise<boolean> {
  try {
    const response = await fetch(OMNIROUTE_ORIGIN, {
      redirect: "manual",
      signal: AbortSignal.timeout(700),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

function startOmniRoute(
  node: string,
  entry: string,
  requireApiKey: boolean
): ChildProcess {
  gatewayOutputTail = "";
  const child = spawn(
    node,
    [entry, "--no-open", "--no-recovery", "--port", String(OMNIROUTE_PORT)],
    {
      cwd: omniRouteDataDir,
      env: runtimeEnvironment(requireApiKey),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", (chunk) => captureGatewayOutput("stdout", chunk));
  child.stderr?.on("data", (chunk) => captureGatewayOutput("stderr", chunk));
  gatewayProcess = child;
  child.once("error", (error) => {
    captureGatewayOutput("stderr", `Failed to spawn gateway: ${error.message}`);
    if (gatewayProcess === child) gatewayProcess = null;
  });
  child.once("exit", () => {
    if (gatewayProcess === child) gatewayProcess = null;
  });
  return child;
}

async function ensureOmniRoute(): Promise<string> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    let clientKey = readOmniRouteClientKey();
    if (clientKey && (await isOmniRouteReady(clientKey))) return clientKey;

    // Prefer a shared Brahma/OmniRoute process when one is already healthy.
    // Creating an API key uses OmniRoute's loopback-only CLI management auth;
    // it does not require stopping or reconfiguring a process owned by Brahma.
    if (await isOmniRouteDashboardReachable()) {
      // Never npm-install or replace files underneath a gateway another app
      // already owns. Dashboard-session provisioning needs no local CLI; the
      // CLI fallback is allowed only when the matching pinned runtime exists.
      const node = await findExistingPinnedRuntimeNode();
      clientKey = await createOmniRouteClientKey(node, true);
      if (await isOmniRouteReady(clientKey)) return clientKey;
      throw new Error(
        "OmniRoute created a client key but the authenticated model endpoint " +
          "did not pass its readiness check."
      );
    }

    if (await portIsOccupied()) {
      throw new Error(
        `Port ${OMNIROUTE_PORT} is already in use by a service that did not pass ` +
          "the OmniRoute health checks. Close or verify that service " +
          "before starting the gateway."
      );
    }

    const { node, entry } = await resolveRuntimeForNewGateway();

    // Start with API-key enforcement enabled before listening on the port.
    // OmniRoute's management API accepts its loopback-only CLI token, so the
    // app can create a real client key without exposing unauthenticated
    // /v1 routes.
    const child = startOmniRoute(node, entry, true);
    if (!(await waitForOmniRouteDashboard(child, 30_000))) {
      if (child.exitCode === null && child.signalCode === null) {
        await stopOmniRoute();
      }
      const output = gatewayOutputForError();
      throw new Error(
        "OmniRoute did not become ready for secure key provisioning. " +
          (output.length > 0
            ? `Recent gateway output:\n${output}`
            : "The gateway emitted no diagnostic output. " +
              "Check the bundled runtime and Windows process permissions.")
      );
    }

    try {
      clientKey = await createOmniRouteClientKey(node, true, entry);
      if (!(await waitForOmniRoute(child, clientKey, 30_000))) {
        throw new Error(
          "OmniRoute did not pass its authenticated readiness check after " +
            "client key creation."
        );
      }
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        await stopOmniRoute();
      }
      throw error;
    }
    return clientKey;
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

type BrahmaProviderKey = {
  provider: string;
  name: string;
  key: string;
};

type OmniRouteProviderConnection = {
  id?: string;
  provider?: string;
  name?: string;
};

type BrahmaKeySyncResult = {
  sourceFound: boolean;
  imported: number;
  updated: number;
  skipped: number;
  openaiConfigured: boolean | null;
};

type OmniRouteCliRuntime = {
  node: string;
  entry: string;
};

const BRAHMA_API_KEY_FIELDS = [
  { field: "openai_api_key", provider: "openai", label: "OpenAI" },
  { field: "anthropic_api_key", provider: "anthropic", label: "Anthropic" },
  { field: "gemini_api_key", provider: "gemini", label: "Gemini" },
  { field: "openrouter_api_key", provider: "openrouter", label: "OpenRouter" },
  { field: "groq_api_key", provider: "groq", label: "Groq" },
  { field: "xai_api_key", provider: "xai", label: "xAI" },
  { field: "cerebras_api_key", provider: "cerebras", label: "Cerebras" },
  { field: "deepseek_api_key", provider: "deepseek", label: "DeepSeek" },
  { field: "mistral_api_key", provider: "mistral", label: "Mistral" },
  { field: "cohere_api_key", provider: "cohere", label: "Cohere" },
] as const;

let brahmaKeySyncPromise: Promise<BrahmaKeySyncResult> | null = null;

function readBrahmaProviderKeys(): {
  sourceFound: boolean;
  keys: BrahmaProviderKey[];
} {
  // Brahma Evo owns this local file on Windows. Never fetch it from GitHub or
  // copy its contents into Abacus settings, logs, telemetry, or process args.
  if (process.platform !== "win32") return { sourceFound: false, keys: [] };

  const localAppData =
    process.env.LOCALAPPDATA ||
    join(app.getPath("home"), "AppData", "Local");
  const apiConfigPath = join(
    localAppData,
    "BrahmaAI",
    "config",
    "api_keys.json"
  );
  if (!existsSync(apiConfigPath)) return { sourceFound: false, keys: [] };

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(apiConfigPath, "utf8"));
  } catch {
    return { sourceFound: true, keys: [] };
  }
  if (
    payload == null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { sourceFound: true, keys: [] };
  }

  const source = payload as Record<string, unknown>;
  const keys = BRAHMA_API_KEY_FIELDS.flatMap(({ field, provider, label }) => {
    const raw = source[field];
    if (typeof raw !== "string") return [];
    const key = raw.trim();
    // Accept only single-line values before forwarding them through stdin.
    if (key.length < 8 || key.length > 4096 || /[\r\n]/.test(key)) return [];
    return [{ provider, name: "Brahma Evo - " + label, key }];
  });
  return { sourceFound: true, keys };
}

async function resolveOmniRouteCliRuntime(): Promise<OmniRouteCliRuntime | null> {
  const bundledNode = bundledNodeExecutable();
  const bundledEntry = join(
    omniRouteBundleModules,
    "omniroute",
    "bin",
    "omniroute.mjs"
  );
  if (bundledNode && existsSync(bundledEntry)) {
    return { node: bundledNode, entry: bundledEntry };
  }

  const node = findExecutable(
    process.platform === "win32" ? ["node.exe", "node"] : ["node"]
  );
  if (!node || !existsSync(omniRouteEntry)) return null;
  try {
    if ((await installedVersion(node, omniRouteEntry)) !== OMNIROUTE_VERSION) {
      return null;
    }
    return { node, entry: omniRouteEntry };
  } catch {
    return null;
  }
}

async function listOmniRouteProviderConnections(
  runtime: OmniRouteCliRuntime
): Promise<OmniRouteProviderConnection[] | null> {
  const result = await runCommand(
    runtime.node,
    [
      runtime.entry,
      "--base-url",
      OMNIROUTE_ORIGIN,
      "--non-interactive",
      "providers",
      "list",
      "--json",
    ],
    15_000,
    runtimeEnvironment()
  );
  if (result.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (parsed == null || typeof parsed !== "object") return null;
    const data = parsed as {
      providers?: unknown;
      connections?: unknown;
    };
    const rows = Array.isArray(data.providers)
      ? data.providers
      : Array.isArray(data.connections)
        ? data.connections
        : null;
    if (!rows) return null;
    return rows.filter(
      (row): row is OmniRouteProviderConnection =>
        row != null &&
        typeof row === "object" &&
        typeof (row as OmniRouteProviderConnection).id === "string" &&
        typeof (row as OmniRouteProviderConnection).provider === "string" &&
        typeof (row as OmniRouteProviderConnection).name === "string"
    );
  } catch {
    return null;
  }
}

function applyBrahmaProviderKey(
  runtime: OmniRouteCliRuntime,
  key: BrahmaProviderKey,
  existing: OmniRouteProviderConnection | undefined
): Promise<boolean> {
  // Credentials are piped through stdin, never included in argv or env vars.
  // Child output is discarded so it cannot echo a provider credential in logs.
  const operation = existing?.id
    ? ["edit", existing.id]
    : ["add", key.provider, "--name", key.name];
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        runtime.node,
        [
          runtime.entry,
          "--base-url",
          OMNIROUTE_ORIGIN,
          "--non-interactive",
          "providers",
          ...operation,
          "--credential-stdin",
        ],
        {
          cwd: omniRouteDataDir,
          env: runtimeEnvironment(),
          windowsHide: true,
          stdio: ["pipe", "ignore", "ignore"],
        }
      );
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      finish(false);
    }, 30_000);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.end(key.key + "\n");
  });
}

async function performBrahmaProviderKeySync(): Promise<BrahmaKeySyncResult> {
  const source = readBrahmaProviderKeys();
  const runtime = await resolveOmniRouteCliRuntime();
  const connections = runtime
    ? await listOmniRouteProviderConnections(runtime)
    : null;
  const knownOpenAI =
    connections?.some(
      (connection) => connection.provider?.toLowerCase() === "openai"
    ) ?? null;

  if (!source.sourceFound) {
    return {
      sourceFound: false,
      imported: 0,
      updated: 0,
      skipped: 0,
      openaiConfigured: knownOpenAI,
    };
  }
  if (!runtime || !connections) {
    return {
      sourceFound: true,
      imported: 0,
      updated: 0,
      skipped: source.keys.length,
      openaiConfigured: knownOpenAI,
    };
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let openaiCredentialApplied = false;
  for (const key of source.keys) {
    // Stable names make repeated syncs idempotent and key rotation update the
    // connection owned by this bridge without modifying other provider entries.
    const existing = connections.find(
      (connection) =>
        connection.provider?.toLowerCase() === key.provider &&
        connection.name === key.name
    );
    const ok = await applyBrahmaProviderKey(runtime, key, existing);
    if (ok) {
      if (existing) updated += 1;
      else imported += 1;
      if (key.provider === "openai") openaiCredentialApplied = true;
    } else {
      skipped += 1;
    }
  }

  return {
    sourceFound: true,
    imported,
    updated,
    skipped,
    openaiConfigured: openaiCredentialApplied || knownOpenAI === true,
  };
}

async function syncBrahmaProviderKeys(): Promise<BrahmaKeySyncResult> {
  if (brahmaKeySyncPromise) return brahmaKeySyncPromise;
  brahmaKeySyncPromise = performBrahmaProviderKeySync();
  try {
    return await brahmaKeySyncPromise;
  } catch {
    // Import is best-effort; an already-running gateway remains usable.
    return {
      sourceFound: false,
      imported: 0,
      updated: 0,
      skipped: 0,
      openaiConfigured: null,
    };
  } finally {
    brahmaKeySyncPromise = null;
  }
}

function ensureAbacusProvider(clientKey: string): void {
  const provider: CustomProviderEntry = {
    id: PROVIDER_ID,
    name: "OmniRoute",
    baseUrl: OMNIROUTE_BASE_URL,
    // This is an API key generated and persisted by OmniRoute itself, not an
    // upstream provider credential or a hard-coded placeholder.
    apiKey: clientKey,
    models: [
      {
        id: "auto",
        name: "OmniRoute Auto",
        reasoning: true,
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
      {
        id: "openai/gpt-6-astra",
        name: "GPT-6 Astra · Deep Reasoning (Paid API)",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        // Model capacity and published standard short-context pricing; long
        // contexts and processing tiers can cost more.
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
    ],
  };
  upsertCustomProvider(provider);
  // Open the gateway settings without unexpectedly resetting a model the user
  // already selected for chats or bots.
  if (!readSettings().defaultModel) {
    setDefaultModel(DEFAULT_MODEL);
  }
}

function openExternalHttps(target: string): void {
  if (isSafeExternalUrl(target) && target.startsWith("https://")) {
    void shell.openExternal(target);
  }
}

/**
 * Start/attach to the local gateway, register its model, and open its window.
 */
export async function openOmniRouteWindow(): Promise<{
  ok: true;
  message: string;
}> {
  let window = dashboardWindow;
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      title: "OmniRoute Gateway",
      width: 1040,
      height: 740,
      minWidth: 780,
      minHeight: 560,
      resizable: true,
      center: true,
      autoHideMenuBar: true,
      backgroundColor: "#111827",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    dashboardWindow = window;
    const createdWindow = window;
    createdWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).origin === OMNIROUTE_ORIGIN) {
          return { action: "allow" };
        }
      } catch {
        // Malformed or non-URL targets are denied below.
      }
      openExternalHttps(url);
      return { action: "deny" };
    });
    createdWindow.once("closed", () => {
      if (dashboardWindow === createdWindow) dashboardWindow = null;
    });
    createdWindow.webContents.on("will-navigate", (event, target) => {
      if (target === OMNIROUTE_STARTUP_PAGE_URL) return;
      try {
        if (new URL(target).origin !== OMNIROUTE_ORIGIN) {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });
    await createdWindow.loadURL(OMNIROUTE_STARTUP_PAGE_URL);
  } else {
    await window.loadURL(OMNIROUTE_STARTUP_PAGE_URL);
  }

  window.show();
  window.focus();
  await updateOmniRouteStartupPage(
    window,
    "Starting OmniRoute",
    "Preparing the secure local gateway. Your saved profile and provider settings are being preserved."
  );

  let keySync: BrahmaKeySyncResult = {
    sourceFound: false,
    imported: 0,
    updated: 0,
    skipped: 0,
    openaiConfigured: null,
  };
  try {
    const clientKey = await ensureOmniRoute();
    keySync = await syncBrahmaProviderKeys();
    ensureAbacusProvider(clientKey);
    await authenticateOmniRouteDashboard(window);
    await window.loadURL(OMNIROUTE_ORIGIN);
  } catch (error) {
    if (!window.isDestroyed()) {
      try {
        await window.loadURL(OMNIROUTE_STARTUP_PAGE_URL);
        await updateOmniRouteStartupPage(
          window,
          "OmniRoute could not start",
          "The gateway did not become ready. Your saved profile and shared OmniRoute data were not reset.",
          error instanceof Error ? error.message : String(error)
        );
        window.show();
        window.focus();
      } catch {
        // Preserve the original gateway error for the settings RPC and logs.
      }
    }
    throw error;
  }

  const keySummary = !keySync.sourceFound
    ? "No Brahma API-key file was found; existing gateway providers were preserved."
    : keySync.skipped > 0
      ? "Synchronized " +
        keySync.imported +
        " new and " +
        keySync.updated +
        " existing Brahma connections; " +
        keySync.skipped +
        " could not be synchronized."
      : "Synchronized " +
        keySync.imported +
        " new and " +
        keySync.updated +
        " existing Brahma provider connections.";
  const astraStatus =
    keySync.openaiConfigured === true
      ? "An OpenAI provider connection is configured for GPT-6 Astra."
      : "To use GPT-6 Astra, configure a valid OpenAI API key in OmniRoute.";
  return {
    ok: true,
    message:
      "OmniRoute is ready. " +
      keySummary +
      " " +
      astraStatus +
      " OmniRoute Auto remains available for routing across your configured providers.",
  };
}

/**
 * Stop only the gateway process tree this app started; never stop a shared instance.
 * OmniRoute's CLI starts a supervisor and a separate server child. On Windows,
 * terminating just the CLI can orphan that server, so taskkill is scoped to the
 * owned CLI PID and its descendants.
 */
export async function stopOmniRoute(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    const taskkill = join(
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
      "System32",
      "taskkill.exe"
    );
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        finish();
      }, 5000);
      killer.once("error", finish);
      killer.once("close", finish);
    });
  } else {
    child.kill("SIGTERM");
  }

  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
