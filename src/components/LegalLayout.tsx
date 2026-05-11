import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

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
        <article className="prose prose-neutral dark:prose-invert mt-8 max-w-none prose-headings:scroll-mt-20 prose-headings:tracking-tight prose-h2:mt-10 prose-h2:text-2xl prose-h3:text-lg prose-a:text-brand prose-a:no-underline hover:prose-a:underline">
          {children}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
