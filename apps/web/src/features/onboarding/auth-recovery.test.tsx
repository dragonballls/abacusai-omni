import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

it("resumes setup instead of showing account signup when already signed in", async () => {
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: true,
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
});

it("starts provider setup without an Abacus login when signed out", async () => {
  const authStart = vi.fn(async () => ({ ok: true as const }));
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart,
  });
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/models")
  );
  expect(authStart).not.toHaveBeenCalled();
  expect(app.calls.filter(([name]) => name === "auth.abacus.start")).toHaveLength(0);
});
