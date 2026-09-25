import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Check, Info } from "lucide-react";
import { toast } from "sonner";
import { userMessage } from "@/lib/user-message";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { getAddons } from "@/lib/addons.functions";
import { SHARETRIBE_SETTINGS_PATH } from "@/lib/affiliate-requirements";
import { edgeFunctionError } from "@/lib/edge-function-error";

const addonsSearchSchema = z.object({
  success: z.coerce.string().optional(),
  canceled: z.coerce.string().optional(),
  session_id: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/app/addons")({
  head: () => ({ meta: [{ title: "Add-ons — founders.click" }] }),
  validateSearch: addonsSearchSchema,
  component: AddonsPage,
});

function AddonsPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/_authenticated/app/addons" });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null))
      .catch(() => {});
  }, []);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["addons", workspaceId],
    queryFn: () => getAddons({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  useEffect(() => {
    if (search.success) {
      toast.success("Add-on purchase received — it will activate shortly.");
      refetch();
      navigate({ to: "/app/addons", search: {}, replace: true });
    } else if (search.canceled) {
      toast.info("Checkout canceled.");
      navigate({ to: "/app/addons", search: {}, replace: true });
    }
  }, [search.success, search.canceled, navigate, refetch]);

  // Map the add-on to its Stripe price key, then redirect to Checkout.
  const checkout = async (catalogKey: string) => {
    if (!workspaceId) return toast.error("No workspace");
    const addonKey = catalogKey === "affiliate-standard" ? "affiliate-standard" : catalogKey;
    setBusy(catalogKey);
    try {
      const { data: res, error } = await supabase.functions.invoke("create-checkout", {
        body: { workspace_id: workspaceId, mode: "addon", addon_key: addonKey },
      });
      // A refusal's own sentence (e.g. the Affiliate add-on's connection
      // requirement) rides in the body of a non-2xx answer.
      if (error) throw await edgeFunctionError(error);
      if (res?.url) window.location.href = res.url;
      else throw new Error("No checkout URL returned");
    } catch (e) {
      toast.error(
        userMessage(
          e,
          "Couldn't start checkout for this add-on. Try again, or contact support if it keeps happening.",
        ),
      );
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Add-ons</h1>
        <p className="text-sm text-muted-foreground">
          Bolt extra capabilities onto your marketplace. Managed add-ons are set up for you after
          purchase.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data?.catalog ?? []).map((a) => {
            const isAffiliate = a.key === "affiliate-standard";
            const active = a.requestStatus === "active";
            // Server-computed: the add-on cannot work on this workspace's
            // connection, and the trial and checkout would refuse it.
            const blocked = !active && a.blockedReason ? a.blockedReason : null;
            return (
              <Card key={a.key} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-lg">{a.name}</CardTitle>
                    {a.fulfilment === "managed" && <Badge variant="outline">Done-for-you</Badge>}
                  </div>
                  <CardDescription>{a.tagline}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-4">
                  <p className="text-sm text-muted-foreground">{a.description}</p>
                  <ul className="space-y-1.5 text-sm">
                    {a.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 text-emerald-500 shrink-0" />
                        {b}
                      </li>
                    ))}
                  </ul>
                  {a.requires && (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {a.requires}
                    </p>
                  )}
                  {blocked && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                      <p className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        {blocked}
                      </p>
                      <Button asChild variant="link" size="sm" className="h-auto px-0 pt-1">
                        <Link to={SHARETRIBE_SETTINGS_PATH}>Open Sharetribe settings →</Link>
                      </Button>
                    </div>
                  )}
                  <div className="mt-auto pt-2">
                    <div className="mb-3 text-2xl font-bold">
                      ${(a.priceCents / 100).toFixed(0)}
                      <span className="text-sm font-normal text-muted-foreground">
                        /{a.cadence}
                      </span>
                    </div>
                    {active ? (
                      <Button disabled className="w-full" variant="outline">
                        Active
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        disabled={busy === a.key || !!blocked}
                        onClick={() => checkout(a.key)}
                      >
                        {busy === a.key
                          ? "Redirecting…"
                          : `Get it — $${(a.priceCents / 100).toFixed(0)}/${a.cadence}`}
                      </Button>
                    )}
                    {isAffiliate && !blocked && (
                      <Button asChild variant="ghost" size="sm" className="mt-2 w-full">
                        <Link to="/app/affiliates">Or start a free trial →</Link>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
