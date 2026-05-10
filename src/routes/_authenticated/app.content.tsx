import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/app/content")({
  head: () => ({ meta: [{ title: "Content — founders.click" }] }),
  component: () => (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Content</h1>
      <Card>
        <CardHeader>
          <CardTitle>Quick Page Builder</CardTitle>
          <CardDescription>Type a title, pick a model, publish at /p/{`{slug}`}.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Wired in next pass — pulls from your content_plan table and writes to content_pages scoped to your workspace.
        </CardContent>
      </Card>
    </div>
  ),
});
