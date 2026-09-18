/**
 * ENTITLEMENTS & BETA ACCESS — platform admin only.
 *
 * Replaces the "Plan Requests" stub, which described exactly this ("Manual plan
 * upgrades & comps. Internal only.") and did nothing.
 *
 * The numbers shown here come from readEntitlement() — the same function the
 * customer's own billing page runs on — so the operator view cannot disagree
 * with what the customer is actually allowed. Nothing on this page computes an
 * entitlement of its own.
 *
 * Authorization is server-side and absolute: every function this page calls
 * begins with a platform-admin check, and `authenticated` holds no write
 * privilege on the grants table at all. Hiding the UI is presentation, not
 * security; a workspace owner who found this route still cannot grant anything.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Gift, Loader2, RefreshCw, ShieldAlert, Ban, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listGrantableWorkspaces,
  listWorkspaceGrants,
  grantEntitlement,
  revokeGrant,
  DEFAULT_BETA_GRANT,
} from "@/lib/admin-entitlement-grants.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/ops/plan-requests")({
  head: () => ({ meta: [{ title: "Entitlements & Beta Access — founders.click" }] }),
  component: EntitlementGrantsPage,
});

const GRANT_TYPES = ["beta", "trial", "promotional", "manual"] as const;

type Workspace = Awaited<ReturnType<typeof listGrantableWorkspaces>>[number];
type Summary = Awaited<ReturnType<typeof listWorkspaceGrants>>;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** yyyy-mm-dd for <input type="date">, from an ISO timestamp. */
function dateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "—";
}

function EntitlementGrantsPage() {
  const listWorkspaces = useServerFn(listGrantableWorkspaces);
  const listGrants = useServerFn(listWorkspaceGrants);
  const doGrant = useServerFn(grantEntitlement);
  const doRevoke = useServerFn(revokeGrant);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  // The approved product default: beta, 50 pages, 30 days, no card.
  const [grantType, setGrantType] = useState<(typeof GRANT_TYPES)[number]>(
    DEFAULT_BETA_GRANT.grantType,
  );
  const [pageLimit, setPageLimit] = useState<string>(String(DEFAULT_BETA_GRANT.pageLimit));
  const [expiresOn, setExpiresOn] = useState<string>(
    dateInputValue(isoDaysFromNow(DEFAULT_BETA_GRANT.durationDays)),
  );
  const [noExpiry, setNoExpiry] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    listWorkspaces()
      .then((w) => setWorkspaces(w))
      .catch((e) => {
        // A non-admin reaching this route sees a refusal, not an empty page
        // that looks like there is simply nothing here.
        if (String(e?.message ?? e).includes("forbidden")) setDenied(true);
        else toast.error("Could not load workspaces");
      })
      .finally(() => setLoading(false));
  }, [listWorkspaces]);

  const refresh = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId) return;
      try {
        setSummary(await listGrants({ data: { workspaceId } }));
      } catch (e) {
        toast.error(`Could not load entitlements: ${String((e as Error)?.message ?? e)}`);
      }
    },
    [listGrants],
  );

  useEffect(() => {
    if (selected) void refresh(selected);
  }, [selected, refresh]);

  const ws = useMemo(() => workspaces.find((w) => w.id === selected), [workspaces, selected]);
  const ent = summary?.entitlement;

  async function onGrant() {
    const pages = Number(pageLimit);
    if (!Number.isInteger(pages) || pages < 0)
      return toast.error("Page allowance must be a whole number");
    if (reason.trim().length < 3)
      return toast.error("A reason is required — it is the audit record");
    if (!noExpiry && !expiresOn) return toast.error("Set an expiry date, or tick “No expiration”");
    setBusy(true);
    try {
      await doGrant({
        data: {
          workspaceId: selected,
          grantType,
          pageLimit: pages,
          // End of the chosen day, so "expires 17 Oct" means the tester keeps
          // access through the 17th rather than losing it at midnight.
          expiresAt: noExpiry ? null : new Date(`${expiresOn}T23:59:59Z`).toISOString(),
          noExpiry,
          reason: reason.trim(),
        },
      });
      toast.success(`Granted ${pages} pages`);
      setReason("");
      await refresh(selected);
    } catch (e) {
      toast.error(`Grant failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(grantId: string) {
    const why = window.prompt("Reason for revoking (recorded in the audit log):");
    if (!why || why.trim().length < 3) return;
    setBusy(true);
    try {
      await doRevoke({ data: { grantId, reason: why.trim() } });
      toast.success("Grant revoked — capacity ends on the next read");
      await refresh(selected);
    } catch (e) {
      toast.error(`Revoke failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (denied) {
    return (
      <Card className="m-6 max-w-lg p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-destructive" />
          <div>
            <h2 className="font-semibold">Platform admins only</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Granting entitlement is a billing override. Workspace ownership does not confer it.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Gift className="h-6 w-6" /> Entitlements &amp; Beta Access
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Grant free page capacity without creating a Stripe subscription. Grants are additive on
          top of any paid plan, expire by timestamp, and are recorded permanently.
        </p>
      </header>

      <Card className="p-4">
        <Label htmlFor="ws-select">Workspace</Label>
        <div className="mt-2 flex gap-2">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="ws-select" className="max-w-xl">
              <SelectValue placeholder="Select a workspace…" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                  {w.is_internal ? " (internal)" : ""} — {w.subscription_status ?? "no status"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            disabled={!selected}
            onClick={() => void refresh(selected)}
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      {ent && ws && (
        <>
          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Current entitlement</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <dt className="text-muted-foreground">Commercial plan</dt>
                <dd className="font-medium">{ent.planName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Billing state</dt>
                <dd>
                  <Badge variant={ent.canPublish ? "default" : "destructive"}>
                    {ent.billingState}
                  </Badge>
                </dd>
              </div>
              <div>
                {/* The RAW STORED COLUMNS, not an entitlement. They survive a
                    lapse, so this can read 25 while the effective limit is 0.
                    Struck through when they are contributing nothing, so an
                    operator cannot mistake a stored number for capacity. */}
                <dt className="text-muted-foreground">Stored (Stripe)</dt>
                <dd
                  className={`font-mono font-medium ${
                    ent.canPublish && ent.billingState !== "granted"
                      ? ""
                      : "text-muted-foreground line-through"
                  }`}
                >
                  {ent.pageLimitBase + ent.pageLimitAddon + ent.pageLimitBonus}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Granted pages</dt>
                <dd className="font-mono font-medium">{ent.pageLimitGranted}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Effective limit</dt>
                <dd className="font-mono text-base font-semibold">{ent.pageLimit}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Pages used</dt>
                <dd className="font-mono font-medium">
                  {ent.publishedPages} <span className="text-muted-foreground">published</span>
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{ent.billingReason}</p>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <Plus className="h-4 w-4" /> Grant access
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <Label htmlFor="grant-type">Grant type</Label>
                <Select
                  value={grantType}
                  onValueChange={(v) => setGrantType(v as typeof grantType)}
                >
                  <SelectTrigger id="grant-type" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRANT_TYPES.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="grant-pages">Page allowance</Label>
                <Input
                  id="grant-pages"
                  className="mt-1"
                  inputMode="numeric"
                  value={pageLimit}
                  onChange={(e) => setPageLimit(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="grant-expires">Expires</Label>
                <Input
                  id="grant-expires"
                  className="mt-1"
                  type="date"
                  value={expiresOn}
                  disabled={noExpiry}
                  onChange={(e) => setExpiresOn(e.target.value)}
                />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="grant-no-expiry"
                    checked={noExpiry}
                    onCheckedChange={(v) => setNoExpiry(v === true)}
                  />
                  No expiration
                </label>
              </div>
            </div>
            <div className="mt-4">
              <Label htmlFor="grant-reason">Reason (required — this is the audit record)</Label>
              <Textarea
                id="grant-reason"
                className="mt-1"
                rows={2}
                placeholder="e.g. Private beta cohort 1 — agreed with Derek 18 Sep"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button className="mt-4" disabled={busy || !selected} onClick={() => void onGrant()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Grant access
            </Button>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Grant history</h2>
            {summary.grants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No grants have ever been issued here.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">State</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Pages</th>
                      <th className="py-2 pr-3">Starts</th>
                      <th className="py-2 pr-3">Expires</th>
                      <th className="py-2 pr-3">Reason</th>
                      <th className="py-2 pr-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {summary.grants.map((g) => {
                      const active = summary.activeGrantIds.includes(g.id);
                      return (
                        <tr key={g.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <Badge variant={active ? "default" : "secondary"}>
                              {g.revoked_at ? "revoked" : active ? "active" : "inactive"}
                            </Badge>
                          </td>
                          <td className="py-2 pr-3">{g.grant_type}</td>
                          <td className="py-2 pr-3 font-mono">{g.page_limit}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{fmt(g.starts_at)}</td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {g.expires_at ? fmt(g.expires_at) : "never"}
                          </td>
                          <td className="max-w-xs py-2 pr-3 text-muted-foreground">{g.reason}</td>
                          <td className="py-2 pr-3">
                            {!g.revoked_at && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => void onRevoke(g.id)}
                              >
                                <Ban className="mr-1 h-3.5 w-3.5" /> Revoke
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
