import { contract } from "@abacus-ai/contract/contract";
import type { UpdateStatus } from "@abacus-ai/contract/update";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { updateStatusQuery } from "#renderer/features/settings/updates";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const os = implement(contract);
/** `update.events` as main serves it: the current status first, then held open. */
const servedStatus = (...statuses: UpdateStatus[]) =>
  os.update.events.handler(async function* ({ signal }) {
    for (const status of statuses) yield status;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true })
    );
  });
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const idle: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
};
it.each(["free", "basic", "go", "pro", "max", "enterprise", "unknown"])(
  "desktop account settings never expose Abacus plan or credit actions for %s accounts",
  async (tier) => {
    const upgradeUrl = vi.fn();
    const openExternal = vi.fn();
    app = await renderApp("/settings/account", {
      procedures: {
        account: {
          abacus: os.account.abacus.handler(
            () =>
              ({
                name: "Billing account",
                email: "billing@example.com",
                subscription_tier: tier,
                plan: tier,
                org_user_count: tier === "enterprise" ? 4 : 1,
              }) as never
          ),
          upgradeUrl: os.account.upgradeUrl.handler(upgradeUrl),
        },
        system: { openExternal: os.system.openExternal.handler(openExternal) },
      },
    });
    await screen.findByText("billing@example.com");
    expect(document.querySelector('[data-setting-id="plan"]')).toBeNull();
    expect(document.querySelector('[data-setting-id="credits"]')).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Upgrade|Manage plan|Top up/i })
    ).toBeNull();
    expect(upgradeUrl).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  }
);
it("R5-T27 rejected install exposes Try again while downloaded and releases the pressed state", async () => {
  const install = vi.fn(async () => {
    throw new Error("quitAndInstall rejected");
  });
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus({ ...idle, downloaded: true }),
        install: os.update.install.handler(install),
      },
    },
  });
  await screen.findByRole("heading", { name: "About" });
  const row = within(
    document.querySelector<HTMLElement>('[data-setting-id="updates"]')!
  );
  fireEvent.click(
    await row.findByRole("button", { name: enUS.phase5.relaunch })
  );
  const retry = await row.findByRole("button", { name: "Try again" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("Couldn't install the update")).not.toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
});
it("R5-T27 a critical stalled update has a reachable banner and no blocking dialog", async () => {
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus({
          ...idle,
          downloaded: true,
          criticalUpdate: true,
          installing: true,
          installStalled: true,
        }),
      },
    },
  });
  expect(
    await screen.findAllByText(enUS.phase5.updates.stalled)
  ).not.toHaveLength(0);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
it("legacy exhausted-credit markers do not display a credit wall in Models", async () => {
  const seed = defaultSeed();
  const mark = Date.now();
  seed.prefs!.creditsExhaustedAt = mark;
  app = await renderApp("/settings/models", {
    seed,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
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
  await screen.findByRole("heading", { name: "Models" });
  expect(screen.queryByText(enUS.phase5.creditsExhausted)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Upgrade|Manage plan|Top up/i })
  ).toBeNull();
  expect(app.collections.prefs.get("app")?.creditsExhaustedAt).toBe(mark);
});
it("R5-T27 critical countdown installs exactly at five minutes", async () => {
  const { act } = await import("@testing-library/react");
  const install = vi.fn(async () => undefined);
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: servedStatus(idle),
        install: os.update.install.handler(install),
      },
    },
  });
  const { queryClient, transport } = app!.router.options.context!;
  const key = updateStatusQuery(transport).queryKey;
  // Let the first status arrive before replacing it with a critical update.
  await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(idle));
  vi.useFakeTimers();
  try {
    await act(async () => {
      queryClient.setQueryData(key, {
        ...idle,
        downloaded: true,
        criticalUpdate: true,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alertdialog")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299000);
    });
    expect(install).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(install).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {},
  { OPENAI_API_KEY: "stored-other-key" },
  { ABACUS_API_KEY: "stored-abacus-key" },
])("Abacus sign-out control requires an Abacus key: %j", async (apiKeys) => {
  const fetchAccount = vi.fn(() => ({
    name: "Ada",
    email: "ada@example.com",
  }));
  app = await renderApp("/settings/account", {
    procedures: {
      settings: { get: os.settings.get.handler(() => ({ apiKeys }) as never) },
      account: {
        abacus: os.account.abacus.handler(fetchAccount as never),
      },
    },
  });
  const hasAbacusKey =
    "ABACUS_API_KEY" in apiKeys && apiKeys.ABACUS_API_KEY.trim().length > 0;
  if (IS_ELECTRON && !hasAbacusKey) {
    await screen.findByRole("heading", { name: enUS.phase5.ownKeys });
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(fetchAccount).not.toHaveBeenCalled();
  } else {
    await screen.findByText("ada@example.com");
  }
  const canSignOut = !IS_ELECTRON || hasAbacusKey;
  if (canSignOut) {
    expect(
      await screen.findByRole("button", { name: enUS.phase5.signOut })
    ).not.toBeNull();
    expect(screen.queryByRole("checkbox")).not.toBeNull();
  } else {
    expect(
      screen.queryByRole("button", { name: enUS.phase5.signOut })
    ).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  }
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
});
it("legacy credit-exhaustion preferences no longer trigger provider/account refreshes", async () => {
  const { act } = await import("@testing-library/react");
  const seed = defaultSeed();
  const mark = Date.now();
  seed.prefs!.creditsExhaustedAt = mark;
  const fetchAccount = vi.fn(async () => ({
    subscription_tier: "free",
    credits_used: 1,
    credits_granted: 10,
  }));
  app = await renderApp("/settings/models", {
    seed,
    procedures: {
      // This regression covers a BYOK-only desktop. The harness otherwise
      // defaults to an Abacus key, which correctly enables the profile account query.
      settings: {
        get: os.settings.get.handler(
          () => ({ apiKeys: { OPENAI_API_KEY: "stored-other-key" } }) as never
        ),
      },
      account: { abacus: os.account.abacus.handler(fetchAccount as never) },
    },
  });
  await screen.findByRole("heading", { name: "Models" });
  await act(async () => {
    await app!.appDb.updatePrefs({ creditsExhaustedAt: mark });
  });
  await act(async () => {});
  expect(fetchAccount).not.toHaveBeenCalled();
  expect(app.collections.prefs.get("app")?.creditsExhaustedAt).toBe(mark);
  expect(screen.queryByText(enUS.phase5.creditsExhausted)).toBeNull();
});
it("desktop Account stays usable without referral-credit UI or queries", async () => {
  const referralSummary = vi.fn(() => {
    throw new Error("Unavailable");
  });
  app = await renderApp("/settings/account", {
    procedures: {
      referrals: { summary: os.referrals.summary.handler(referralSummary) },
      account: {
        abacus: os.account.abacus.handler(
          () => ({ name: "Ada", email: "ada@example.com" }) as never
        ),
      },
    },
  });
  await screen.findByText("ada@example.com");
  expect(referralSummary).not.toHaveBeenCalled();
  expect(document.querySelector('[data-setting-id="inviteLink"]')).toBeNull();
  expect(screen.queryByText(enUS.errors.genericTitle)).toBeNull();
});
it("an install retry clears historical failure and shows a new error after handoff", async () => {
  let release!: () => void;
  const retried = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failHandoff!: () => void;
  const handoffFailed = new Promise<void>((resolve) => {
    failHandoff = resolve;
  });
  const failed = {
    ...idle,
    downloaded: true,
    criticalUpdate: true,
    error: "old install failure",
    failedPhase: "install" as const,
  };
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        install: os.update.install.handler(() => {
          release();
        }),
        events: os.update.events.handler(async function* ({ signal }) {
          yield failed;
          await retried;
          // Native checking-for-update clears the previous failure before
          // the installer handoff. A later error belongs to this attempt.
          const cleared = { ...failed, error: null, failedPhase: null };
          yield { ...cleared, checking: true };
          yield { ...cleared, installing: true };
          await handoffFailed;
          yield { ...failed, installing: true };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  const { act, within } = await import("@testing-library/react");
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "Restarting…" })
        .hasAttribute("disabled")
    ).toBe(true)
  );
  expect(within(dialog).queryByText("old install failure")).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Try again" })
  ).toBeNull();
  await act(async () => failHandoff());
  expect(await within(dialog).findByText("old install failure")).not.toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "Restarting…" })
      .hasAttribute("disabled")
  ).toBe(true);
});

it("the quit watchdog event replaces the critical dialog with a stalled banner", async () => {
  let release!: () => void;
  const watchdog = new Promise<void>((resolve) => {
    release = resolve;
  });
  const installing = {
    ...idle,
    downloaded: true,
    criticalUpdate: true,
    installing: true,
  };
  app = await renderApp("/settings/about", {
    procedures: {
      update: {
        events: os.update.events.handler(async function* ({ signal }) {
          yield installing;
          await watchdog;
          yield { ...installing, installStalled: true };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  await screen.findByRole("alertdialog");
  release();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    await screen.findAllByText(enUS.phase5.updates.stalled)
  ).not.toHaveLength(0);
});

it("desktop Account stays usable without referral-credit UI or queries", async () => {
  const referralSummary = vi.fn(() => {
    throw new Error("Unavailable");
  });
  app = await renderApp("/settings/account", {
    procedures: {
      referrals: { summary: os.referrals.summary.handler(referralSummary) },
      account: {
        abacus: os.account.abacus.handler(
          () => ({ name: "Ada", email: "ada@example.com" }) as never
        ),
      },
    },
  });
  await screen.findByText("ada@example.com");
  expect(referralSummary).not.toHaveBeenCalled();
  expect(document.querySelector('[data-setting-id="inviteLink"]')).toBeNull();
  expect(screen.queryByText(enUS.errors.genericTitle)).toBeNull();
});

it("opens model setup when the optional local runtime is unavailable", async () => {
  app = await renderApp("/onboarding/models", {
    signedIn: true,
    procedures: {
      localModels: {
        state: os.localModels.state.handler(() => {
          throw new Error("The local model runtime is not up");
        }),
      },
    },
  });
  expect(
    await screen.findByRole("heading", {
      name: `${enUS.onboarding.setupTitleLead} ${enUS.onboarding.setupTitleAccent}`,
    })
  ).not.toBeNull();
  expect(
    screen.getByRole("button", { name: enUS.onboarding.setupDoneCta })
  ).not.toBeNull();
  expect(screen.queryByText(enUS.errors.genericTitle)).toBeNull();
});
