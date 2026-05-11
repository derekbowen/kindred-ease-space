import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Public Intercom workspace ID — safe to ship to the browser. */
const INTERCOM_APP_ID = "nuuc4281";

/** Returns the public Intercom workspace ID. Safe to call unauthenticated. */
export const getIntercomAppId = createServerFn({ method: "GET" }).handler(async () => {
  return { appId: INTERCOM_APP_ID };
});

/** Base64url encode a Uint8Array or string. */
function b64url(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign an HS256 JWT using Web Crypto (Worker-compatible — no Node deps). */
async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const data = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return `${data}.${b64url(sig)}`;
}

/**
 * Mints a short-lived Intercom Identity Verification JWT for the signed-in user.
 * HS256 signed with INTERCOM_IDENTITY_SECRET (Intercom → Settings → Authentication
 * → Identity Verification → Web). Returns null if IV is not configured.
 */
export const getIntercomUserJwt = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const secret = process.env.INTERCOM_IDENTITY_SECRET;
    if (!secret) return { token: null as string | null };

    const { userId, claims } = context as {
      userId: string;
      claims: { email?: string } & Record<string, unknown>;
    };

    const now = Math.floor(Date.now() / 1000);
    const token = await signHs256(
      {
        user_id: userId,
        ...(claims.email ? { email: claims.email } : {}),
        iat: now,
        exp: now + 60 * 60, // 1h
      },
      secret,
    );
    return { token };
  });
