import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startRegistryProxy, UPSTREAM } from "./shadcn-registry-proxy.mjs";
import { LOCAL_UI_OVERRIDES } from "./shadcn-registry-snapshot.mjs";
import { INITIAL_ITEMS } from "./shadcn.mjs";

const get = (url, path) =>
  new Promise((resolve, reject) => {
    const req = request(url, { path }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

test("app-local UI overrides stay explicit and preserve popup helper consumers", () => {
  const expected = [
    "alert.tsx",
    "attachment.tsx",
    "combobox.tsx",
    "command.tsx",
    "context-menu.tsx",
    "dropdown-menu.tsx",
    "hover-card.tsx",
    "item.tsx",
    "popover.tsx",
    "popup.tsx",
    "select.tsx",
    "tooltip.tsx",
  ];
  assert.deepEqual([...LOCAL_UI_OVERRIDES].sort(), expected);
  const uiRoot = join(import.meta.dirname, "../../web/src/ui");
  for (const file of expected) {
    assert.ok(
      existsSync(join(uiRoot, file)),
      `${file} should remain in renderer UI`
    );
  }
  assert.ok(
    !INITIAL_ITEMS.includes("alert"),
    "alert is intentionally local-only"
  );
  assert.ok(!INITIAL_ITEMS.includes("popup"), "popup is a shared local helper");
  const popup = readFileSync(join(uiRoot, "popup.tsx"), "utf8");
  for (const helper of [
    "popupPositioning",
    "popupItemTitle",
    "popupItemChildren",
  ]) {
    assert.ok(popup.includes(helper), `${helper} remains available`);
  }
  for (const file of [
    "combobox.tsx",
    "command.tsx",
    "context-menu.tsx",
    "dropdown-menu.tsx",
    "hover-card.tsx",
    "popover.tsx",
    "select.tsx",
    "tooltip.tsx",
  ]) {
    assert.match(
      readFileSync(join(uiRoot, file), "utf8"),
      /from "#renderer\/ui\/popup"/,
      `${file} uses shared popup helpers`
    );
  }
});

test("recording confines requests to the registry and replays long query paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-proxy-test-"));
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, options) => {
    fetched.push({ url: String(url), options });
    return new Response('{"registry":"fixture"}', {
      headers: { "content-type": "application/json" },
    });
  };
  let proxy = await startRegistryProxy({ mode: "record", dir, cli: "test" });
  try {
    for (const path of [
      "//127.0.0.1/private",
      "http://127.0.0.1/private",
      "/\\127.0.0.1/private",
    ])
      assert.equal((await get(proxy.url, path)).status, 400);
    assert.equal(fetched.length, 0);
    const path = `/init?theme=${"x".repeat(400)}`;
    const result = await get(proxy.url, path);
    assert.deepEqual(result, { status: 200, body: '{"registry":"fixture"}' });
    assert.equal(fetched[0].url, `${UPSTREAM}${path}`);
    assert.equal(fetched[0].options.redirect, "error");
    await proxy.close();
    proxy = null;
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8")
    );
    assert.equal(
      manifest.entries[0].file,
      `${createHash("sha256").update(path).digest("hex")}.body`
    );
    proxy = await startRegistryProxy({ mode: "replay", dir });
    assert.deepEqual(await get(proxy.url, path), result);
    assert.equal(fetched.length, 1);
  } finally {
    await proxy?.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP errors do not reveal local paths or stack traces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-proxy-test-"));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  globalThis.fetch = async () => {
    throw new Error("secret local path");
  };
  console.error = (...args) => errors.push(args);
  const proxy = await startRegistryProxy({ mode: "record", dir, cli: "test" });
  try {
    assert.deepEqual(await get(proxy.url, "/r/test.json"), {
      status: 502,
      body: "registry proxy request failed",
    });
    assert.equal(errors.length, 1);
  } finally {
    await proxy.close();
    globalThis.fetch = originalFetch;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});
