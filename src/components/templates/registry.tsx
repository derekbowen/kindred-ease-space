/**
 * THE TEMPLATE REGISTRY — page_templates.slug → the component that renders it.
 *
 * A page renders with the component registered for its template, or not at
 * all: an unknown, unsupported or inactive template is never drawn as some
 * other template (getPublicTenantPage answers 404 for it; TemplateRenderer
 * draws UnsupportedTemplate). A template is offered to customers only when it
 * is active AND isRenderableKind() (src/lib/templates/contracts.ts).
 *
 * Every component is pure (TemplatePageProps in, markup out — no fetching),
 * so the public route, the platform preview and the in-app editor preview
 * render the same thing from the same data.
 */
import type { ComponentType } from "react";
import { CategoryPage } from "./CategoryPage";
import { CityHub } from "./CityHub";
import { ResourceArticle } from "./ResourceArticle";
import type { TemplateKind, TemplatePageProps } from "./types";

export type {
  TemplateBranding,
  TemplateData,
  TemplateImage,
  TemplateKind,
  TemplateListing,
  TemplateMarketplace,
  TemplatePage,
  TemplatePageProps,
  TemplatePlace,
  TemplatePrice,
  TemplateRelatedPage,
  TemplateRelation,
} from "./types";

export const TEMPLATE_COMPONENTS: Readonly<Record<TemplateKind, ComponentType<TemplatePageProps>>> =
  Object.freeze({
    city_hub: CityHub,
    category_page: CategoryPage,
    resource_article: ResourceArticle,
  });

/** The template slugs that have a renderer, in a fixed order. */
export const RENDERABLE_KINDS: readonly TemplateKind[] = Object.freeze(
  Object.keys(TEMPLATE_COMPONENTS) as TemplateKind[],
);

/** Does this template slug have a registered renderer? (Exact, case-sensitive.) */
export function isRenderableKind(kind: unknown): kind is TemplateKind {
  return (
    typeof kind === "string" && Object.prototype.hasOwnProperty.call(TEMPLATE_COMPONENTS, kind)
  );
}

/** The component for a template slug, or null — never a stand-in. */
export function templateComponentFor(kind: unknown): ComponentType<TemplatePageProps> | null {
  return isRenderableKind(kind) ? TEMPLATE_COMPONENTS[kind] : null;
}

/** What renders in place of a template that has no renderer. */
export function UnsupportedTemplate({ kind }: { kind?: unknown }) {
  return (
    <div
      role="alert"
      data-template-error="unsupported"
      className="flex min-h-[50vh] items-center justify-center bg-white px-4 text-slate-900"
    >
      <div className="max-w-md text-center">
        <p className="text-lg font-semibold">This page can&apos;t be displayed.</p>
        <p className="mt-2 text-sm text-slate-600">
          {typeof kind === "string" && kind
            ? `The “${kind}” template isn't available.`
            : "Its template isn't available."}
        </p>
      </div>
    </div>
  );
}

/**
 * Render a page with its registered template. `kind` defaults to
 * props.page.kind; pass it explicitly when the slug comes from elsewhere
 * (an editor's template picker) — the page is then drawn as that template.
 */
export function TemplateRenderer(props: TemplatePageProps & { kind?: unknown }) {
  const { kind: requested, ...rest } = props;
  const kind = requested ?? rest.page?.kind;
  const Component = templateComponentFor(kind);
  if (!Component || !isRenderableKind(kind) || !rest.page)
    return <UnsupportedTemplate kind={kind} />;
  return (
    <Component {...rest} page={rest.page.kind === kind ? rest.page : { ...rest.page, kind }} />
  );
}
