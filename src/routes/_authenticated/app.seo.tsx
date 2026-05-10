import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/app/seo")({
  head: () => ({ meta: [{ title: "SEO — founders.click" }] }),
  component: () => (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">SEO</h1>
      <Card>
        <CardHeader>
          <CardTitle>Intelligence suite</CardTitle>
          <CardDescription>Competitor Radar · Rank Tracker · AI Page Auditor · Link Auditor · Keyword Opportunities · Internal Link Recommender</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          All tables are workspace-scoped. UI ports happen tab-by-tab in Phase 6.
        </CardContent>
      </Card>
    </div>
  ),
});
