import { Link } from "@tanstack/react-router";
import { Search, BookOpen } from "lucide-react";
import { useState } from "react";
import { SearchModal } from "./SearchModal";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export function HelpHeader() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SiteHeader />
      <div className="border-b border-border bg-background/60">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center gap-4">
          <Link to="/help" className="flex items-center gap-2 text-sm font-medium">
            <BookOpen className="h-4 w-4 text-brand" />
            <span className="text-muted-foreground">Help Center</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto flex items-center gap-2 w-full max-w-sm rounded-md border border-input bg-background px-3 h-8 text-sm text-muted-foreground hover:border-ring transition-colors"
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
        </div>
      </div>
      <SearchModal open={open} onOpenChange={setOpen} />
    </>
  );
}

export function HelpFooter() {
  return <SiteFooter />;
}

