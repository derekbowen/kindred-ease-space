import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getMe } from "@/lib/auth.functions";
import { listPrograms } from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/programs")({
  head: () => ({ meta: [{ title: "Affiliate Programs — founders.click" }] }),
  component: ProgramsPage,
});

function ProgramsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null)).catch(() => {});
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["affiliate-programs", workspaceId],
    queryFn: () => listPrograms({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Programs</h1>
        <Button asChild><Link to="/app/affiliates/programs/$id/edit" params={{ id: "new" }}>Create program</Link></Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : (data?.programs ?? []).length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No programs yet. Create one to start enrolling affiliates.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {data!.programs.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-2 flex-row items-center justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {p.name}
                  {p.active ? <Badge className="bg-emerald-600">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                  {p.auto_enroll ? <Badge variant="outline">Auto-enroll</Badge> : null}
                </CardTitle>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/affiliates/programs/$id/edit" params={{ id: p.id }}>Edit</Link>
                </Button>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground flex flex-wrap gap-x-6 gap-y-1">
                <span>Trigger: <span className="text-foreground capitalize">{p.trigger}</span></span>
                <span>Payout: <span className="text-foreground">{p.payout_type === "percentage" ? `${p.payout_value}% of GMV` : `${p.payout_value} flat`}</span></span>
                <span>Affiliates: <span className="text-foreground">{p.affiliate_count}</span></span>
                <span>Apply link: <span className="text-foreground">/apply/{"{slug}"}?</span> <span className="font-mono">{p.slug}</span></span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
