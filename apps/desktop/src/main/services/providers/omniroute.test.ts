import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./omniroute.ts", import.meta.url), "utf8");

describe("local OmniRoute gateway security contract", () => {
  it("binds only to loopback and requires API keys for an app-owned gateway", () => {
    expect(source).toContain('OMNIROUTE_SERVER_HOST: "127.0.0.1"');
    expect(source).toContain("OMNIROUTE_PORT: String(OMNIROUTE_PORT)");
    expect(source).toContain(
      'REQUIRE_API_KEY: requireApiKey ? "true" : "false"'
    );
    const environmentStart = source.indexOf("function runtimeEnvironment(");
    const environmentEnd = source.indexOf("\n}\n", environmentStart);
    const environment = source.slice(environmentStart, environmentEnd);
    expect(environment).toContain("delete environment.API_PORT");
    expect(environment).toContain("delete environment.DASHBOARD_PORT");
    expect(environment).not.toContain("API_PORT:");
    expect(environment).not.toContain("DASHBOARD_PORT:");
    expect(source).toContain("startOmniRoute(node, entry, true)");
    expect(source).not.toContain("startOmniRoute(node, false)");
    const launcherStart = source.indexOf("function startOmniRoute(");
    const launcherEnd = source.indexOf("\n}\n", launcherStart);
    expect(launcherStart).toBeGreaterThanOrEqual(0);
    expect(launcherEnd).toBeGreaterThan(launcherStart);
    expect(source.slice(launcherStart, launcherEnd)).toContain(
      '"--no-recovery"'
    );
  });

  it("accepts OmniRoute's normal same-origin dashboard redirect during startup", () => {
    const start = source.indexOf(
      "async function isOmniRouteDashboardReachable()"
    );
    const end = source.indexOf("async function isOmniRouteReady", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const probe = source.slice(start, end);
    expect(probe).toContain('redirect: "manual"');
    expect(probe).toContain(
      '["/dashboard", "/login"].includes(destination.pathname)'
    );
    expect(probe).toContain("destination.origin === OMNIROUTE_ORIGIN");
  });

  it("provisions and securely persists an OmniRoute client key", () => {
    const provisioning = source.slice(
      source.indexOf("async function createOmniRouteClientKey("),
      source.indexOf("function readInitialManagementPassword(")
    );
    expect(provisioning).toContain("`${OMNIROUTE_ORIGIN}/api/keys`");
    expect(provisioning.match(/method: "POST"/g)).toHaveLength(2);
    expect(
      source.match(/JSON\.stringify\(\{ name: "AbacusAI Bot" \}\)/g)
    ).toHaveLength(2);
    expect(source).toContain(
      "function persistOmniRouteClientKey(apiKey: string)"
    );
    expect(source).toContain("chmodSync(omniRouteClientKeyPath, 0o600)");
    expect(source).toContain("OMNIROUTE_CLI_SALT");
    expect(source).toContain("deriveOmniRouteCliToken");
    expect(source).toContain('"x-omniroute-cli-token": cliToken');
    expect(source).toContain(
      'OMNIROUTE_CLI_SALT=${randomBytes(32).toString("hex")}'
    );
    expect(source).toContain("INITIAL_PASSWORD=");
    expect(source).toContain("authenticateOmniRouteDashboard(dashboardWindow)");
    expect(source).toContain("readInitialManagementPassword()");
    expect(source).toContain("createOmniRouteClientKey(node, true)");
    expect(source).not.toContain("createOmniRouteClientKey(node, false)");
    expect(source).toContain("loginOmniRouteManagement()");
    expect(source).toContain("Cookie: `auth_token=${sessionToken}`");
    expect(source).toContain("apiKey: clientKey");
    expect(source).not.toContain('apiKey: "local-omniroute"');
  });

  it("uses the bundled Windows runtime before system Node/npm", () => {
    expect(source).toContain(
      'join(process.resourcesPath, "omniroute-runtime")'
    );
    expect(source).toContain(
      'const omniRouteBundleNode = join(omniRouteBundleRoot, "node.exe")'
    );
    expect(source).toContain("function bundledNodeExecutable()");
    expect(source).toContain("const bundledNode = bundledNodeExecutable()");
    expect(source).toContain(
      'cpSync(omniRouteBundleModules, join(omniRouteDataDir, "node_modules"), {'
    );
    expect(source).toContain("if (npmArgs.length === 0)");
    expect(source).toContain("The bundled OmniRoute runtime is missing");
  });

  it("rejects Node.js versions outside OmniRoute's supported engine range", () => {
    expect(source).toContain('spawnSync(node, ["--version"]');
    expect(source).toContain("22.22.2");
    expect(source).toContain("major >= 24 && major < 27");
  });

  it("restores the required platform-matched esbuild binary", () => {
    expect(source).toContain('"--legacy-peer-deps"');
    expect(source).toContain('"--ignore-scripts"');
    expect(source).toContain('"--omit=optional"');
    expect(source).toContain("async function ensureRuntimeFallbackPackages(");
    expect(source).toContain('"@swc/helpers", "sql.js", "node-machine-id"');
    expect(source).toContain(
      "const platformPackage = `@esbuild/${process.platform}-${process.arch}`;"
    );
    expect(source).toContain("`${platformPackage}@${platformVersion}`");
    expect(source).toContain("rmSync(tempDir");
  });

  it("skips optional browser downloads during API-gateway installation", () => {
    const installStart = source.indexOf("function runtimeInstallEnvironment()");
    const installEnd = source.indexOf("\n}\n", installStart);
    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installEnd).toBeGreaterThan(installStart);
    const environment = source.slice(installStart, installEnd);
    expect(environment).toContain('OMNIROUTE_SKIP_POSTINSTALL: "1"');
    expect(environment).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"');
    expect(environment).toContain('PUPPETEER_SKIP_DOWNLOAD: "1"');
  });

  it("sets OmniRoute Auto and preserves an existing shared gateway runtime", () => {
    expect(source).toContain('const DEFAULT_MODEL = "omniroute/auto";');
    expect(source).toContain('id: "auto"');
    expect(source).toContain("upsertCustomProvider(provider)");
    expect(source).toContain("findExistingPinnedRuntimeNode()");
    expect(source).toContain("The shared gateway ");
    expect(source).toContain("was left untouched");
  });

  it("shuts down the app-owned Windows gateway process tree", () => {
    expect(source).toContain('"/PID", String(child.pid), "/T", "/F"');
    expect(source).toContain("taskkill.exe");
    expect(source).toContain('child.kill("SIGTERM")');
    expect(source).toContain('child.kill("SIGKILL")');
  });

  it("authenticates model readiness probes and refuses redirects", () => {
    const start = source.indexOf(
      "async function isOmniRouteReady(apiKey: string)"
    );
    const end = source.indexOf("function readOmniRouteClientKey()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const probe = source.slice(start, end);
    expect(probe).toContain("Authorization: `Bearer ${apiKey}`");
    expect(probe).toContain('redirect: "error"');
    expect(probe).toContain("Array.isArray(models.data)");
  });
});

describe("OmniRoute startup reliability", () => {
  it("uses the complete bundled runtime for a new gateway when it is present", () => {
    expect(source).toContain("async function resolveRuntimeForNewGateway()");
    expect(source).toContain(
      "const { node, entry } = await resolveRuntimeForNewGateway()"
    );
    expect(source).toContain("startOmniRoute(node, entry, true)");
    expect(source).toContain("installedVersion(node, entry)");
  });

  it("captures bounded gateway output on startup failure", () => {
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(source).toContain('captureGatewayOutput("stdout", chunk)');
    expect(source).toContain('captureGatewayOutput("stderr", chunk)');
    expect(source).toContain("gatewayOutputForError()");
    expect(source).toContain("Recent gateway output:");
    expect(source).toContain("-12_000");
  });

  it("uses the selected runtime entry for loopback CLI-key derivation", () => {
    expect(source).toContain("deriveOmniRouteCliToken(runtimeEntry)");
    expect(source).toContain("createRequire(runtimeEntry)");
  });
});
