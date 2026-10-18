import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderWithDb } from "../../features/chat/testing";
import { CreditsCard, missingFreeSources } from "./index";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("offers the next two missing sources in the pool's spending order", () => {
  expect(missingFreeSources({})).toEqual(["gemini", "openrouter"]);
  expect(missingFreeSources({ gemini: true, openrouter: true })).toEqual([
    "mistral",
    "nvidia",
  ]);
  expect(
    missingFreeSources({
      gemini: true,
      openrouter: true,
      mistral: true,
      nvidia: true,
    })
  ).toEqual(["cerebras", "groq"]);
});

it("connects OpenRouter and replays a dead turn once after the refreshed catalog", async () => {
  const onResume = vi.fn(async () => {});
  const configured = { gemini: true };
  const connectFreeSource = vi.fn(async () => {
    Object.assign(configured, { openrouter: true });
    return true;
  });
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{
        openExternal: async () => {},
        openUpgrade: async () => {},
        configuredFreeSources: async () => configured,
        connectFreeSource,
      }}
      onResume={onResume}
    />
  );
  cleanup = rendered.cleanup;
  await waitFor(() =>
    expect(document.querySelector('[data-source="openrouter"]')).toBeTruthy()
  );
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(
      '[data-source="openrouter"] button'
    )!
  );
  await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
  expect(connectFreeSource).toHaveBeenCalledExactlyOnceWith(
    "openrouter",
    undefined
  );
});

it("does not show Abacus upgrades or top-ups for any plan tier", async () => {
  const openExternal = vi.fn(async () => {});
  const openUpgrade = vi.fn(async () => {});
  const rendered = await renderWithDb(
    <CreditsCard
      tier="basic"
      host={{
        openExternal,
        openUpgrade,
        canTopUpCredits: async () => true,
        configuredFreeSources: async () => ({}),
      }}
    />
  );
  cleanup = rendered.cleanup;
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
  expect(openUpgrade).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
  expect(document.querySelector('[data-source="gemini"]')).toBeTruthy();
});

it.each([false, undefined])(
  "does not infer a paid top-up offer without billing eligibility (%s)",
  async (eligible) => {
    const rendered = await renderWithDb(
      <CreditsCard
        tier="paid"
        host={{
          openExternal: async () => {},
          openUpgrade: async () => {},
          ...(eligible === undefined
            ? {}
            : { canTopUpCredits: async () => eligible }),
        }}
      />
    );
    cleanup = rendered.cleanup;
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Top up" })).toBeNull()
    );
  }
);

it("offers provider choices instead of an upgrade when the free pool is exhausted", async () => {
  const openUpgrade = vi.fn(async () => {});
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{
        openExternal: async () => {},
        openUpgrade,
        configuredFreeSources: async () => ({}),
      }}
    />
  );
  cleanup = rendered.cleanup;
  await waitFor(() =>
    expect(document.querySelector('[data-source="gemini"]')).toBeTruthy()
  );
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  expect(openUpgrade).not.toHaveBeenCalled();
});

it("does not infer an upgrade offer for an unknown account", async () => {
  const rendered = await renderWithDb(
    <CreditsCard
      tier="unknown"
      host={{ openExternal: async () => {}, openUpgrade: async () => {} }}
    />
  );
  cleanup = rendered.cleanup;
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
});
