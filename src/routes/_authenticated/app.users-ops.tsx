import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/app/users-ops")({
  head: () => ({ meta: [{ title: "Users & Ops — founders.click" }] }),
  component: () => (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Users & Ops</h1>
      <Card>
        <CardHeader>
          <CardTitle>Lead Inbox · Email Verify · IG Lead Hunter · Directory Moderation · Email Branding · Site Footer · Admin Team · Listing Claims</CardTitle>
          <CardDescription>All operational tools land here.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Tab UIs port in Phase 6.</CardContent>
      </Card>
    </div>
  ),
});
