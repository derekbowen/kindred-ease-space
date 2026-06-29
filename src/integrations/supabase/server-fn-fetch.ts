// Browser-only: attach the Supabase access token to all /_serverFn/* requests
// so server functions guarded by `requireSupabaseAuth` see a Bearer token.
import { supabase } from "./client";

let installed = false;

export function installServerFnAuthFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      if (url && url.includes("/_serverFn/")) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has("authorization")) {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (token) headers.set("authorization", `Bearer ${token}`);
        }
        return originalFetch(input, { ...init, headers });
      }
    } catch (err) {
      console.error("[server-fn-fetch] failed to attach auth header", err);
    }
    return originalFetch(input, init);
  };
}
