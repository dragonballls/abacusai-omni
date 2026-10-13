import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { platformPlugin, rendererCsp } from "../../web/vite.renderer";
import { RENDERER_CSP } from "../src/main/renderer-csp";
it("R8-T7 pins Electron CSP and refuses a missing platform", () => {
  expect(rendererCsp("electron", {})).toBe(RENDERER_CSP);
  expect(() => rendererCsp(undefined as never, {})).toThrow("platform");
});
it("pins the browser connect-src to 'self' with optional extra sources", () => {
  for (const env of [{}, { VITE_CONNECT_SRC: "" }, { VITE_CONNECT_SRC: " " }])
    expect(rendererCsp("browser", env)).toContain(
      "connect-src 'self'; frame-src 'self' blob:;"
    );
  expect(
    rendererCsp("browser", {
      VITE_CONNECT_SRC: "'self' https://extra.example wss://extra.example",
    })
  ).toContain(
    "connect-src 'self' https://extra.example wss://extra.example; frame-src"
  );
});
it("the web root HTML loads its source entry and carries no CSP", () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "../../web/index.html"),
    "utf8"
  );
  expect(html).toContain('src="/src/entry.tsx"');
  expect(html).not.toContain("Content-Security-Policy");
});
it("the platform transform preserves the current entry without a static splash", async () => {
  const html = readFileSync(
    resolve(import.meta.dirname, "../../web/index.html"),
    "utf8"
  );
  const transform = async (platform: "electron" | "browser") => {
    const plugins = await platformPlugin(platform);
    const hook = plugins.find(
      (plugin) => plugin.name === "abacus:platform"
    )?.transformIndexHtml;
    if (typeof hook !== "function")
      throw new Error("Missing platform HTML hook");
    return (hook as (html: string) => { html: string })(html).html;
  };
  expect(html).toContain('src="/src/entry.tsx"');
  expect(html).toContain('id="root"');
  for (const platform of ["electron", "browser"] as const) {
    const output = await transform(platform);
    expect(output).toContain('src="/src/entry.tsx"');
    expect(output).toContain('id="root"');
    expect(output).not.toContain('id="splash"');
  }
});
