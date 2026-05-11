import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Lightweight i18n for the marketing/help shell.
 * Locales mirror Sharetribe's primary operating regions:
 *   en — global default (US, UK, AU, CA)
 *   es — Spain + LatAm
 *   fr — France, Belgium, Canada
 *   de — DACH
 *   fi — Finland (Sharetribe HQ)
 *   sv — Sweden
 */
export const LOCALES = ["en", "es", "fr", "de", "fi", "sv"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  fi: "Suomi",
  sv: "Svenska",
};

type Dict = Record<string, string>;

const DICTIONARIES: Record<Locale, Dict> = {
  en: {
    "nav.signin": "Sign in",
    "nav.trial": "Start free trial",
    "nav.help": "Help",
    "nav.pricing": "Pricing",
    "nav.features": "Features",
    "footer.tagline": "The growth engine for Sharetribe marketplaces.",
    "footer.product": "Product",
    "footer.company": "Company",
    "footer.legal": "Legal",
    "footer.regions": "Built for marketplaces in",
    "footer.terms": "Terms",
    "footer.privacy": "Privacy",
    "footer.contact": "Contact",
    "footer.status": "Status",
    "footer.rights": "All rights reserved.",
    "lang.label": "Language",
  },
  es: {
    "nav.signin": "Iniciar sesión",
    "nav.trial": "Prueba gratuita",
    "nav.help": "Ayuda",
    "nav.pricing": "Precios",
    "nav.features": "Funciones",
    "footer.tagline": "El motor de crecimiento para marketplaces de Sharetribe.",
    "footer.product": "Producto",
    "footer.company": "Empresa",
    "footer.legal": "Legal",
    "footer.regions": "Diseñado para marketplaces en",
    "footer.terms": "Términos",
    "footer.privacy": "Privacidad",
    "footer.contact": "Contacto",
    "footer.status": "Estado",
    "footer.rights": "Todos los derechos reservados.",
    "lang.label": "Idioma",
  },
  fr: {
    "nav.signin": "Connexion",
    "nav.trial": "Essai gratuit",
    "nav.help": "Aide",
    "nav.pricing": "Tarifs",
    "nav.features": "Fonctionnalités",
    "footer.tagline": "Le moteur de croissance des marketplaces Sharetribe.",
    "footer.product": "Produit",
    "footer.company": "Société",
    "footer.legal": "Mentions légales",
    "footer.regions": "Conçu pour les marketplaces en",
    "footer.terms": "Conditions",
    "footer.privacy": "Confidentialité",
    "footer.contact": "Contact",
    "footer.status": "Statut",
    "footer.rights": "Tous droits réservés.",
    "lang.label": "Langue",
  },
  de: {
    "nav.signin": "Anmelden",
    "nav.trial": "Kostenlos testen",
    "nav.help": "Hilfe",
    "nav.pricing": "Preise",
    "nav.features": "Funktionen",
    "footer.tagline": "Die Wachstumsplattform für Sharetribe-Marktplätze.",
    "footer.product": "Produkt",
    "footer.company": "Unternehmen",
    "footer.legal": "Rechtliches",
    "footer.regions": "Entwickelt für Marktplätze in",
    "footer.terms": "AGB",
    "footer.privacy": "Datenschutz",
    "footer.contact": "Kontakt",
    "footer.status": "Status",
    "footer.rights": "Alle Rechte vorbehalten.",
    "lang.label": "Sprache",
  },
  fi: {
    "nav.signin": "Kirjaudu",
    "nav.trial": "Aloita ilmainen kokeilu",
    "nav.help": "Ohjeet",
    "nav.pricing": "Hinnoittelu",
    "nav.features": "Ominaisuudet",
    "footer.tagline": "Kasvumoottori Sharetribe-marketplaceille.",
    "footer.product": "Tuote",
    "footer.company": "Yritys",
    "footer.legal": "Juridinen",
    "footer.regions": "Suunniteltu marketplaceille",
    "footer.terms": "Ehdot",
    "footer.privacy": "Tietosuoja",
    "footer.contact": "Yhteystiedot",
    "footer.status": "Tila",
    "footer.rights": "Kaikki oikeudet pidätetään.",
    "lang.label": "Kieli",
  },
  sv: {
    "nav.signin": "Logga in",
    "nav.trial": "Starta gratis prov",
    "nav.help": "Hjälp",
    "nav.pricing": "Priser",
    "nav.features": "Funktioner",
    "footer.tagline": "Tillväxtmotorn för Sharetribe-marknadsplatser.",
    "footer.product": "Produkt",
    "footer.company": "Företag",
    "footer.legal": "Juridik",
    "footer.regions": "Byggd för marknadsplatser i",
    "footer.terms": "Villkor",
    "footer.privacy": "Integritet",
    "footer.contact": "Kontakt",
    "footer.status": "Status",
    "footer.rights": "Alla rättigheter förbehållna.",
    "lang.label": "Språk",
  },
};

const STORAGE_KEY = "fc.locale";

const I18nContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}>({ locale: "en", setLocale: () => {}, t: (k) => k });

function detectInitial(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage?.getItem(STORAGE_KEY) as Locale | null;
  if (stored && LOCALES.includes(stored)) return stored;
  const nav = window.navigator?.language?.slice(0, 2) as Locale | undefined;
  if (nav && LOCALES.includes(nav)) return nav;
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectInitial());
  }, []);

  const value = useMemo(
    () => ({
      locale,
      setLocale: (l: Locale) => {
        setLocaleState(l);
        if (typeof window !== "undefined") {
          window.localStorage?.setItem(STORAGE_KEY, l);
          document.documentElement.lang = l;
        }
      },
      t: (key: string) => DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key,
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext);
}
