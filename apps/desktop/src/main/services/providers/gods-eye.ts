import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, relative } from "node:path";

import type {
  GodsEyeIntegrationStatus,
  GodsEyeLife360TestResult,
} from "@abacus-ai/contract/contracts";
import { BrowserWindow, safeStorage, shell } from "electron";

import { isSafeExternalUrl } from "../../external-links.js";
import { abacusBotHome } from "../../paths.js";
import { resourcePath } from "../../resources.js";
import {
  Life360HomeAssistantProvider,
  validateHomeAssistantBaseUrl,
  type Life360Location,
} from "./gods-eye-life360.js";
import { buildGodsEyeRefreshUrl } from "./gods-eye-view-url.js";

const GODS_EYE_REVISION = "f88262661211441df6aa999e6ed4bde168366dfd";
const DEFAULT_HA_URL = "http://127.0.0.1:8123";
const STARTUP_TIMEOUT_MS = 45_000;

interface StoredConfig {
  version: 1;
  enabled: boolean;
  baseUrl: string;
  entityIds: string[];
  tokenCipher: string;
}

const configPath = () => join(abacusBotHome(), "gods-eye-life360.json");
const runtimePath = () =>
  join(abacusBotHome(), "integrations", "gods-eye-view-runtime");
let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let appWindow: BrowserWindow | null = null;
let startPromise: Promise<{ origin: string; root: string }> | null = null;
let stopPromise: Promise<void> | null = null;
let life360StatusError: string | null = null;

function readConfig(): StoredConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid");
    const value = raw as Partial<StoredConfig>;
    return {
      version: 1,
      enabled: value.enabled === true,
      baseUrl:
        typeof value.baseUrl === "string" ? value.baseUrl : DEFAULT_HA_URL,
      entityIds: Array.isArray(value.entityIds)
        ? value.entityIds
            .filter((item): item is string => typeof item === "string")
            .slice(0, 100)
        : [],
      tokenCipher:
        typeof value.tokenCipher === "string" ? value.tokenCipher : "",
    };
  } catch {
    return {
      version: 1,
      enabled: false,
      baseUrl: DEFAULT_HA_URL,
      entityIds: [],
      tokenCipher: "",
    };
  }
}

function decryptToken(config: StoredConfig): string {
  if (!config.tokenCipher) return "";
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("OS secure storage is unavailable.");
  try {
    return safeStorage.decryptString(Buffer.from(config.tokenCipher, "base64"));
  } catch {
    throw new Error(
      "Saved Home Assistant token could not be decrypted. Save a new token."
    );
  }
}

function saveConfig(config: StoredConfig): void {
  const target = configPath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp =
    target + "." + process.pid + "." + randomBytes(5).toString("hex") + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, target);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* Windows ACLs are per-user. */
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

function findSource(): string | null {
  const candidates = [
    resourcePath("gods-eye-view"),
    join(process.cwd(), "integrations", "gods-eye-view"),
    join(import.meta.dirname, "../../../../../../integrations/gods-eye-view"),
  ];
  return (
    candidates.find(
      (path) =>
        existsSync(join(path, "package.json")) &&
        existsSync(join(path, "server", "standalone", "vite.config.js"))
    ) ?? null
  );
}

function runtimeRoot(): string {
  const source = findSource();
  if (!source) throw new Error("God's Eye source is missing from this build.");
  const root = runtimePath();
  const marker = join(root, ".abacus-gods-eye-revision");
  const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
  let revision = "";
  try {
    revision = readFileSync(marker, "utf8").trim();
  } catch {
    /* First run. */
  }
  if (
    revision === GODS_EYE_REVISION &&
    existsSync(viteCli) &&
    existsSync(join(root, "src", "main.js"))
  )
    return root;

  mkdirSync(dirname(root), { recursive: true });
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
      )
        return false;
      if (parts.includes(".cache") && parts.includes("node_modules"))
        return false;
      if (basename.startsWith(".env") && basename !== ".env.example")
        return false;
      return true;
    },
  });
  if (!existsSync(viteCli))
    throw new Error(
      "God's Eye dependencies are not packaged. Rebuild the installer."
    );
  writeFileSync(marker, GODS_EYE_REVISION + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return root;
}

function findNode(): string {
  const bundledGodsEye = resourcePath(
    "gods-eye-node",
    process.platform === "win32" ? "node.exe" : "node"
  );
  const bundledOmniRoute = resourcePath("omniroute-runtime", "node.exe");
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    ...(existsSync(bundledGodsEye) ? [bundledGodsEye] : []),
    ...(process.platform === "win32" && existsSync(bundledOmniRoute)
      ? [bundledOmniRoute]
      : []),
    ...entries.flatMap((entry) => [
      join(entry, process.platform === "win32" ? "node.exe" : "node"),
    ]),
    ...(process.env.PROGRAMFILES
      ? [join(process.env.PROGRAMFILES, "nodejs", "node.exe")]
      : []),
    ...(process.env.LOCALAPPDATA
      ? [join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe")]
      : []),
  ];
  const node = candidates.find(existsSync);
  if (!node)
    throw new Error(
      "God's Eye requires Node 24.14.x or 26.x; bundled Node is preferred on Windows."
    );
  const result = spawnSync(node, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(
    String(result.stdout ?? "").trim()
  );
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (
    result.error ||
    result.status !== 0 ||
    !((major === 24 && minor >= 14) || major === 26)
  )
    throw new Error("God's Eye requires supported Node 24.14.x or 26.x.");
  return node;
}

function launchEnvironment(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const safeNames = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "XDG_CONFIG_HOME",
  ];
  for (const name of safeNames)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    HOST: "127.0.0.1",
    PORT: String(port),
    GEV_ALLOWED_HOSTS: "127.0.0.1,localhost",
    GEV_LAUNCHER: "abacus",
    NODE_ENV: "development",
  };
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port for God's Eye."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitUntilReady(
  child: ChildProcess,
  port: number
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null)
      throw new Error("God's Eye local server exited during startup.");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/", {
        redirect: "error",
        signal: AbortSignal.timeout(800),
      });
      if (response.ok) return;
    } catch {
      /* The listener has not bound yet. */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error("God's Eye local server did not start before the deadline.");
}

async function stopChild(): Promise<void> {
  const child = serverProcess;
  serverProcess = null;
  serverPort = null;
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32" && child.pid != null) {
    const killed = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      }
    );
    if (!killed.error && killed.status === 0) return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* It already exited. */
        }
      }
      resolveWait();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

async function startServer(): Promise<{ origin: string; root: string }> {
  if (stopPromise) await stopPromise;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    if (serverProcess && serverPort != null && serverProcess.exitCode == null) {
      try {
        const response = await fetch("http://127.0.0.1:" + serverPort + "/", {
          redirect: "error",
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok)
          return {
            origin: "http://127.0.0.1:" + serverPort,
            root: runtimePath(),
          };
      } catch {
        /* Stale process handle: restart below. */
      }
      await stopChild();
    }

    const root = runtimeRoot();
    const node = findNode();
    const vite = join(root, "node_modules", "vite", "bin", "vite.js");
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await reservePort();
      const child = spawn(
        node,
        [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        {
          cwd: root,
          env: launchEnvironment(port),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }
      );
      serverProcess = child;
      serverPort = port;
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", () => undefined);
      child.once("error", () => {
        if (serverProcess === child) {
          serverProcess = null;
          serverPort = null;
        }
      });
      child.once("exit", () => {
        if (serverProcess === child) {
          serverProcess = null;
          serverPort = null;
        }
      });
      try {
        await waitUntilReady(child, port);
        return { origin: "http://127.0.0.1:" + port, root };
      } catch {
        await stopChild();
      }
    }
    throw new Error(
      "God's Eye failed to start. Verify its pinned source, dependencies, and Node runtime."
    );
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    title: "God's Eye View — AbacusAI Bot",
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  appWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url))
      void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    try {
      if (new URL(target).origin === origin) return;
    } catch {
      /* Block malformed targets. */
    }
    event.preventDefault();
    if (isSafeExternalUrl(target))
      void shell.openExternal(target).catch(() => undefined);
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    if (appWindow === window) {
      appWindow = null;
      void stopGodsEyeServer();
    }
  });
  return window;
}

async function readLife360(
  config: StoredConfig
): Promise<{ locations: Life360Location[]; error: string | null }> {
  if (!config.enabled) return { locations: [], error: null };
  let token = "";
  try {
    token = decryptToken(config);
  } catch (error) {
    return {
      locations: [],
      error:
        error instanceof Error
          ? error.message
          : "Secure storage is unavailable.",
    };
  }
  const result = await new Life360HomeAssistantProvider({
    enabled: true,
    baseUrl: config.baseUrl,
    token,
    entityIds: config.entityIds,
  }).locations();
  return {
    locations: result.success ? result.locations : [],
    error: result.success ? null : (result.error ?? "Life360 refresh failed."),
  };
}

async function refreshOpenGodsEyeMap(
  locations: readonly Life360Location[]
): Promise<boolean> {
  const window = appWindow;
  if (!window || window.isDestroyed()) return true;
  try {
    const current = window.webContents.getURL();
    const url = new URL(current);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      return false;
    }
    await window.loadURL(buildGodsEyeRefreshUrl(current, locations));
    return true;
  } catch {
    return false;
  }
}

export function getGodsEyeStatus(): GodsEyeIntegrationStatus {
  const config = readConfig();
  const source = findSource();
  const runtimeReady =
    source != null &&
    existsSync(join(source, "node_modules", "vite", "bin", "vite.js"));
  return {
    runtimeAvailable: source != null,
    runtimeReady,
    running: serverProcess != null && serverProcess.exitCode == null,
    windowOpen: appWindow != null && !appWindow.isDestroyed(),
    life360: {
      enabled: config.enabled,
      configured: config.tokenCipher.length > 0,
      baseUrl: config.baseUrl,
      entityIds: [...config.entityIds],
      error:
        life360StatusError ??
        (config.enabled && !config.tokenCipher
          ? "Life360 is enabled but no Home Assistant token is saved."
          : null),
    },
  };
}

export async function saveGodsEyeLife360Settings(input: {
  enabled: boolean;
  baseUrl: string;
  token: string;
  clearToken?: boolean;
  entityIds: string[];
}): Promise<GodsEyeIntegrationStatus> {
  const baseUrl =
    String(input.baseUrl ?? DEFAULT_HA_URL).trim() || DEFAULT_HA_URL;
  const entityIds = [
    ...new Set(
      (input.entityIds ?? []).map((item) => item.trim()).filter(Boolean)
    ),
  ];
  if (
    entityIds.length > 100 ||
    entityIds.some((item) => !/^device_tracker\.[a-z0-9_]+$/i.test(item))
  )
    throw new Error(
      "Use at most 100 valid Home Assistant device_tracker entity IDs."
    );
  await validateHomeAssistantBaseUrl(baseUrl);
  const current = readConfig();
  let tokenCipher = current.tokenCipher;
  const newToken = String(input.token ?? "").trim();
  if (input.clearToken) tokenCipher = "";
  else if (newToken) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error(
        "OS secure storage is unavailable; the Life360 token was not saved."
      );
    tokenCipher = safeStorage.encryptString(newToken).toString("base64");
  }
  if (input.enabled && !tokenCipher)
    throw new Error("Enter a Home Assistant token before enabling Life360.");
  saveConfig({
    version: 1,
    enabled: input.enabled,
    baseUrl,
    entityIds,
    tokenCipher,
  });
  life360StatusError = null;
  if (!input.enabled && !(await refreshOpenGodsEyeMap([]))) {
    life360StatusError =
      "Life360 was disconnected, but the open map could not be refreshed. Close and reopen God's Eye to remove any remaining location pins.";
  }
  return getGodsEyeStatus();
}

export async function testGodsEyeLife360(): Promise<GodsEyeLife360TestResult> {
  const result = await readLife360(readConfig());
  if (result.error)
    return { success: false, locationCount: 0, message: result.error };
  return {
    success: true,
    locationCount: result.locations.length,
    message:
      "Home Assistant responded. " +
      result.locations.length +
      " authorized Life360 location" +
      (result.locations.length === 1 ? "" : "s") +
      " found.",
  };
}

export async function openGodsEyeWindow(): Promise<{
  ok: boolean;
  message: string;
}> {
  const server = await startServer();
  const config = readConfig();
  const refreshed = await readLife360(config);
  const currentWindow = appWindow;
  const window =
    !currentWindow || currentWindow.isDestroyed()
      ? createWindow(server.origin)
      : currentWindow;
  const current = window.webContents.getURL();
  const currentUrl =
    current === server.origin || current.startsWith(server.origin + "/")
      ? current
      : server.origin + "/";
  try {
    await window.loadURL(
      buildGodsEyeRefreshUrl(currentUrl, refreshed.locations)
    );
    life360StatusError = refreshed.error;
    window.show();
    window.focus();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw new Error(
      "God's Eye could not load its local UI: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
  const status = !config.enabled
    ? "Life360 is disabled; no family locations were added."
    : refreshed.error
      ? "Life360 could not refresh: " + refreshed.error
      : refreshed.locations.length +
        " authorized Life360 location" +
        (refreshed.locations.length === 1 ? "" : "s") +
        " refreshed.";
  return {
    ok: true,
    message: "God's Eye opened with its full local console. " + status,
  };
}

export async function stopGodsEyeServer(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopPromise = stopChild().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

export async function stopGodsEye(): Promise<void> {
  const window = appWindow;
  appWindow = null;
  if (window && !window.isDestroyed()) {
    try {
      window.destroy();
    } catch {
      /* Closing was already underway. */
    }
  }
  await stopGodsEyeServer();
}
