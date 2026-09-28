import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/auth.functions";
import { getBetaStatus } from "@/lib/entitlements.functions";

export type InternalAccess = {
  internalUnlimited: boolean;
  revealLaunchHiddenFeatures: boolean;
};

/**
 * The founder / internal unlimited flags for the signed-in user's workspace,
 * exactly as the server computed them (getBetaStatus, member-only, read fresh
 * from the workspace's grants). Shares the shell's query key, so a screen the
 * shell already asked about is not asked again. Both flags read false until
 * the server answers and on any error. They only change what the UI shows:
 * every limit the entitlement lifts is lifted on the server, never here.
 */
export function useInternalAccess(): InternalAccess {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const { data } = useQuery({
    queryKey: ["beta-status", workspaceId],
    queryFn: () => getBetaStatus({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  return {
    internalUnlimited: data?.internalUnlimited === true,
    revealLaunchHiddenFeatures: data?.revealLaunchHiddenFeatures === true,
  };
}
