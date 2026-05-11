import { Link } from "@tanstack/react-router";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

// Sharetribe operating regions — major countries where Sharetribe-powered marketplaces run.
const REGIONS = [
  "🇺🇸 United States",
  "🇬🇧 United Kingdom",
  "🇨🇦 Canada",
  "🇦🇺 Australia",
  "🇪🇸 Spain",
  "🇫🇷 France",
  "🇩🇪 Germany",
  "🇫🇮 Finland",
  "🇸🇪 Sweden",
  "🇳🇱 Netherlands",
  "🇲🇽 Mexico",
  "🇧🇷 Brazil",
];

export function SiteFooter() {
  const { t } = useT();
  return (
    <footer className="border-t border-border mt-24 bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12 grid gap-10 md:grid-cols-4">
        <div className="md:col-span-2">
          <Link to="/" className="text-base font-bold tracking-tight">
            founders<span className="text-brand">.click</span>
          </Link>
          <p className="mt-3 text-sm text-muted-foreground max-w-sm">{t("footer.tagline")}</p>
          <div className="mt-5">
            <LanguageSwitcher />
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {t("footer.product")}
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li><Link to="/" className="hover:text-foreground">{t("nav.features")}</Link></li>
            <li><Link to="/" className="hover:text-foreground">{t("nav.pricing")}</Link></li>
            <li><Link to="/help" className="hover:text-foreground">{t("nav.help")}</Link></li>
            <li>
              <a href="https://status.founders.click" target="_blank" rel="noreferrer" className="hover:text-foreground">
                {t("footer.status")}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {t("footer.legal")}
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li><Link to="/terms" className="hover:text-foreground">{t("footer.terms")}</Link></li>
            <li><Link to="/privacy" className="hover:text-foreground">{t("footer.privacy")}</Link></li>
            <li><Link to="/help/contact" className="hover:text-foreground">{t("footer.contact")}</Link></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
            {t("footer.regions")}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {REGIONS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-5 text-xs text-muted-foreground flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>© {new Date().getFullYear()} 10000 Solutions LLC. {t("footer.rights")}</div>
          <nav className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-foreground">{t("footer.terms")}</Link>
            <Link to="/privacy" className="hover:text-foreground">{t("footer.privacy")}</Link>
            <Link to="/help/contact" className="hover:text-foreground">{t("footer.contact")}</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
