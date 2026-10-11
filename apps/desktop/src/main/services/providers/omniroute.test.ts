import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./omniroute.ts", import.meta.url), "utf8");

describe("local OmniRoute gateway security contract", () => {
  it(
    "binds only to loopback and requires API keys for an app-owned gateway",
    () => {
      expect(source).toContain('OMNIROUTE_SERVER_HOST: "127.0.0.1"');
      expect(source).toContain(
        'REQUIRE_API_KEY: requireApiKey ? "true" : "false"',
      );
      expect(source).toContain("startOmniRoute(node, true)");
      expect(source).not.toContain("startOmniRoute(node, false)");
    },
  );

  it(
    "accepts OmniRoute's normal same-origin dashboard redirect during startup",
    () => {
      const start = source.indexOf(
        "async function isOmniRouteDashboardReachable()",
      );
      const end = source.indexOf("async function isOmniRouteReady", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const probe = source.slice(start, end);
      expect(probe).toContain('redirect: "manual"');
      expect(probe).toContain(
        '["/dashboard", "/login"].includes(destination.pathname)',
      );
      expect(probe).toContain("destination.origin === OMNIROUTE_ORIGIN");
    },
  );

  it(
    "provisions a real OmniRoute client key and persists it with restrictive permissions",
    () => {
      expect(source).toContain('"api-keys"');
      expect(source).toContain('"post-api-keys"');
      expect(
        source.match(/JSON\.stringify\(\{ name: "AbacusAI Bot" \}\)/g),
      ).toHaveLength(2);
      expect(source).toContain(
        "function persistOmniRouteClientKey(apiKey: string)",
      );
      expect(source).toContain("chmodSync(omniRouteClientKeyPath, 0o600)");
      expect(source).toContain("OMNIROUTE_CLI_SALT");
      expect(source).toMatch(/\x60OMNIROUTE_CLI_SALT=\$\{randomBytes/);
      expect(source).toContain("INITIAL_PASSWORD=");
      expect(source).toContain("authenticateOmniRouteDashboard(dashboardWindow)");
      expect(source).toContain("readInitialManagementPassword()");
      expect(source).toContain("createOmniRouteClientKey(node, true)");
      expect(source).not.toContain("createOmniRouteClientKey(node, false)");
      expect(source).toContain("loginOmniRouteManagement()");
      expect(source).toContain("Cookie: `auth_token=${sessionToken}`");
      expect(source).toContain("apiKey: clientKey");
      expect(source).not.toContain('apiKey: "local-omniroute"');
    },
  );

  it("authenticates model readiness probes and refuses redirects", () => {
    const start = source.indexOf(
      "async function isOmniRouteReady(apiKey: string)",
    );
    const end = source.indexOf("function readOmniRouteClientKey()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const probe = source.slice(start, end);
    expect(probe).toContain('Authorization: `Bearer ${apiKey}`');
    expect(probe).toContain('redirect: "error"');
    expect(probe).toContain("Array.isArray(models.data)");
  });
});
