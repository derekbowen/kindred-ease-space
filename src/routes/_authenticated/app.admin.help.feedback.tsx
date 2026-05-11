import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ThumbsUp, ThumbsDown, MessageSquareWarning, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminFeedbackOverview } from "@/lib/help-admin.functions";

export const Route = createFileRoute("/_authenticated/app/admin/help/feedback")({
  head: () => ({ meta: [{ title: "Help Feedback — Admin" }] }),
  component: AdminHelpFeedbackPage,
});

type Overview = Awaited<ReturnType<typeof adminFeedbackOverview>>;
type ArticleStat = Overview["articles"][number];
type SortKey = "worst" | "most_votes" | "recent_negative" | "best";

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 100)}%`;
}

function ratioTone(r: number | null): string {
  if (r === null) return "text-muted-foreground";
  if (r >= 0.8) return "text-emerald-600";
  if (r >= 0.5) return "text-amber-600";
  return "text-destructive";
}

function AdminHelpFeedbackPage() {
  const fetchFn = useServerFn(adminFeedbackOverview);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("worst");

  useEffect(() => {
    setLoading(true);
    fetchFn({ data: { days } })
      .then((d) => {
        setData(d);
        setForbidden(false);
      })
      .catch((e) => {
        if (String(e?.message ?? e).includes("forbidden")) setForbidden(true);
      })
      .finally(() => setLoading(false));
  }, [days, fetchFn]);

  const articles = useMemo<ArticleStat[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    let rows = data.articles.filter((a) =>
      !q ||
      a.title.toLowerCase().includes(q) ||
      a.slug.toLowerCase().includes(q) ||
      a.category_slug.toLowerCase().includes(q)
    );
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "best":
          return (b.helpful_ratio ?? -1) - (a.helpful_ratio ?? -1);
        case "most_votes":
          return b.total_votes - a.total_votes;
        case "recent_negative":
          return b.recent_not_helpful - a.recent_not_helpful;
        case "worst":
        default: {
          // worst = lowest ratio with at least 1 vote, then by negative volume
          const ar = a.helpful_ratio ?? 2;
          const br = b.helpful_ratio ?? 2;
          if (ar !== br) return ar - br;
          return b.not_helpful_count - a.not_helpful_count;
        }
      }
    });
    return rows;
  }, [data, query, sort]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You need an admin role to view help feedback.
        </p>
      </div>
    );
  }

  const totals = data?.totals;
  const overallTotal = (totals?.helpful ?? 0) + (totals?.not_helpful ?? 0);
  const overallRatio = overallTotal > 0 ? (totals!.helpful / overallTotal) : null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/app/admin/help/articles"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Back to articles
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Help Feedback</h1>
          <p className="text-sm text-muted-foreground">
            Aggregated helpful / not helpful ratings and the most-reported issues per article.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last 12 months</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Helpful (all-time)"
          value={totals?.helpful ?? 0}
          icon={<ThumbsUp className="h-4 w-4 text-emerald-600" />}
        />
        <SummaryCard
          label="Not helpful (all-time)"
          value={totals?.not_helpful ?? 0}
          icon={<ThumbsDown className="h-4 w-4 text-destructive" />}
        />
        <SummaryCard
          label="Helpful ratio"
          value={pct(overallRatio)}
          icon={<span className={`text-base font-semibold ${ratioTone(overallRatio)}`}>%</span>}
        />
        <SummaryCard
          label={`Recent (${days}d) negative`}
          value={totals?.recent_not_helpful ?? 0}
          icon={<MessageSquareWarning className="h-4 w-4 text-amber-600" />}
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search articles by title, slug, category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-sm"
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="worst">Worst rated first</SelectItem>
              <SelectItem value="recent_negative">Most recent negative</SelectItem>
              <SelectItem value="most_votes">Most votes</SelectItem>
              <SelectItem value="best">Best rated first</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">
            {articles.length} article{articles.length === 1 ? "" : "s"}
          </span>
        </div>
      </Card>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading feedback…</div>
      ) : articles.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          No articles match your filter.
        </Card>
      ) : (
        <div className="space-y-3">
          {articles.map((a) => (
            <ArticleRow key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </Card>
  );
}

function ArticleRow({ a }: { a: ArticleStat }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/app/admin/help/articles/$id"
              params={{ id: a.id }}
              className="font-medium hover:underline"
            >
              {a.title}
            </Link>
            <Badge variant="outline" className="text-[10px]">{a.category_slug}</Badge>
            <Badge
              variant={a.status === "published" ? "default" : "secondary"}
              className="text-[10px] capitalize"
            >
              {a.status}
            </Badge>
            <Link
              to="/help/$slug"
              params={{ slug: a.slug }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" /> View
            </Link>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">/{a.slug}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Stat icon={<ThumbsUp className="h-3.5 w-3.5 text-emerald-600" />} value={a.helpful_count} />
          <Stat icon={<ThumbsDown className="h-3.5 w-3.5 text-destructive" />} value={a.not_helpful_count} />
          <div className={`text-base font-semibold ${ratioTone(a.helpful_ratio)}`}>
            {pct(a.helpful_ratio)}
          </div>
          <div className="text-xs text-muted-foreground">{a.view_count} views</div>
        </div>
      </div>

      {a.helpful_ratio !== null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${Math.round((a.helpful_ratio ?? 0) * 100)}%` }}
          />
        </div>
      )}

      {a.top_issues.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Top reported issues
          </p>
          <ul className="space-y-1.5">
            {a.top_issues.map((iss) => (
              <li key={iss.key} className="flex items-start gap-2 text-sm">
                <Badge variant="secondary" className="shrink-0">×{iss.count}</Badge>
                <span className="text-muted-foreground">{iss.sample}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Stat({ icon, value }: { icon: React.ReactNode; value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <span className="tabular-nums">{value}</span>
    </span>
  );
}
