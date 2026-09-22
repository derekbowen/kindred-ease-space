import {
  LayoutDashboard,
  MessagesSquare,
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
  Share2,
  Megaphone,
  Wallet,
  Palette,
  Store,
  LifeBuoy,
} from "lucide-react";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  internalOnly?: boolean;
  /** Scaffolded UI only — hidden from the sidebar in production. */
  stub?: boolean;
  /**
   * Part of the launch product. The shell shows ONLY launch items unless
   * ?showStubs=1 is appended, so a route can be finished and routable yet
   * still kept out of the sidebar until we are ready to stand behind it.
   * Never combine with `stub` — a launch item is one we actually ship.
   */
  launch?: boolean;
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
      { to: "/app", label: "Dashboard", icon: LayoutDashboard, exact: true, launch: true },
      // Coach still runs (the launcher in the shell and the dashboard briefing
      // use it) but it is not a launch surface, so it stays off the sidebar.
      { to: "/app/coach", label: "Coach", icon: MessagesSquare, launch: false },
      { to: "/app/seo-coach", label: "SEO Coach", icon: Sparkles, launch: false },
    ],
  },
  {
    label: "Content",
    items: [
      { to: "/app/pages", label: "Pages", icon: LayoutTemplate, launch: true },
      {
        to: "/app/content/quick-page-builder",
        label: "Quick Page Builder",
        icon: Sparkles,
        launch: true,
      },
      { to: "/app/content/generate", label: "Generate Content", icon: FileText, launch: true },
      {
        to: "/app/content/migration",
        label: "Content Migration",
        icon: ArrowRightLeft,
        stub: true,
      },
      { to: "/app/content/bulk-editor", label: "Bulk Page Editor", icon: Pencil, launch: false },
      { to: "/app/content/blog", label: "Blog Admin", icon: BookOpen, stub: true },
      { to: "/app/content/learning", label: "Learning Admin", icon: GraduationCap, stub: true },
      {
        to: "/app/content/city-heroes",
        label: "City Heroes",
        icon: Building2,
        internalOnly: true,
        stub: true,
      },
      { to: "/app/content/data-export", label: "Data Export", icon: Download, launch: true },
      { to: "/app/content/data-import", label: "Data Import", icon: Download, launch: false },
    ],
  },

  {
    label: "SEO",
    items: [
      { to: "/app/seo/competitor-radar", label: "Competitor Radar", icon: Radar, stub: true },
      { to: "/app/seo/rank-tracker", label: "Rank Tracker", icon: TrendingUp, launch: false },
      { to: "/app/seo/page-auditor", label: "AI Page Auditor", icon: ScanSearch, launch: false },
      { to: "/app/seo/listing-auditor", label: "Listing Auditor", icon: ScanSearch, stub: true },
      {
        to: "/app/seo/keyword-opportunities",
        label: "Keyword Opportunities",
        icon: Lightbulb,
        launch: false,
      },
      {
        to: "/app/seo/competitor-tracker",
        label: "Competitor Tracker",
        icon: Target,
        launch: false,
      },
      {
        to: "/app/seo/internal-links",
        label: "Internal Link Recommender",
        icon: Link2,
        launch: false,
      },
      { to: "/app/seo/health", label: "SEO Health", icon: Activity, stub: true },
      { to: "/app/seo/link-checker", label: "Link Checker", icon: LinkIcon, launch: false },
      { to: "/app/seo/link-audit", label: "Link Audit Dashboard", icon: LinkIcon, stub: true },
      { to: "/app/seo/missing-pages", label: "Missing Pages (404s)", icon: FileX2, launch: false },
      { to: "/app/seo/sitemap", label: "Sitemap & Indexing", icon: Map, stub: true },
      { to: "/app/seo/gsc-import", label: "GSC Import", icon: Download, launch: false },
      { to: "/app/seo/scrape-import", label: "Scrape Import", icon: Globe, stub: true },
      // Click Report reads city_link_clicks, which nothing writes yet — stub
      // until a tracker exists. Canonical Audit is platform-admin-only (it
      // audits founders.click itself) and throws Forbidden for customers.
      { to: "/app/seo/click-report", label: "Click Report", icon: MousePointerClick, stub: true },
      {
        to: "/app/seo/canonical-audit",
        label: "Canonical Audit",
        icon: ShieldCheck,
        internalOnly: true,
        launch: true,
      },
    ],
  },

  {
    // Affiliates work end to end, so they ship — as an add-on rather than a
    // headline surface, next to the page that turns them on.
    label: "Add-ons",
    items: [
      { to: "/app/addons", label: "Add-ons", icon: Store, launch: true },
      {
        to: "/app/affiliates",
        label: "Affiliate Dashboard",
        icon: Share2,
        exact: true,
        launch: true,
      },
      { to: "/app/affiliates/programs", label: "Programs", icon: Megaphone, launch: true },
      { to: "/app/affiliates/directory", label: "Affiliates", icon: Users, launch: true },
      { to: "/app/affiliates/payouts", label: "Payouts", icon: Wallet, launch: true },
      { to: "/app/affiliates/customise", label: "Customise", icon: Palette, launch: true },
      {
        to: "/app/affiliates/settings",
        label: "Affiliate Settings",
        icon: Settings,
        launch: true,
      },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/app/billing", label: "Billing & Plans", icon: CreditCard, launch: true },
      // Workspace Settings' own sub-nav exposes Domains and Sharetribe.
      { to: "/app/settings", label: "Workspace Settings", icon: Settings, launch: true },
      { to: "/app/settings/ai", label: "AI Providers", icon: Sparkles, launch: false },
      { to: "/app/settings/api-keys", label: "API Keys", icon: Plug, launch: false },
      {
        to: "/app/settings/integrations/sharetribe",
        label: "Sharetribe",
        icon: Plug,
        launch: true,
      },
      // The public contact form is the support path for the beta: it files a
      // ticket and notifies the support inbox. No in-app page needed.
      { to: "/help/contact", label: "Help & feedback", icon: LifeBuoy, launch: true },
    ],
  },
  {
    label: "Users & Ops",
    items: [
      { to: "/app/ops/lead-inbox", label: "Lead Inbox", icon: Inbox, stub: true },
      {
        to: "/app/ops/ig-lead-hunter",
        label: "IG Lead Hunter",
        icon: Inbox,
        internalOnly: true,
        stub: true,
      },
      {
        to: "/app/ops/social-lead-hunter",
        label: "Social Lead Hunter",
        icon: Inbox,
        internalOnly: true,
        stub: true,
      },
      { to: "/app/ops/email-branding", label: "Email Branding", icon: Mail, stub: true },
      { to: "/app/ops/email-verify", label: "Email Verify", icon: Mail, stub: true },
      { to: "/app/ops/site-footer", label: "Site Footer", icon: AlignEndHorizontal, stub: true },
      {
        to: "/app/ops/directory-moderation",
        label: "Directory Moderation",
        icon: ShieldCheck,
        internalOnly: true,
        stub: true,
      },
      {
        to: "/app/ops/listing-claims",
        label: "Listing Claims",
        icon: ClipboardCheck,
        internalOnly: true,
        stub: true,
      },
      // The internal-only tools below are how we RUN the launch (grant beta
      // access, answer tickets, edit help and email copy), so they are launch
      // items. internalOnly already keeps them off every customer's sidebar.
      {
        to: "/app/ops/plan-requests",
        label: "Entitlements & Beta",
        icon: HandCoins,
        internalOnly: true,
        launch: true,
      },
      { to: "/app/ops/admin-team", label: "Admin Team", icon: Users, stub: true },

      {
        to: "/app/admin/help/articles",
        label: "Help Articles",
        icon: BookOpen,
        internalOnly: true,
        launch: true,
      },
      {
        to: "/app/admin/help/categories",
        label: "Help Categories",
        icon: LayoutTemplate,
        internalOnly: true,
        launch: true,
      },
      {
        to: "/app/admin/help/feedback",
        label: "Help Feedback",
        icon: ThumbsUp,
        internalOnly: true,
        launch: true,
      },
      {
        to: "/app/admin/help/tickets",
        label: "Help Tickets",
        icon: Inbox,
        internalOnly: true,
        launch: true,
      },
      {
        to: "/app/admin/email-templates",
        label: "Email Templates",
        icon: Mail,
        internalOnly: true,
        launch: true,
      },
    ],
  },
];

/**
 * The one sidebar-visibility rule, shared by the shell and the launch test.
 * `showStubs` (from ?showStubs=1) reveals everything for internal testing;
 * otherwise only launch items that are not stubs are shown. internalOnly is
 * orthogonal: those items need the internal dogfood workspace regardless.
 */
export function isNavItemVisible(
  item: NavItem,
  opts: { showStubs: boolean; isInternal: boolean },
): boolean {
  if (item.internalOnly && !opts.isInternal) return false;
  if (opts.showStubs) return true;
  return Boolean(item.launch) && !item.stub;
}
