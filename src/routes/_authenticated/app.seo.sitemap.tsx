import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  EXCLUSION_LABELS,
  EXCLUSION_ORDER,
  SITEMAP_FRESHNESS_MINUTES,
  describeSitemapCheck,
  downloadSitemapXml,
  getSitemapStatus,
  recheckSitemap,
  type CheckTone,
  type SitemapBuildView,
  type SitemapCheck,
  type SitemapDomainView,
  type SitemapStatusView,
} from "@/lib/sitemap-status.functions";
import { userMessage } from "@/lib/user-message";

export const Route = createFileRoute("/_authenticated/app/seo/sitemap")({
  head: () => ({ meta: [{ title: "Sitemap — founders.click" }] }),
  component: SitemapPage,
});

const LOAD_FAILED = "Couldn't load your sitemap status. Refresh the page to try again.";
const RECHECK_FAILED = "Couldn't run the check. Try again in a minute.";
const DOWNLOAD_FAILED = "Couldn't prepare the download. Try again in a minute.";

function SitemapPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [view, setView] = useState<SitemapStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useServerFn(getSitemapStatus);

  useEffect(() => {
    getMe()
      .then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null))
      .catch((e) => setLoadError(userMessage(e, LOAD_FAILED)))
      .finally(() => setResolved(true));
  }, []);

  const reload = useCallback(
    async (ws: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        setView(await load({ data: { workspaceId: ws } }));
      } catch (e) {
        console.error("[sitemap] status failed", e);
        setLoadError(userMessage(e, LOAD_FAILED));
      } finally {
        setLoading(false);
      }
    },
    [load],
  );

  useEffect(() => {
    if (workspaceId) reload(workspaceId);
  }, [workspaceId, reload]);

  const replaceCheck = (domainId: string, check: SitemapCheck) =>
    setView((v) =>
      v ? { ...v, domains: v.domains.map((d) => (d.id === domainId ? { ...d, check } : d)) } : v,
    );

  return (
    <div className="max-w-3xl space-y-6 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Sitemap</h1>
          <p className="text-sm text-muted-foreground">
            The list of your published pages that search engines can read. It updates on its own:
            changes to your pages appear in it within {SITEMAP_FRESHNESS_MINUTES} minutes.
          </p>
        </div>
        {workspaceId && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => reload(workspaceId)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </Button>
        )}
      </div>

      {loadError && <Notice tone="error" title="Something went wrong" lines={[loadError]} />}

      {!view && !loadError && (!resolved || loading) && (
        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Building your sitemap…
          </CardContent>
        </Card>
      )}

      {resolved && !workspaceId && !loadError && (
        <Notice
          tone="neutral"
          title="No workspace"
          lines={["You're not a member of a workspace yet."]}
        />
      )}

      {view && workspaceId && (
        <>
          <AddressCard view={view} />
          <ContentsCard build={view.build} />
          {view.domains.map((d) => (
            <CheckCard
              key={d.id}
              workspaceId={workspaceId}
              domain={d}
              onChecked={(check) => replaceCheck(d.id, check)}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddressCard({ view }: { view: SitemapStatusView }) {
  if (view.domains.length === 0) {
    const step = view.step;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your sitemap address</CardTitle>
          <CardDescription>
            Your sitemap is published at <code>/a/sitemap.xml</code> on your own domain, once that
            domain is live. There's no address to share until then.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {step && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="font-medium">Next step: {step.title}</p>
              <p className="mt-1 text-muted-foreground">{step.detail}</p>
            </div>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to="/app/settings/domains">Open Settings → Domains</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your sitemap address</CardTitle>
        <CardDescription>
          Changes to your pages appear here within {view.freshnessMinutes} minutes — not instantly.
          Your site's own <code>/sitemap.xml</code> and <code>robots.txt</code> stay yours; we never
          replace them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {view.domains.map((d) => (
          <div key={d.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 text-xs">{d.sitemapUrl}</code>
              <Button asChild size="sm" variant="outline" className="gap-1">
                <a href={d.sitemapUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              </Button>
              <CopyButton text={d.sitemapUrl} label="Copy" />
            </div>
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <p className="font-medium">Tell search engines where it is</p>
              {d.robotsLine ? (
                <>
                  <p className="text-muted-foreground">
                    Add this line to your marketplace's robots.txt (
                    <code>https://{d.hostname}/robots.txt</code>):
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-muted px-2 py-1 text-xs">
                      {d.robotsLine}
                    </code>
                    <CopyButton text={d.robotsLine} label="Copy line" />
                  </div>
                  <p className="text-muted-foreground">
                    Or submit the address in Google Search Console, under Indexing → Sitemaps.
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Submit the address in Google Search Console (Indexing → Sitemaps) for {d.hostname}
                  .
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                founders.click doesn't submit your sitemap for you, and a page being listed doesn't
                mean it's indexed — Search Console shows what Google has actually indexed.
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContentsCard({ build }: { build: SitemapBuildView }) {
  if (!build.ok) {
    return (
      <Notice
        tone="warn"
        title="We couldn't read everything needed to build your sitemap"
        lines={[
          ...build.problems,
          "Until this clears, your sitemap address answers “temporarily unavailable” and search engines try again later — it never serves a partial list.",
        ]}
      />
    );
  }
  const leftOut = EXCLUSION_ORDER.filter((r) => build.excluded[r] > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>What's in it</CardTitle>
        <CardDescription>
          Published pages on an available template, with listings to show (or enough text, for
          articles), that aren't set to noindex or redirected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          <span className="text-3xl font-bold">{build.included.toLocaleString()}</span>{" "}
          <span className="text-muted-foreground">
            page{build.included === 1 ? "" : "s"} included
          </span>
        </p>
        {build.paused && (
          <Notice
            tone="neutral"
            title="Your pages are paused, so the sitemap is empty"
            lines={[build.paused.reason]}
          />
        )}
        {leftOut.length === 0 ? (
          <p className="text-muted-foreground">No pages are left out.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Left out</th>
                  <th className="py-2 pr-4 text-right">Pages</th>
                  <th className="py-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {leftOut.map((r) => (
                  <tr key={r} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">{EXCLUSION_LABELS[r].label}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {build.excluded[r].toLocaleString()}
                    </td>
                    <td className="py-2 text-muted-foreground">{EXCLUSION_LABELS[r].help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {build.warnings.length > 0 && (
          <Notice tone="warn" title="Worth knowing" lines={build.warnings} />
        )}
      </CardContent>
    </Card>
  );
}

function CheckCard({
  workspaceId,
  domain,
  onChecked,
}: {
  workspaceId: string;
  domain: SitemapDomainView;
  onChecked: (check: SitemapCheck) => void;
}) {
  const recheck = useServerFn(recheckSitemap);
  const download = useServerFn(downloadSitemapXml);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState<number | "main" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const c = domain.check;
  const facts = describeSitemapCheck(c);

  async function onRecheck() {
    setChecking(true);
    setError(null);
    setUnsaved(false);
    try {
      const r = await recheck({ data: { workspaceId, domainId: domain.id } });
      onChecked(r.check);
      setUnsaved(!r.saved);
    } catch (e) {
      console.error("[sitemap] recheck failed", e);
      setError(userMessage(e, RECHECK_FAILED));
    } finally {
      setChecking(false);
    }
  }

  async function onDownload(page?: number) {
    setDownloading(page ?? "main");
    setError(null);
    try {
      const r = await download({ data: { workspaceId, domainId: domain.id, page } });
      const url = URL.createObjectURL(new Blob([r.xml], { type: "application/xml;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (e) {
      console.error("[sitemap] download failed", e);
      setError(userMessage(e, DOWNLOAD_FAILED));
    } finally {
      setDownloading(null);
    }
  }

  const parts = domain.parts ?? 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Check — {domain.hostname}</CardTitle>
        <CardDescription>
          A check builds your sitemap here and validates the XML (structure, escaping, the
          50,000-URL and 50 MB limits), then fetches <code>{domain.sitemapUrl}</code> and compares
          the two lists.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Notice tone={facts.tone} title={facts.title} lines={[facts.detail]} />
        {c && (
          <div className="space-y-2 text-muted-foreground">
            <p>
              Last checked {formatWhen(c.checked_at)}
              {c.http_status !== null && <> · HTTP {c.http_status}</>}
              {c.included !== null && (
                <> · {c.included.toLocaleString()} URLs in the live sitemap</>
              )}
              {c.expected !== null && <> · {c.expected.toLocaleString()} expected</>}
            </p>
            {c.errors.length > (facts.detail === c.errors[0] ? 1 : 0) && (
              <ul className="list-disc space-y-1 pl-5">
                {c.errors
                  .filter((e) => e !== facts.detail)
                  .map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
              </ul>
            )}
            <UrlSample
              title="Missing from the live sitemap"
              urls={c.missing}
              total={c.missing_count}
            />
            <UrlSample
              title="Listed but not expected"
              urls={c.unexpected}
              total={c.unexpected_count}
            />
          </div>
        )}
        {unsaved && (
          <p className="text-xs text-amber-700">
            This result couldn't be saved, so it's shown here only. Run the check again later.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onRecheck} disabled={checking} className="gap-2">
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {checking ? "Checking…" : "Recheck"}
          </Button>
          <Button
            variant="outline"
            onClick={() => onDownload()}
            disabled={downloading !== null}
            className="gap-2"
          >
            {downloading === "main" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download XML{parts > 1 ? " (index)" : ""}
          </Button>
          {parts > 1 &&
            Array.from({ length: parts }, (_, i) => i + 1).map((k) => (
              <Button
                key={k}
                variant="ghost"
                size="sm"
                onClick={() => onDownload(k)}
                disabled={downloading !== null}
              >
                {downloading === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Part ${k}`}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function UrlSample({ title, urls, total }: { title: string; urls: string[]; total: number }) {
  if (total === 0) return null;
  return (
    <div>
      <p className="font-medium text-foreground">
        {title} ({total.toLocaleString()})
      </p>
      <ul className="mt-1 space-y-0.5 font-mono text-xs">
        {urls.map((u) => (
          <li key={u} className="break-all">
            {u}
          </li>
        ))}
        {total > urls.length && <li>…and {(total - urls.length).toLocaleString()} more</li>}
      </ul>
    </div>
  );
}

const TONE_STYLE: Record<CheckTone, { box: string; icon: typeof Info; iconClass: string }> = {
  ok: {
    box: "border-emerald-500/40 bg-emerald-500/5",
    icon: CheckCircle2,
    iconClass: "text-emerald-600",
  },
  neutral: { box: "border-border bg-muted/30", icon: Info, iconClass: "text-muted-foreground" },
  warn: {
    box: "border-amber-500/40 bg-amber-500/5",
    icon: AlertTriangle,
    iconClass: "text-amber-600",
  },
  error: {
    box: "border-destructive/40 bg-destructive/5",
    icon: XCircle,
    iconClass: "text-destructive",
  },
};

function Notice({ tone, title, lines }: { tone: CheckTone; title: string; lines: string[] }) {
  const s = TONE_STYLE[tone];
  const Icon = s.icon;
  return (
    <div className={`flex gap-3 rounded-md border p-3 text-sm ${s.box}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.iconClass}`} />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {lines.map((l, i) => (
          <p key={i} className="text-muted-foreground">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          })
          .catch(() => setCopied(false));
      }}
    >
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : label}
    </Button>
  );
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "at an unknown time";
}
