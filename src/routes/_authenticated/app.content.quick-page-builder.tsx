import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/content/quick-page-builder")({
  head: () => ({ meta: [{ title: "Quick Page Builder — founders.click" }] }),
  component: QuickPageBuilder,
});

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function QuickPageBuilder() {
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("city");
  const [keyword, setKeyword] = useState("");
  const slug = title ? slugify(title) : "";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Quick Page Builder</h1>
        <Badge variant="outline" className="gap-1"><Sparkles className="h-3 w-3" /> AI</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New page</CardTitle>
          <CardDescription>
            Generate a programmatic page that publishes at <code>/p/{slug || "{slug}"}</code> via the fresh-web reverse proxy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Page title</Label>
            <Input
              id="title"
              placeholder="Pool Rental in Los Angeles, CA"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            {slug && (
              <p className="text-xs text-muted-foreground">
                URL: <code>/p/{slug}</code>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="model">Page model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="city">City landing</SelectItem>
                <SelectItem value="host-acquisition">Host acquisition</SelectItem>
                <SelectItem value="comparison">Comparison</SelectItem>
                <SelectItem value="guide">Guide / how-to</SelectItem>
                <SelectItem value="spanish">Spanish (es)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="keyword">Primary keyword</Label>
            <Textarea
              id="keyword"
              rows={3}
              placeholder="pool rental los angeles"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <Button disabled={!title} className="gap-2">
              <Sparkles className="h-4 w-4" /> Generate draft
            </Button>
            <Button variant="outline" disabled={!title}>
              Save as draft
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Generation, content_pages writes, and publishing land in the next pass.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
