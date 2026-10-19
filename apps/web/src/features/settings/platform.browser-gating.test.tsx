import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

import { settingsIndexFor } from "./search-index";
it("browser search hides native pages, native controls and local model shortcuts", () => {
  const entries = settingsIndexFor(false, "mac");
  expect(
    entries.some((entry) => ["browser", "devices"].includes(entry.page))
  ).toBe(false);
  expect(
    entries.filter((entry) => entry.page === "about").map((entry) => entry.id)
  ).toEqual(["openSourceLicenses", "appLicense"]);
  for (const id of [
    "launchAtLogin",
    "notchCompanion",
    "showInNotch",
    "density",
    "localModels",
    "key-notch-reply",
  ])
    expect(entries.some((entry) => entry.id === id)).toBe(false);
  expect(
    entries.some(
      (entry) => entry.id.startsWith("local-") || entry.id.endsWith("@terminal")
    )
  ).toBe(false);
  expect(
    settingsIndexFor(true, "linux").some((entry) => entry.id === "localModels")
  ).toBe(true);
});
it("legacy Abacus credit exhaustion shows no paywall or hidden local-model surface", async () => {
  const seed = defaultSeed();
  seed.prefs!.creditsExhaustedAt = Date.now();
  const impl = implement(contract);
  const app = await renderApp("/settings/models", {
    seed,
    procedures: {
      account: {
        abacus: impl.account.abacus.handler(
          () =>
            ({
              subscription_tier: "free",
              credits_used: 10,
              credits_granted: 10,
            }) as never
        ),
      },
    },
  });
  try {
    expect(await screen.findByRole("heading", { name: "Models" })).toBeTruthy();
    expect(screen.queryByText(enUS.phase5.creditsExhausted)).toBeNull();
    expect(screen.queryByText("Use a local model")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Upgrade|Manage plan|Top up/i })
    ).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("browser About exposes license attribution without native update controls", async () => {
  const app = await renderApp("/settings/about");
  try {
    expect(
      await screen.findByText(enUS.settings.licenses.title)
    ).not.toBeNull();
    expect(screen.getByText(enUS.settings.licenses.attribution)).not.toBeNull();
    expect(screen.queryByText(enUS.phase5.checkUpdates)).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
