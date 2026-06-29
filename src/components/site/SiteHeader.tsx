import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

export function SiteHeader() {
  const { t } = useT();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">
        <Link to="/" className="text-base font-bold tracking-tight">
          founders<span className="text-brand">.click</span>
        </Link>
        <nav className="hidden md:flex items-center gap-5 text-sm text-muted-foreground">
          <Link to="/help" className="hover:text-foreground">
            {t("nav.help")}
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <LanguageSwitcher className="hidden sm:inline-flex" />
          <Link
            to="/login"
            className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            {t("nav.signin")}
          </Link>
          <Button asChild size="sm">
            <Link to="/signup">{t("nav.trial")}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
