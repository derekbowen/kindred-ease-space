import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { getAddons } from "@/lib/addons.functions";

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
    getMe().then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null)).catch(() => {});
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
      if (error) throw error;
      if (res?.url) window.location.href = res.url;
      else throw new Error("No checkout URL returned");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Add-ons</h1>
        <p className="text-sm text-muted-foreground">Bolt extra capabilities onto your marketplace. Managed add-ons are set up for you after purchase.</p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data?.catalog ?? []).map((a) => {
            const isAffiliate = a.key === "affiliate-standard";
            const active = a.requestStatus === "active";
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
                      <li key={b} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 text-emerald-500 shrink-0" />{b}</li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-2">
                    <div className="mb-3 text-2xl font-bold">
                      ${(a.priceCents / 100).toFixed(0)}<span className="text-sm font-normal text-muted-foreground">/{a.cadence}</span>
                    </div>
                    {active ? (
                      <Button disabled className="w-full" variant="outline">Active</Button>
                    ) : (
                      <Button className="w-full" disabled={busy === a.key} onClick={() => checkout(a.key)}>
                        {busy === a.key ? "Redirecting…" : `Get it — $${(a.priceCents / 100).toFixed(0)}/${a.cadence}`}
                      </Button>
                    )}
                    {isAffiliate && (
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
