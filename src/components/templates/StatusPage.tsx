/**
 * A 404 or error screen on a customer's domain: white-labelled (no platform
 * name, no platform colours) and usable without JavaScript — "Try again" is
 * an ordinary link that reloads the page.
 */
export function TenantStatusPage({
  heading,
  message,
  retryHref,
}: {
  heading: string;
  message: string;
  retryHref?: string | null;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
        <p className="mt-2 text-slate-600">{message}</p>
        {retryHref ? (
          <p className="mt-5">
            <a
              href={retryHref}
              className="font-semibold text-slate-900 underline underline-offset-4"
            >
              Try again
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}

export const TENANT_NOT_FOUND = {
  heading: "Page not found",
  message: "This page doesn't exist or is no longer available.",
} as const;
