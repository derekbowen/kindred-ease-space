import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CANONICAL_ORIGIN, canonicalUrl } from "@/lib/canonical";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Globe,
  Image as ImageIcon,
} from "lucide-react";

type Props = {
  title: string;
  slug: string;
  categorySlug: string;
  excerpt: string;
  content: string;
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  authorName: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  ogImage?: string | null;
};

const TITLE_SUFFIX = " — founders.click Help";

function truncate(s: string, n: number) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function firstParagraph(md: string): string {
  if (!md) return "";
  const stripped = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(new RegExp("!\\[[^\\]]*\\]\\([^)]*\\)", "g"), "")
    .replace(new RegExp("\\[([^\\]]+)\\]\\([^)]*\\)", "g"), "$1")
    .replace(/[`*_>#~]/g, "")
    .trim();
  const para = stripped.split(/\n{2,}/).find((p) => p.trim().length > 0) ?? "";
  return para.replace(/\s+/g, " ").trim();
}

export function SeoPreviewPanel(props: Props) {
  const {
    title,
    slug,
    categorySlug,
    excerpt,
    content,
    seoTitle,
    seoDescription,
    tags,
    authorName,
    publishedAt,
    updatedAt,
    ogImage,
  } = props;

  const path = `/help/${categorySlug || "category"}/${slug || "slug"}`;
  const canonical = canonicalUrl(path);
  const displayUrl = `${CANONICAL_ORIGIN.replace(/^https?:\/\//, "")}${path}`.replace(
    /^www\./,
    "www.",
  );

  const resolvedTitle = (seoTitle || title || "Untitled").trim();
  const fullTitle = resolvedTitle.endsWith(TITLE_SUFFIX)
    ? resolvedTitle
    : `${resolvedTitle}${TITLE_SUFFIX}`;
  const resolvedDescription = (seoDescription || excerpt || firstParagraph(content) || "").trim();

  const jsonLd = useMemo(() => {
    const articleLd = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: title || "Untitled",
      description: resolvedDescription || undefined,
      datePublished: publishedAt || undefined,
      dateModified: updatedAt || publishedAt || undefined,
      author: {
        "@type": "Organization",
        name: authorName || "founders.click",
      },
      mainEntityOfPage: canonical,
      keywords: tags.length ? tags.join(", ") : undefined,
      ...(ogImage ? { image: ogImage } : {}),
    };
    const breadcrumbLd = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Help", item: canonicalUrl("/help") },
        {
          "@type": "ListItem",
          position: 2,
          name: categorySlug || "category",
          item: canonicalUrl(`/help/${categorySlug || "category"}`),
        },
        { "@type": "ListItem", position: 3, name: title || "Untitled", item: canonical },
      ],
    };
    return [articleLd, breadcrumbLd];
  }, [
    title,
    resolvedDescription,
    publishedAt,
    updatedAt,
    authorName,
    canonical,
    tags,
    ogImage,
    categorySlug,
  ]);

  const issues = useMemo(() => {
    const out: { level: "warn" | "error" | "ok"; msg: string }[] = [];
    if (!title.trim()) out.push({ level: "error", msg: "Missing title" });
    if (!slug.trim()) out.push({ level: "error", msg: "Missing slug" });
    if (!resolvedDescription)
      out.push({ level: "warn", msg: "No description (excerpt or SEO description)" });
    if (resolvedTitle.length > 60)
      out.push({
        level: "warn",
        msg: `SEO title is ${resolvedTitle.length} chars — Google truncates near 60.`,
      });
    if (resolvedTitle.length > 0 && resolvedTitle.length < 25)
      out.push({ level: "warn", msg: "SEO title is very short — aim for 40–60 chars." });
    if (resolvedDescription.length > 160)
      out.push({
        level: "warn",
        msg: `Description is ${resolvedDescription.length} chars — Google truncates near 160.`,
      });
    if (resolvedDescription && resolvedDescription.length < 70)
      out.push({ level: "warn", msg: "Description is short — aim for 120–160 chars." });
    if (slug && !/^[a-z0-9-]+$/.test(slug))
      out.push({
        level: "error",
        msg: "Slug should only contain lowercase letters, numbers and hyphens.",
      });
    if (tags.length === 0)
      out.push({ level: "warn", msg: "No tags — helps internal search and JSON-LD keywords." });
    if (out.length === 0) out.push({ level: "ok", msg: "Looks good." });
    return out;
  }, [title, slug, resolvedTitle, resolvedDescription, tags]);

  return (
    <Card className="p-4 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">SEO &amp; sharing preview</h3>
          <p className="text-xs text-muted-foreground">
            Live preview of how this article appears in search and social.
          </p>
        </div>
      </div>

      <IssuesList issues={issues} />

      <Section label="Canonical URL" icon={<Globe className="h-3.5 w-3.5" />}>
        <CopyableUrl value={canonical} />
      </Section>

      <Section label="Google search result">
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-orange-500/15 text-[10px] font-bold text-orange-600">
              fc
            </span>
            <span>founders.click</span>
            <span className="text-muted-foreground/50">›</span>
            <span className="truncate">{displayUrl}</span>
          </div>
          <p className="mt-1 text-base text-[#1a0dab] dark:text-blue-400 leading-snug line-clamp-1">
            {truncate(fullTitle, 70)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
            {truncate(resolvedDescription || "No description provided.", 170)}
          </p>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            <CharCount value={fullTitle} max={60} label="title" />
            {" · "}
            <CharCount value={resolvedDescription} max={160} label="desc" />
          </div>
        </div>
      </Section>

      <Section label="Open Graph (Facebook, LinkedIn, Slack)">
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <div className="aspect-[1.91/1] w-full bg-gradient-to-br from-orange-500/15 via-amber-500/10 to-rose-500/15 flex items-center justify-center">
            {ogImage ? (
              <img src={ogImage} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="text-center text-muted-foreground">
                <ImageIcon className="mx-auto h-6 w-6" />
                <p className="mt-1 text-xs">No og:image — site default will be used</p>
              </div>
            )}
          </div>
          <div className="border-t border-border bg-muted/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {displayUrl.split("/")[0]}
            </p>
            <p className="mt-0.5 text-sm font-semibold leading-snug line-clamp-2">
              {title || "Untitled"}
            </p>
            {resolvedDescription && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {resolvedDescription}
              </p>
            )}
          </div>
        </div>
      </Section>

      <Section label="Twitter / X card">
        <div className="overflow-hidden rounded-2xl border border-border bg-background">
          <div className="aspect-[2/1] w-full bg-gradient-to-br from-sky-500/10 via-indigo-500/10 to-orange-500/10 flex items-center justify-center">
            {ogImage ? (
              <img src={ogImage} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            )}
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {displayUrl}
            </p>
            <p className="mt-0.5 text-sm font-semibold leading-snug line-clamp-1">
              {title || "Untitled"}
            </p>
            {resolvedDescription && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                {resolvedDescription}
              </p>
            )}
          </div>
        </div>
      </Section>

      <JsonLdSection jsonLd={jsonLd} />
    </Card>
  );
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </p>
      {children}
    </div>
  );
}

function CopyableUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs">
      <code className="flex-1 truncate font-mono">{value}</code>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "Copied" : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function CharCount({ value, max, label }: { value: string; max: number; label: string }) {
  const len = value.length;
  const ok = len > 0 && len <= max;
  return (
    <span className={ok ? "text-muted-foreground" : "text-amber-600"}>
      {label}: {len}/{max}
    </span>
  );
}

function IssuesList({ issues }: { issues: { level: "warn" | "error" | "ok"; msg: string }[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((i, idx) => {
        const Icon =
          i.level === "ok" ? CheckCircle2 : i.level === "error" ? AlertCircle : AlertCircle;
        const color =
          i.level === "ok"
            ? "text-emerald-600"
            : i.level === "error"
              ? "text-destructive"
              : "text-amber-600";
        return (
          <li key={idx} className="flex items-start gap-1.5 text-xs">
            <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${color}`} />
            <span className="text-muted-foreground">{i.msg}</span>
          </li>
        );
      })}
    </ul>
  );
}

function JsonLdSection({ jsonLd }: { jsonLd: object[] }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(jsonLd, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-left text-xs"
      >
        <span className="inline-flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            JSON-LD
          </Badge>
          <span className="text-muted-foreground">
            Auto-generated structured data ({jsonLd.length} blocks)
          </span>
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-muted/20">
          <div className="flex items-center justify-end px-2 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? (
                "Copied"
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" /> Copy
                </>
              )}
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto px-3 pb-3 text-[11px] leading-relaxed">
            <code>{text}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
