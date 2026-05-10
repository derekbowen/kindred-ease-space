import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createWorkspace } from "@/lib/workspace.functions";
import { getMe } from "@/lib/auth.functions";

export const Route = createFileRoute("/_authenticated/app/onboarding")({
  head: () => ({ meta: [{ title: "Set up your workspace — founders.click" }] }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const create = useServerFn(createWorkspace);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // If user already has a workspace, skip onboarding
    getMe().then((me) => {
      if (me.memberships.length > 0) navigate({ to: "/app" });
    });
  }, [navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await create({ data: { name, marketplaceDomain: domain } });
      toast.success("Workspace created. Welcome aboard!");
      navigate({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create workspace");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Set up your workspace</CardTitle>
          <CardDescription>
            Tell us about your Sharetribe marketplace. You'll get 250 free trial credits and 14 days to explore everything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Workspace name</Label>
              <Input
                id="name"
                placeholder="Pool Rental Near Me"
                required
                minLength={2}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="domain">Marketplace domain</Label>
              <Input
                id="domain"
                placeholder="poolrentalnearme.com"
                required
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The public domain of the Sharetribe marketplace you operate. You'll verify it after onboarding.
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating workspace…" : "Create workspace & start trial"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
