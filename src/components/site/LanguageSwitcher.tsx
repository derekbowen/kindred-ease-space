import { Globe } from "lucide-react";
import { LOCALES, LOCALE_LABELS, useT, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useT();
  return (
    <label className={`inline-flex items-center gap-1.5 text-sm text-muted-foreground ${className}`}>
      <Globe className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t("lang.label")}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="bg-transparent border-none focus:outline-none focus:ring-0 text-sm cursor-pointer hover:text-foreground"
        aria-label={t("lang.label")}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} className="bg-background text-foreground">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
