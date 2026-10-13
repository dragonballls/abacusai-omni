/**
 * Coordinate the cross-feature state transition after an account is forgotten.
 *
 * Platform is the renderer's composition boundary: settings owns the action,
 * while onboarding and the tour own their ephemeral stores.
 */
import { accountStateQuery } from "#renderer/features/onboarding/actions";
import { onboardingStore } from "#renderer/features/onboarding/store";
import { tourSignedOut } from "#renderer/features/tour/store";
import type { RouterContext } from "#renderer/router";

type AccountResetContext = Pick<
  RouterContext,
  "transport" | "queryClient" | "db"
>;

export async function forgetAccountAndResetOnboarding(
  context: AccountResetContext
): Promise<void> {
  const state = await context.transport.client.account.forget({});
  context.queryClient.setQueryData(
    accountStateQuery(context.transport).queryKey,
    state
  );
  await context.db.updatePrefs({
    onboardingStep: null,
    onboardingFlow: null,
    onboardingExit: null,
    onboardingPairing: [],
    tour: { status: "unseen", at: null },
  });
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  tourSignedOut();
}
