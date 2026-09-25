import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { ARTICLE_BODY_CLASS } from "@/components/help-article-content";

export function LegalLayout({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-12 flex-1 w-full">
        <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Effective date: {effectiveDate}</p>
        {/* The help center's typography: `prose` needs @tailwindcss/typography,
            which is not installed, so those classes styled nothing (round-4
            release review L2). */}
        <article className={`mt-8 ${ARTICLE_BODY_CLASS}`}>{children}</article>
      </main>
      <SiteFooter />
    </div>
  );
}
