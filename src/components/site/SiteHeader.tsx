import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

/** The mobile panel's id — what the menu button's aria-controls names. */
export const SITE_MOBILE_MENU_ID = "site-mobile-menu";

/**
 * Public header for the marketing, beta, legal and help pages.
 *
 * Below `md` the Help link, and below `sm` the language switcher and Sign in,
 * are hidden from the bar itself, so phones get a menu button (a disclosure,
 * not a modal: the panel opens in the page flow and keeps the page's theme).
 * The button reports aria-expanded and names the panel with aria-controls;
 * opening moves focus to the first link, Escape closes and returns focus to
 * the button, and following a link or tapping outside closes it.
 */
export function SiteHeader() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // A new page closes the menu.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-6">
        <Link to="/" className="shrink-0 text-base font-bold tracking-tight">
          founders<span className="text-brand">.click</span>
        </Link>
        <nav className="hidden md:flex items-center gap-5 text-sm text-muted-foreground">
          <Link to="/help" className="hover:text-foreground">
            {t("nav.help")}
          </Link>
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          <LanguageSwitcher className="hidden sm:inline-flex" />
          <Link
            to="/login"
            className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            {t("nav.signin")}
          </Link>
          {/* Shrinks (with an ellipsis) before it can cover the menu button:
              some locales' trial label does not fit a 320px bar. */}
          <Button asChild size="sm" className="min-w-0">
            <Link to="/signup">
              <span className="truncate">{t("nav.trial")}</span>
            </Link>
          </Button>
          <button
            ref={buttonRef}
            type="button"
            className="md:hidden inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            aria-controls={SITE_MOBILE_MENU_ID}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </div>
      <div
        id={SITE_MOBILE_MENU_ID}
        ref={panelRef}
        hidden={!open}
        className="md:hidden border-t border-border bg-background"
      >
        <nav aria-label="Menu" className="max-w-6xl mx-auto px-4 py-3 flex flex-col text-sm">
          <Link
            to="/help"
            onClick={close}
            className="py-2.5 text-muted-foreground hover:text-foreground"
          >
            {t("nav.help")}
          </Link>
          <Link
            to="/login"
            onClick={close}
            className="py-2.5 font-medium text-foreground hover:text-brand"
          >
            {t("nav.signin")}
          </Link>
          <div className="py-2.5">
            <LanguageSwitcher />
          </div>
        </nav>
      </div>
    </header>
  );
}
