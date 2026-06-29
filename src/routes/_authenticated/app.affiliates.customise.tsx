import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import {
  getAffiliateSettings,
  listApplications,
  decideApplication,
} from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/customise")({
  head: () => ({ meta: [{ title: "Customise — founders.click" }] }),
  component: CustomisePage,
});

function CustomisePage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const qc = useQueryClient();
  const decide = useServerFn(decideApplication);

  useEffect(() => {
    getMe()
      .then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null))
      .catch(() => {});
  }, []);

  const settings = useQuery({
    queryKey: ["affiliate-settings", workspaceId],
    queryFn: () => getAffiliateSettings({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });
  const apps = useQuery({
    queryKey: ["affiliate-apps", workspaceId],
    queryFn: () => listApplications({ data: { workspaceId: workspaceId!, status: "pending" } }),
    enabled: !!workspaceId,
  });

  const slug = settings.data?.settings?.form_slug as string | undefined;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Customise</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branding</CardTitle>
          <CardDescription>
            Affiliate sign-up pages and emails use your workspace brand (logo + colors).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link to="/app/settings">Edit workspace branding</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Public sign-up page</CardTitle>
          <CardDescription>Share this link so affiliates can apply.</CardDescription>
        </CardHeader>
        <CardContent>
          {slug ? (
            <button
              className="font-mono text-sm text-orange-500 hover:underline"
              onClick={() => {
                navigator.clipboard?.writeText(`${window.location.origin}/apply/${slug}`);
                toast.success("Sign-up link copied");
              }}
            >
              {typeof window !== "undefined" ? window.location.origin : ""}/apply/{slug} · copy
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set a sign-up form slug in{" "}
              <Link to="/app/affiliates/settings" className="text-orange-500 hover:underline">
                Affiliate Settings
              </Link>{" "}
              to enable your public page.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending applications</CardTitle>
          <CardDescription>Approve to turn an applicant into an active affiliate.</CardDescription>
        </CardHeader>
        <CardContent>
          {apps.isLoading ? (
            <Skeleton className="h-20" />
          ) : (apps.data?.applications ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending applications.</p>
          ) : (
            <div className="space-y-2">
              {apps.data!.applications.map((a: any) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {a.name}{" "}
                      <Badge variant="outline" className="ml-1">
                        {a.program_name}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">{a.email}</div>
                  </div>
                  <div className="space-x-1">
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await decide({
                            data: { workspaceId: workspaceId!, id: a.id, approve: true },
                          });
                          await qc.invalidateQueries({ queryKey: ["affiliate-apps", workspaceId] });
                          toast.success("Approved");
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed");
                        }
                      }}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await decide({
                            data: { workspaceId: workspaceId!, id: a.id, approve: false },
                          });
                          await qc.invalidateQueries({ queryKey: ["affiliate-apps", workspaceId] });
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed");
                        }
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
