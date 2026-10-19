import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { onboardingStore } from "#renderer/features/onboarding/store";
import {
  startTour,
  tourSignedOut,
  tourStore,
} from "#renderer/features/tour/store";
import type { RouterContext } from "#renderer/router";
import { renderApp } from "#renderer/test-support/app-harness";

import { signOutAbacus } from "./sign-out.electron";

const findProfileTrigger = () =>
  screen.findByRole("button", {
    name: (_name: string, element: Element | null) =>
      element?.getAttribute("data-slot") === "profile-button",
  });

afterEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  tourSignedOut();
});

it("keeps desktop key removal, local sign-out and credential invalidation in order", async () => {
  const events: unknown[] = [];
  const context = {
    transport: {
      client: {
        auth: {
          abacus: { signOut: async (input: unknown) => events.push(input) },
        },
        account: { signOut: async () => events.push("account") },
      },
    },
    credentialsChanged: async () => events.push("credentials"),
  } as unknown as RouterContext;
  await signOutAbacus(context, false);
  expect(events).toEqual([
    { keepOtherApiKeys: false },
    "account",
    "credentials",
  ]);
});

it("does not clear the desktop account when removing its key fails", async () => {
  const signOut = vi.fn();
  const context = {
    transport: {
      client: {
        auth: {
          abacus: {
            signOut: async () => {
              throw new Error("key removal failed");
            },
          },
        },
        account: { signOut },
      },
    },
    credentialsChanged: vi.fn(),
  } as unknown as RouterContext;
  await expect(signOutAbacus(context, true)).rejects.toThrow(
    "key removal failed"
  );
  expect(signOut).not.toHaveBeenCalled();
  expect(context.credentialsChanged).not.toHaveBeenCalled();
});

it.each(["settings", "profile"])(
  "signs out from %s without blocking direct-provider use and keeps completed setup",
  async (entry) => {
    const os = implement(contract);
    let signedIn = true;
    const app = await renderApp(
      entry === "settings" ? "/settings/account" : "/sessions/new",
      {
        onboarded: true,
        procedures: {
          settings: {
            get: os.settings.get.handler(
              () =>
                ({
                  apiKeys: signedIn ? { ABACUS_API_KEY: "dummy" } : {},
                }) as never
            ),
          },
          auth: {
            abacus: {
              start: os.auth.abacus.start.handler(() => {
                signedIn = true;
                return { ok: true };
              }),
              signOut: os.auth.abacus.signOut.handler(() => {
                signedIn = false;
                return { stashedSessions: 0, removedProviders: [] };
              }),
            },
          },
          account: {
            abacus: os.account.abacus.handler(
              () =>
                (signedIn
                  ? { name: "Demo", email: "demo@example.test" }
                  : null) as never
            ),
            signOut: os.account.signOut.handler(() => ({
              account: null,
              apps: [],
              onboarded: true,
            })),
          },
        },
      }
    );
    try {
      startTour({ onboarded: true });
      if (entry === "profile") {
        fireEvent.click(await findProfileTrigger());
        fireEvent.click(
          await screen.findByRole("menuitem", { name: enUS.profile.logOut })
        );
      } else {
        fireEvent.click(
          await screen.findByRole("button", { name: enUS.phase5.signOut })
        );
      }
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: entry === "profile" ? enUS.profile.logOut : enUS.phase5.signOut,
        })
      );
      await waitFor(() =>
        expect(app.router.state.location.pathname).toBe(
          entry === "settings" ? "/onboarding/welcome" : "/sessions/new"
        )
      );
      if (entry === "settings") {
        expect(
          await screen.findByRole("button", { name: "Continue" })
        ).toBeTruthy();
        expect(
          screen.queryByRole("button", { name: "Sign up for free" })
        ).toBeNull();
      }
      expect(app.history.canGoBack()).toBe(false);
      expect(signedIn).toBe(false);
      expect(tourStore.state.active).toBeNull();
      expect(await app.transport.client.account.state({})).toMatchObject({
        onboarded: true,
      });
      await app.router.navigate({ to: "/bots/new" });
      expect(app.router.state.location.pathname).toBe("/bots/new");
      expect(
        screen.queryByRole("button", { name: "Sign up for free" })
      ).toBeNull();
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
