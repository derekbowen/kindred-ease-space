import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, AlertCircle } from "lucide-react";
import {
  getLatestCanonicalAudit,
  runCanonicalAudit,
} from "@/lib/admin-canonical-audit.functions";

export const Route = createFileRoute("/_authenticated/app/seo/canonical-audit")({
  head: () => ({ meta: [{ title: "Canonical URL Audit — founders.click" }] }),
  component: CanonicalAuditPage,
});

function CanonicalAuditPage() {
  const fetchLatest = useServerFn(getLatestCanonicalAudit);
  const runAudit = useServerFn(runCanonicalAudit);

  const latest = useQuery({
    queryKey: ["canonical-audit", "latest"],
    queryFn: () => fetchLatest(),
  });

  const runMutation = useMutation({
    mutationFn: () => runAudit(),
    onSuccess: () => latest.refetch(),
  });

  const data = runMutation.data ?? latest.data;
  const failingPages = (data?.pages ?? []).filter(
    (p) => p.error || p.counts.preview > 0 || p.apexRedirectsToWww === false,
  );
  const warningPages = (data?.pages ?? []).filter(
    (p) => !failingPages.includes(p) && p.counts.apex > 0,
  );

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Canonical URL Audit</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Crawls the live site and verifies every <code>canonical</code>, <code>og:url</code>, and{" "}
            <code>&lt;a href&gt;</code> points to <code>https://www.founders.click</code>. Apex redirects are checked too.
          </p>
        </div>
        <Button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
        >
          {runMutation.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
          ) : (
            <><RefreshCw className="h-4 w-4 mr-2" />Run audit now</>
          )}
        </Button>
      </div>

      {latest.isLoading && !data ? (
        <div className="text-sm text-muted-foreground">Loading last run…</div>
      ) : null}

      {data && data.totalPages > 0 ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Pages crawled" value={data.totalPages} />
            <Stat label="Failing" value={data.pagesWithFailures} tone={data.pagesWithFailures ? "fail" : "ok"} />
            <Stat label="Warnings" value={data.pagesWithWarnings} tone={data.pagesWithWarnings ? "warn" : "ok"} />
            <Stat label="Last run" value={new Date(data.startedAt).toLocaleString()} small />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Canonical URLs" value={data.totals.canonical} tone="ok" />
            <Stat label="Apex hits" value={data.totals.apex} tone={data.totals.apex ? "warn" : "ok"} />
            <Stat label="Preview-host hits" value={data.totals.preview} tone={data.totals.preview ? "fail" : "ok"} />
            <Stat label="External (allowed)" value={data.totals.external} small />
          </div>

          <ResultGroup
            title="Failing pages"
            icon={<AlertCircle className="h-4 w-4 text-destructive" />}
            empty="No failing pages."
            pages={failingPages}
          />
          <ResultGroup
            title="Warnings (apex URL baked into HTML)"
            icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
            empty="No warnings."
            pages={warningPages}
          />
        </>
      ) : !latest.isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No audit has run yet. Click <strong>Run audit now</strong> to crawl the site.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone, small }: { label: string; value: string | number; tone?: "ok" | "warn" | "fail"; small?: boolean }) {
  const color =
    tone === "fail" ? "text-destructive" : tone === "warn" ? "text-amber-500" : tone === "ok" ? "text-emerald-500" : "";
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 ${small ? "text-sm" : "text-2xl"} font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ResultGroup({
  title,
  icon,
  empty,
  pages,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  pages: NonNullable<ReturnType<typeof getLatestCanonicalAudit> extends Promise<infer R> ? R : never>["pages"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {icon}{title} <Badge variant="secondary" className="ml-auto">{pages.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {pages.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />{empty}
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="space-y-3">
              {pages.map((p) => (
                <li key={p.url} className="border rounded-md p-3">
                  <div className="flex items-center justify-between gap-2">
                    <a href={p.url} target="_blank" rel="noreferrer" className="font-mono text-xs truncate hover:underline">
                      {p.url}
                    </a>
                    <Badge variant={p.ok ? "secondary" : "destructive"}>{p.status || "ERR"}</Badge>
                  </div>
                  {p.error ? (
                    <div className="text-xs text-destructive mt-1">Fetch error: {p.error}</div>
                  ) : null}
                  {p.apexRedirectsToWww === false ? (
                    <div className="text-xs text-destructive mt-1">Apex did not 301 → www.</div>
                  ) : null}
                  {p.issues.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {p.issues.slice(0, 12).map((iss, i) => (
                        <li key={i} className="text-xs flex gap-2">
                          <Badge
                            variant={iss.classification === "preview" ? "destructive" : "outline"}
                            className="shrink-0"
                          >
                            {iss.source}/{iss.classification}
                          </Badge>
                          <span className="font-mono truncate">{iss.url}</span>
                        </li>
                      ))}
                      {p.issues.length > 12 ? (
                        <li className="text-xs text-muted-foreground">…and {p.issues.length - 12} more</li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
