import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

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
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between text-sm">
          <Link to="/" className="font-semibold tracking-tight">founders.click</Link>
          <nav className="flex items-center gap-4 text-muted-foreground">
            <Link to="/terms" className="hover:text-foreground">Terms</Link>
            <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link to="/help" className="hover:text-foreground">Help</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Effective date: {effectiveDate}</p>
        <article className="prose prose-neutral dark:prose-invert mt-8 max-w-none prose-headings:scroll-mt-20 prose-headings:tracking-tight prose-h2:mt-10 prose-h2:text-2xl prose-h3:text-lg prose-a:text-orange-500 prose-a:no-underline hover:prose-a:underline">
          {children}
        </article>
        <footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} 10000 Solutions LLC. All rights reserved.
          {" · "}
          <Link to="/terms" className="hover:text-foreground">Terms</Link>
          {" · "}
          <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
        </footer>
      </main>
    </div>
  );
}
