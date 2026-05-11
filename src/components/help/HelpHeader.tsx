import { Link } from "@tanstack/react-router";
import { Search, BookOpen } from "lucide-react";
import { useState } from "react";
import { SearchModal } from "./SearchModal";

export function HelpHeader() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">
          <Link to="/help" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <BookOpen className="h-4 w-4 text-orange-500" />
            <span>founders<span className="text-orange-500">.click</span></span>
            <span className="text-muted-foreground font-normal">/ Help</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto flex items-center gap-2 w-full max-w-sm rounded-md border border-input bg-background px-3 h-9 text-sm text-muted-foreground hover:border-ring transition-colors"
            aria-label="Search the help center"
          >
            <Search className="h-4 w-4" />
            <span>Search articles…</span>
            <kbd className="ml-auto hidden sm:inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono">
              ⌘K
            </kbd>
          </button>
          <Link
            to="/help/contact"
            className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            Contact
          </Link>
          <Link to="/" className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground">
            Back to site
          </Link>
        </div>
      </header>
      <SearchModal open={open} onOpenChange={setOpen} />
    </>
  );
}

export function HelpFooter() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-muted-foreground">
        <div>
          © {new Date().getFullYear()} founders.click — Help Center
        </div>
        <nav className="flex items-center gap-5">
          <Link to="/help" className="hover:text-foreground">All articles</Link>
          <Link to="/help/contact" className="hover:text-foreground">Contact support</Link>
          <a href="https://status.founders.click" target="_blank" rel="noreferrer" className="hover:text-foreground">Status</a>
          <Link to="/" className="hover:text-foreground">founders.click →</Link>
        </nav>
      </div>
    </footer>
  );
}
