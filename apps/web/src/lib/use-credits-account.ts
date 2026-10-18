import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { creditMarkState } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Share counters and deduplicate refreshes without caching an exhaustion marker. */
export const useCreditsAccount = () => {
  const { transport } = useAppContext();
  const settings = useQuery(
    transport.orpc.settings.get.queryOptions({ input: {} })
  );
  const hasAbacusApiKey = Boolean(settings.data?.apiKeys?.ABACUS_API_KEY);
  // Browser sessions authenticate through their signed-in session rather than
  // a persisted desktop API key; only gate the optional account on Electron.
  const canQueryAccount = !IS_ELECTRON || hasAbacusApiKey;
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const account = useAccount({ enabled: canQueryAccount });
  const clearFreshMark = useEffectEvent(
    (mark: number, data: typeof account.data) => {
      if (
        prefs.creditsExhaustedAt === mark &&
        creditMarkState(data, mark, Date.now(), true) === "clear"
      )
        void update({ creditsExhaustedAt: null }).catch(() => undefined);
    }
  );
  const { refetch } = account;
  useEffect(() => {
    const mark = prefs.creditsExhaustedAt;
    if (mark === null || !canQueryAccount) return;
    let active = true;
    void refetch({ cancelRefetch: false }).then((result) => {
      if (active && !result.isError) clearFreshMark(mark, result.data);
    });
    return () => {
      active = false;
    };
  }, [prefs.creditsExhaustedAt, refetch, canQueryAccount]);
  return account;
};
