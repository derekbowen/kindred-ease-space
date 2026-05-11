import {
  LayoutDashboard,
  FileText,
  Sparkles,
  ArrowRightLeft,
  Pencil,
  BookOpen,
  GraduationCap,
  Building2,
  Radar,
  TrendingUp,
  ScanSearch,
  Lightbulb,
  Target,
  Link2,
  Activity,
  LinkIcon,
  FileX2,
  Map,
  Download,
  Globe,
  MousePointerClick,
  CreditCard,
  Settings,
  Inbox,
  Mail,
  AlignEndHorizontal,
  ShieldCheck,
  ClipboardCheck,
  HandCoins,
  Users,
  Plug,
  LayoutTemplate,
  type LucideIcon,
  ThumbsUp,
} from "lucide-react";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  internalOnly?: boolean;
  exact?: boolean;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      { to: "/app", label: "Dashboard", icon: LayoutDashboard, exact: true },
      { to: "/app/seo-coach", label: "SEO Coach", icon: Sparkles },
    ],
  },
  {
    label: "Content",
    items: [
      { to: "/app/pages", label: "Pages", icon: LayoutTemplate },
      { to: "/app/content/quick-page-builder", label: "Quick Page Builder", icon: Sparkles },
      { to: "/app/content/generate", label: "Generate Content", icon: FileText },
      { to: "/app/content/migration", label: "Content Migration", icon: ArrowRightLeft },
      { to: "/app/content/bulk-editor", label: "Bulk Page Editor", icon: Pencil },
      { to: "/app/content/blog", label: "Blog Admin", icon: BookOpen },
      { to: "/app/content/learning", label: "Learning Admin", icon: GraduationCap },
      { to: "/app/content/city-heroes", label: "City Heroes", icon: Building2, internalOnly: true },
      { to: "/app/content/data-export", label: "Data Export", icon: Download },
      { to: "/app/content/data-import", label: "Data Import", icon: Download },
    ],
  },
  {
    label: "SEO",
    items: [
      { to: "/app/seo/competitor-radar", label: "Competitor Radar", icon: Radar },
      { to: "/app/seo/rank-tracker", label: "Rank Tracker", icon: TrendingUp },
      { to: "/app/seo/page-auditor", label: "AI Page Auditor", icon: ScanSearch },
      { to: "/app/seo/listing-auditor", label: "Listing Auditor", icon: ScanSearch },
      { to: "/app/seo/keyword-opportunities", label: "Keyword Opportunities", icon: Lightbulb },
      { to: "/app/seo/competitor-tracker", label: "Competitor Tracker", icon: Target },
      { to: "/app/seo/internal-links", label: "Internal Link Recommender", icon: Link2 },
      { to: "/app/seo/health", label: "SEO Health", icon: Activity },
      { to: "/app/seo/link-checker", label: "Link Checker", icon: LinkIcon },
      { to: "/app/seo/link-audit", label: "Link Audit Dashboard", icon: LinkIcon },
      { to: "/app/seo/missing-pages", label: "Missing Pages (404s)", icon: FileX2 },
      { to: "/app/seo/sitemap", label: "Sitemap & Indexing", icon: Map },
      { to: "/app/seo/gsc-import", label: "GSC Import", icon: Download },
      { to: "/app/seo/scrape-import", label: "Scrape Import", icon: Globe },
      { to: "/app/seo/click-report", label: "Click Report", icon: MousePointerClick },
      { to: "/app/seo/canonical-audit", label: "Canonical Audit", icon: ShieldCheck },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/app/billing", label: "Billing & Plans", icon: CreditCard },
      { to: "/app/settings", label: "Workspace Settings", icon: Settings },
      { to: "/app/settings/ai", label: "AI Providers", icon: Sparkles },
      { to: "/app/settings/api-keys", label: "API Keys", icon: Plug },
      { to: "/app/settings/integrations/sharetribe", label: "Sharetribe", icon: Plug },
    ],
  },
  {
    label: "Users & Ops",
    items: [
      { to: "/app/ops/lead-inbox", label: "Lead Inbox", icon: Inbox },
      { to: "/app/ops/ig-lead-hunter", label: "IG Lead Hunter", icon: Inbox, internalOnly: true },
      { to: "/app/ops/social-lead-hunter", label: "Social Lead Hunter", icon: Inbox, internalOnly: true },
      { to: "/app/ops/email-branding", label: "Email Branding", icon: Mail },
      { to: "/app/ops/email-verify", label: "Email Verify", icon: Mail },
      { to: "/app/ops/site-footer", label: "Site Footer", icon: AlignEndHorizontal },
      { to: "/app/ops/directory-moderation", label: "Directory Moderation", icon: ShieldCheck, internalOnly: true },
      { to: "/app/ops/listing-claims", label: "Listing Claims", icon: ClipboardCheck, internalOnly: true },
      { to: "/app/ops/plan-requests", label: "Plan Requests", icon: HandCoins, internalOnly: true },
      { to: "/app/ops/admin-team", label: "Admin Team", icon: Users },
      { to: "/app/admin/help/articles", label: "Help Articles", icon: BookOpen, internalOnly: true },
      { to: "/app/admin/help/categories", label: "Help Categories", icon: LayoutTemplate, internalOnly: true },
      { to: "/app/admin/help/feedback", label: "Help Feedback", icon: ThumbsUp, internalOnly: true },
    ],
  },
];
