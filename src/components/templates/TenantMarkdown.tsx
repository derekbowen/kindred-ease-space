/**
 * Markdown for customers' pages.
 *
 * The help centre's MarkdownRenderer is not usable here: its `prose` classes
 * need @tailwindcss/typography, which is not installed (under Tailwind's reset
 * every heading, list and link came out as plain body text), and its links
 * are hard-coded platform orange. This renderer styles each element itself,
 * colours links with the page's brand accent, and keeps the page to one <h1>:
 * a leading "# Title" repeating the page heading is dropped and any other
 * level-1 heading renders as an <h2>.
 *
 * Raw HTML in the markdown is never rendered (react-markdown escapes it) and
 * unsafe link protocols are removed by react-markdown's default URL filter.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { stripLeadingH1 } from "./format";

const H2 = "mt-10 mb-3 scroll-mt-20 text-2xl font-bold tracking-tight text-slate-900";
const H3 = "mt-8 mb-2 scroll-mt-20 text-xl font-semibold tracking-tight text-slate-900";
const H4 = "mt-6 mb-2 scroll-mt-20 text-lg font-semibold text-slate-900";

const COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h2 className={H2} {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className={H2} {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className={H3} {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className={H4} {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className={H4} {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className={H4} {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-5" {...props} />,
  // An absolute link opens beside the page, like every marketplace link here
  // (followed, never nofollow); a relative one (another /a/ page) stays put.
  a: ({ node: _node, ...props }) => (
    <a
      className="font-medium text-[color:var(--tp-accent)] underline decoration-1 underline-offset-4 hover:decoration-2"
      {...(typeof props.href === "string" && /^https?:\/\//i.test(props.href)
        ? { target: "_blank", rel: "noopener" }
        : {})}
      {...props}
    />
  ),
  ul: ({ node: _node, ...props }) => <ul className="my-5 list-disc space-y-2 pl-6" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-5 list-decimal space-y-2 pl-6" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="my-6 border-l-4 border-[color:var(--tp-brand)] bg-slate-50 py-2 pl-4 pr-3 text-slate-700"
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-10 border-slate-200" {...props} />,
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-slate-900" {...props} />
  ),
  img: ({ node: _node, alt, ...props }) => (
    <img
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      className="my-6 h-auto max-w-full rounded-xl"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-left text-base" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border-b-2 border-slate-200 px-3 py-2 font-semibold text-slate-900" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-slate-200 px-3 py-2 align-top" {...props} />
  ),
  code: ({ node: _node, ...props }) => (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.9em]" {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre className="my-6 overflow-x-auto rounded-lg bg-slate-100 p-4 text-sm" {...props} />
  ),
};

export function TenantMarkdown({ markdown }: { markdown: string }) {
  const content = stripLeadingH1(markdown);
  if (!content.trim()) return null;
  return (
    <div className="break-words text-[17px] leading-8 text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
