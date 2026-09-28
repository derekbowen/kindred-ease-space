import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getAiAllowance, type AiAllowance } from "@/lib/ai-allowance.functions";
import { userMessage } from "@/lib/user-message";

/**
 * The ONE AI figure every screen shows: page generations today against the
 * fair-use daily cap, plus one plain sentence for the workspace's AI state
 * (getAiAllowance). Dashboard, Billing and the AI page used to show three
 * different numbers ("0 credits", "0 generation credits", "19 free
 * generations") for the same workspace; credit arithmetic never leaves the
 * server now.
 */
export const AI_ALLOWANCE_LOAD_FAILED =
  "Couldn't load this workspace's AI allowance. Refresh the page to try again.";

export function useAiAllowance(workspaceId: string | null | undefined): {
  allowance: AiAllowance | null;
  error: string | null;
} {
  const fetchAllowance = useServerFn(getAiAllowance);
  const [allowance, setAllowance] = useState<AiAllowance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setError(null);
    fetchAllowance({ data: { workspaceId } })
      .then((a) => {
        if (!cancelled) setAllowance(a);
      })
      .catch((e) => {
        console.error("[ai-allowance] load failed", e);
        if (!cancelled) setError(userMessage(e, AI_ALLOWANCE_LOAD_FAILED));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, fetchAllowance]);

  return { allowance, error };
}

/**
 * "3 / 50" for the page count, or an em dash while it loads. The founder /
 * internal unlimited account has no daily cap (its dailyCap is a sentinel,
 * never a number to print): "3 / Unlimited".
 */
export function formatAllowanceCount(allowance: AiAllowance | null): string {
  if (!allowance) return "—";
  const used = allowance.generationsUsedToday.toLocaleString();
  if (allowance.internalUnlimited) return `${used} / Unlimited`;
  return `${used} / ${allowance.dailyCap.toLocaleString()}`;
}

/**
 * The one sentence under the AI figure: the state sentence, except that the
 * internal account's "ok" says what it has (no daily limit, how many today).
 * Any problem state (the platform pause, the ceiling) is always said as is.
 */
export function allowanceSentence(allowance: AiAllowance): string {
  if (allowance.internalUnlimited && allowance.state === "ok") return allowance.generationSummary;
  return allowance.summary;
}
