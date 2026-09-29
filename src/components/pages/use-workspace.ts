import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/auth.functions";

export type CurrentWorkspace = {
  id: string;
  name: string | null;
  brand_name: string | null;
  role: string | null;
};

/**
 * The signed-in user's workspace (the app's convention: the first
 * membership), shared through react-query so every screen reads it once.
 */
export function useCurrentWorkspace() {
  const q = useQuery({
    queryKey: ["me"],
    queryFn: () => getMe(),
    staleTime: 60_000,
  });
  const m = q.data?.memberships?.[0] as
    | {
        workspace_id: string;
        role: string | null;
        workspaces: { name: string | null; brand_name: string | null } | null;
      }
    | undefined;
  const workspace: CurrentWorkspace | null = m
    ? {
        id: m.workspace_id,
        name: m.workspaces?.name ?? null,
        brand_name: m.workspaces?.brand_name ?? null,
        role: m.role,
      }
    : null;
  return { workspace, workspaceId: workspace?.id ?? null, isLoading: q.isLoading, error: q.error };
}

/** A fresh idempotency key (RFC 4122 v4) for one generation request. */
export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "3 minutes ago" / "just now" — for sync and save times. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
