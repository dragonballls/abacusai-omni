import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { useQuery } from "@tanstack/react-query";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Name, photo, plan and credits use the same account RPC on both platforms. */
export const useAccount = (options?: { enabled?: boolean }) => {
  const { transport } = useAppContext();
  const accountQuery = transport.orpc.account.abacus.queryOptions({
    input: { refresh: true },
  });
  return useQuery({
    ...accountQuery,
    // Every account consumer must independently verify the desktop key before
    // the network request. A caller-local enabled flag cannot protect another
    // observer of the same shared account query.
    queryFn: async (context) => {
      if (IS_ELECTRON) {
        const getSettings = transport.client.settings?.get;
        if (typeof getSettings !== "function") return null;
        try {
          const settings = await getSettings({});
          if (!canSignOutOfAbacus(settings)) return null;
        } catch {
          return null;
        }
      }
      return accountQuery.queryFn?.(context) ?? null;
    },
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 300_000,
  });
};
