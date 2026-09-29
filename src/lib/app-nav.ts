import {
  LayoutDashboard,
  Plug,
  Lightbulb,
  FilePlus2,
  Files,
  Map as MapIcon,
  Settings,
  LifeBuoy,
  HandCoins,
  BookOpen,
  LayoutTemplate,
  ThumbsUp,
  Inbox,
  Mail,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * A platform-admin ops tool (every one is refused on the server by
   * assertAdmin as well). Shown only in the internal (platform-admin)
   * workspace — the workspace's `is_internal` flag, exactly as before.
   */
  internalOnly?: boolean;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean;
  /** Other path prefixes this item stands for (Settings also covers /app/billing). */
  also?: string[];
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/**
 * THE SIDEBAR IS THE MVP (owner, 2026-09-28).
 *
 * One journey: connect Sharetribe → sync listings → coverage opportunities →
 * template → draft → edit and preview → publish on the verified domain →
 * sitemap. The sidebar lists exactly the screens of that journey, plus
 * Settings and Help. Every other screen is DEFERRED: it has no entry here,
 * its route redirects to /app (src/lib/deferred-route.ts) and its server
 * functions refuse (src/lib/features.server.ts).
 *
 * There is nothing left to reveal. No stub or "not launched yet" item exists,
 * so no flag — ?showStubs=1, the founder / internal unlimited entitlement —
 * changes what a workspace sees. The one difference between workspaces is the
 * platform-admin ops section, shown only to the internal (platform-admin)
 * workspace, whose tools are server-gated by assertAdmin.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Your marketplace",
    items: [
      { to: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
      {
        to: "/app/settings/integrations/sharetribe",
        label: "Sharetribe & inventory",
        icon: Plug,
      },
    ],
  },
  {
    label: "SEO pages",
    items: [
      { to: "/app/opportunities", label: "Opportunities", icon: Lightbulb },
      { to: "/app/pages/new", label: "Page Builder", icon: FilePlus2 },
      { to: "/app/pages", label: "My Pages", icon: Files },
      { to: "/app/seo/sitemap", label: "Sitemap", icon: MapIcon },
    ],
  },
  {
    label: "Account",
    items: [
      // Workspace & branding, Domains and Billing — the Settings tab strip
      // (src/components/settings/settings-tabs.ts) links all of them.
      { to: "/app/settings", label: "Settings", icon: Settings, also: ["/app/billing"] },
      // The public contact form is the support path: it files a ticket and
      // notifies the support inbox.
      { to: "/help/contact", label: "Help & feedback", icon: LifeBuoy },
    ],
  },
  {
    // How we run the product: grant beta access, answer tickets, edit help
    // and email copy, audit founders.click's own canonical URLs.
    label: "Platform admin",
    items: [
      {
        to: "/app/ops/plan-requests",
        label: "Entitlements & Beta",
        icon: HandCoins,
        internalOnly: true,
      },
      {
        to: "/app/admin/help/articles",
        label: "Help Articles",
        icon: BookOpen,
        internalOnly: true,
      },
      {
        to: "/app/admin/help/categories",
        label: "Help Categories",
        icon: LayoutTemplate,
        internalOnly: true,
      },
      {
        to: "/app/admin/help/feedback",
        label: "Help Feedback",
        icon: ThumbsUp,
        internalOnly: true,
      },
      {
        to: "/app/admin/help/tickets",
        label: "Help Tickets",
        icon: Inbox,
        internalOnly: true,
      },
      {
        to: "/app/admin/email-templates",
        label: "Email Templates",
        icon: Mail,
        internalOnly: true,
      },
      {
        to: "/app/seo/canonical-audit",
        label: "Canonical Audit",
        icon: ShieldCheck,
        internalOnly: true,
      },
    ],
  },
];

/**
 * The sidebar for one workspace: every customer item, plus the platform-admin
 * ops section when the workspace is the internal (platform-admin) one. That
 * is the only input — nothing else (no URL parameter, no entitlement, no
 * billing state) can add an item.
 */
export function visibleNavSections(opts: { platformAdmin: boolean }): NavSection[] {
  const platformAdmin = opts.platformAdmin === true;
  return NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => !item.internalOnly || platformAdmin),
  })).filter((section) => section.items.length > 0);
}

function covers(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * The one item a path belongs to: the most specific (longest) match, so
 * /app/pages/new is Page Builder, not My Pages, and
 * /app/settings/integrations/sharetribe is Sharetribe & inventory, not
 * Settings. Undefined when no item covers the path.
 */
export function activeNavItem(pathname: string, items: NavItem[]): NavItem | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: NavItem | undefined;
  let bestLength = -1;
  for (const item of items) {
    const prefixes = [item.to, ...(item.also ?? [])];
    for (const prefix of prefixes) {
      const match = item.exact && prefix === item.to ? path === prefix : covers(prefix, path);
      if (match && prefix.length > bestLength) {
        best = item;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
