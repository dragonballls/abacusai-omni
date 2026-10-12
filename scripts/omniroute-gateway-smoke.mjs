#!/usr/bin/env node
import { spawn } from "node:child_process";
/**
 * Real OmniRoute 3.8.50 smoke test with a disposable data directory.
 *
 * Exercises fresh-install management login, real API-key creation, enforced
 * authentication on /v1/models, and authenticated model discovery. No upstream
 * credential is needed, and no persistent user data is touched.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "3.8.50";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 90_000;
const origin = (port) => `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    address && typeof address === "object",
    "Could not reserve a loopback port."
  );
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function runCommand(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const append = (chunk) => {
      output = (output + String(chunk)).slice(-12_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out. Last output:\n${output}`));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(7500),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function getDashboardAndModels(gatewayOrigin) {
  try {
    const [home, models] = await Promise.all([
      fetch(`${gatewayOrigin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      }),
      fetch(`${gatewayOrigin}/v1/models`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      }),
    ]);
    const location = home.headers.get("location");
    if (!location || home.status < 300 || home.status >= 400) return null;
    const destination = new URL(location, gatewayOrigin);
    if (
      destination.origin !== gatewayOrigin ||
      !["/dashboard", "/login"].includes(destination.pathname)
    ) {
      return null;
    }
    if (![401, 403].includes(models.status)) return null;
    return { home, models };
  } catch {
    return null;
  }
}

async function waitForSecureGateway(child, gatewayOrigin) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `OmniRoute exited before secure readiness (code ${child.exitCode}, signal ${child.signalCode}).`
      );
    }
    const ready = await getDashboardAndModels(gatewayOrigin);
    if (ready) return ready;
    await delay(500);
  }
  throw new Error(
    "OmniRoute did not become ready with API-key enforcement enabled."
  );
}

async function createAuthenticatedKey(gatewayOrigin, password) {
  const response = await fetch(`${gatewayOrigin}/api/auth/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: gatewayOrigin,
    },
    body: JSON.stringify({ password }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const loginPayload = await response.json().catch(() => null);
  assert(
    response.ok && loginPayload?.success === true,
    `Fresh-install management login failed (HTTP ${response.status}).`
  );

  const headers = response.headers;
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  const token = cookies
    .map((cookie) => /(?:^|;\s*)auth_token=([^;,\s]+)/.exec(cookie)?.[1])
    .find(Boolean);
  assert(
    token,
    "Management login succeeded but did not return an auth_token cookie."
  );

  const createResponse = await fetch(`${gatewayOrigin}/api/keys`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `auth_token=${token}`,
      Origin: gatewayOrigin,
    },
    body: JSON.stringify({ name: "AbacusAI Bot smoke test" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await createResponse.json().catch(() => null);
  assert(
    createResponse.status === 201 &&
      typeof payload?.key === "string" &&
      payload.key.length >= 16,
    `Real API-key creation failed (HTTP ${createResponse.status}).`
  );
  return payload.key;
}

function deriveCliToken(entry, salt) {
  const machineIdModule = createRequire(entry)("node-machine-id");
  const machineIdSync =
    machineIdModule.machineIdSync || machineIdModule.default?.machineIdSync;
  assert(
    typeof machineIdSync === "function",
    "Could not load OmniRoute's machine-id implementation."
  );
  const rawMachineId = machineIdSync(true);
  assert(rawMachineId, "Could not derive the local OmniRoute machine ID.");
  return createHmac("sha256", rawMachineId).update(salt).digest("hex");
}

async function createCliProvisionedKey(gatewayOrigin, entry, cliSalt) {
  const cliToken = deriveCliToken(entry, cliSalt);
  const response = await fetch(`${gatewayOrigin}/api/keys`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-omniroute-cli-token": cliToken,
      Origin: gatewayOrigin,
    },
    body: JSON.stringify({ name: "AbacusAI Bot CLI fallback smoke test" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  assert(
    response.status === 201 &&
      typeof payload?.key === "string" &&
      payload.key.length >= 16,
    `CLI-token API-key creation failed (HTTP ${response.status}).`
  );
  return payload.key;
}

async function assertAuthenticatedModels(gatewayOrigin, clientKey, label) {
  const response = await fetch(`${gatewayOrigin}/v1/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${clientKey}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  assert(
    response.ok && Array.isArray(payload?.data),
    `${label} API key was rejected by /v1/models (HTTP ${response.status}).`
  );
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "abacus-omniroute-smoke-"));
  const dataDir = join(temp, "data");
  const port = await freeLoopbackPort();
  const gatewayOrigin = origin(port);
  const password = randomBytes(32).toString("base64url");
  const cliSalt = randomBytes(32).toString("hex");
  const envFile = [
    `JWT_SECRET=${randomBytes(48).toString("base64url")}`,
    `API_KEY_SECRET=${randomBytes(32).toString("hex")}`,
    `OMNIROUTE_CLI_SALT=${cliSalt}`,
    `INITIAL_PASSWORD=${password}`,
    "",
  ].join("\n");
  let gateway = null;
  let gatewayOutput = "";

  try {
    // Match the app's first-install order: create random secrets before npm's
    // install scripts can initialize the data folder.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, ".env"), envFile, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const install = await runCommand(
      "npm",
      [
        "install",
        "--prefix",
        dataDir,
        "--no-fund",
        "--no-audit",
        "--omit=dev",
        `omniroute@${VERSION}`,
      ],
      { cwd: dataDir, env: process.env },
      INSTALL_TIMEOUT_MS
    );
    assert(
      install.code === 0,
      `Could not install pinned OmniRoute ${VERSION}. Last output:\n${install.output}`
    );

    const entry = join(
      dataDir,
      "node_modules",
      "omniroute",
      "bin",
      "omniroute.mjs"
    );
    const metadata = JSON.parse(
      readFileSync(
        join(dataDir, "node_modules", "omniroute", "package.json"),
        "utf8"
      )
    );
    assert(
      metadata.version === VERSION,
      `Expected OmniRoute ${VERSION}, got ${metadata.version}.`
    );

    gateway = spawn(
      process.execPath,
      [entry, "--no-open", "--no-recovery", "--port", String(port)],
      {
        cwd: dataDir,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          PORT: String(port),
          API_PORT: String(port),
          DASHBOARD_PORT: String(port),
          OMNIROUTE_SERVER_HOST: "127.0.0.1",
          OMNIROUTE_TELEMETRY: "false",
          REQUIRE_API_KEY: "true",
          NODE_ENV: "production",
          JWT_SECRET: envFile.match(/^JWT_SECRET=(.+)$/m)[1],
          API_KEY_SECRET: envFile.match(/^API_KEY_SECRET=(.+)$/m)[1],
          OMNIROUTE_CLI_SALT: cliSalt,
          INITIAL_PASSWORD: password,
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    gateway.stdout?.on("data", (chunk) => {
      gatewayOutput = (gatewayOutput + String(chunk)).slice(-12_000);
    });
    gateway.stderr?.on("data", (chunk) => {
      gatewayOutput = (gatewayOutput + String(chunk)).slice(-12_000);
    });
    await waitForSecureGateway(gateway, gatewayOrigin);

    const dashboardKey = await createAuthenticatedKey(gatewayOrigin, password);
    const cliKey = await createCliProvisionedKey(gatewayOrigin, entry, cliSalt);
    await assertAuthenticatedModels(
      gatewayOrigin,
      dashboardKey,
      "Dashboard-created"
    );
    await assertAuthenticatedModels(gatewayOrigin, cliKey, "CLI-token-created");
    console.log(
      `[omniroute-smoke] v${VERSION}: secure loopback startup, dashboard login, dashboard and CLI-token key creation, and authenticated /v1/models checks passed (upstream providers intentionally unconfigured).`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nLast OmniRoute output:\n${gatewayOutput}`);
  } finally {
    await stopGateway(gateway);
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
