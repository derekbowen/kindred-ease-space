/**
 * One listing, as every template shows it: the listing's own photo, title,
 * place and price, linking to the listing on the customer's marketplace.
 *
 * The link is followed (rel="noopener", never nofollow): it points at the
 * customer's own marketplace, the destination these pages exist to send
 * visitors — and search engines — to. Price text is exactly what the server
 * formatted (formatMoney + perUnit); no price is drawn when it is unknown.
 */
import type { TemplateListing } from "./types";

/** Card image slots: one column on phones, two on small screens, then three / four. */
export const LISTING_IMAGE_SIZES = "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw";
const STRIP_IMAGE_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw";

export function ListingCard({
  listing,
  compact = false,
}: {
  listing: TemplateListing;
  /** Smaller type and image for the Resource Article's listing strip. */
  compact?: boolean;
}) {
  const img = listing.image;
  const width = img?.width ?? 640;
  const height = img?.height ?? 480;
  const inner = (
    <>
      <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
        {img ? (
          <img
            src={img.url}
            srcSet={img.width ? `${img.url} ${img.width}w` : undefined}
            sizes={compact ? STRIP_IMAGE_SIZES : LISTING_IMAGE_SIZES}
            alt={img.alt || listing.title}
            width={width}
            height={height}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-sm text-slate-400"
          >
            No photo yet
          </div>
        )}
      </div>
      <div className={compact ? "p-3" : "p-4"}>
        <h3
          className={`${compact ? "text-sm" : "text-base"} line-clamp-2 font-semibold leading-snug text-slate-900 group-hover:underline group-hover:decoration-[color:var(--tp-brand)] group-hover:underline-offset-4`}
        >
          {listing.title}
        </h3>
        {listing.location ? (
          <p className="mt-1 text-sm text-slate-600">{listing.location}</p>
        ) : null}
        {listing.price ? (
          <p className="mt-2 text-sm text-slate-900" data-price={listing.price.currency}>
            <span className="text-base font-semibold">{listing.price.text}</span>
            {listing.price.unitText ? (
              <span className="text-slate-600"> {listing.price.unitText}</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </>
  );
  const frame =
    "group block h-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-[color:var(--tp-brand)] hover:shadow-md";
  return (
    <li className="list-none" data-listing-id={listing.id}>
      {listing.url ? (
        <a
          href={listing.url}
          target="_blank"
          rel="noopener"
          className={`${frame} focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--tp-brand)] focus-visible:ring-offset-2`}
        >
          {inner}
        </a>
      ) : (
        <div className={frame}>{inner}</div>
      )}
    </li>
  );
}
