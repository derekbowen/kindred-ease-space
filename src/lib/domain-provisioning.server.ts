/**
 * Cloudflare edge provisioning for connected customer domains.
 *
 * WHY THIS IS ATOMIC
 * ------------------
 * We deliberately do NOT use a `*/ /*` wildcard Worker route (Cloudflare's
 * recommended option) because it would put every request entering the
 * founders.click zone — the marketing site and the app included — through the
 * edge Worker. We use one route per customer hostname instead.
 *
 * The cost of that choice: the wildcard would have caught a customer whose
 * provisioning half-completed. Without it, a custom hostname that exists with
 * NO matching route falls through to the fallback origin, which is originless
 * (AAAA 100::) — that customer is hard down, not degraded.
 *
 * So hostname + route must succeed or fail as ONE unit. If the route call
 * fails we tear the hostname back down, leaving nothing half-built. Callers
 * must treat a throw as "not provisioned" and never mark the domain active.
 *
 * Route capacity: Cloudflare allows 1,000 Worker routes per zone (Free and
 * Paid alike), so per-hostname routing scales to 1,000 connected domains
 * before the wildcard is worth revisiting.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

export type CfProvisionResult = {
  hostnameId: string;
  routeId: string;
};

function cfEnv() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const workerName = process.env.CLOUDFLARE_EDGE_WORKER || "founders-edge";
  return { token, zoneId, workerName };
}

/** True when the edge can actually be provisioned. Callers should surface a
 * clear "not configured" state rather than silently pretending success. */
export function isEdgeProvisioningConfigured(): boolean {
  const { token, zoneId } = cfEnv();
  return Boolean(token && zoneId);
}

async function cf(path: string, init: RequestInit = {}): Promise<any> {
  const { token } = cfEnv();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN not configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${CF_API}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      const detail =
        (json?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join("; ") ||
        `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function createCustomHostname(hostname: string): Promise<string> {
  const { zoneId } = cfEnv();
  const result = await cf(`/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    body: JSON.stringify({
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
  return result.id as string;
}

async function deleteCustomHostname(id: string): Promise<void> {
  const { zoneId } = cfEnv();
  await cf(`/zones/${zoneId}/custom_hostnames/${id}`, { method: "DELETE" });
}

async function createWorkerRoute(hostname: string): Promise<string> {
  const { zoneId, workerName } = cfEnv();
  const result = await cf(`/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern: `${hostname}/*`, script: workerName }),
  });
  return result.id as string;
}

async function deleteWorkerRoute(id: string): Promise<void> {
  const { zoneId } = cfEnv();
  await cf(`/zones/${zoneId}/workers/routes/${id}`, { method: "DELETE" });
}

/**
 * Provision a customer hostname at the edge as a single unit.
 * Throws if either half fails; on route failure the hostname is rolled back so
 * we never leave a hostname resolving to the originless fallback with no route.
 */
export async function provisionDomainAtEdge(hostname: string): Promise<CfProvisionResult> {
  if (!isEdgeProvisioningConfigured()) {
    throw new Error("edge provisioning not configured (CLOUDFLARE_API_TOKEN/ZONE_ID)");
  }

  const hostnameId = await createCustomHostname(hostname);

  let routeId: string;
  try {
    routeId = await createWorkerRoute(hostname);
  } catch (routeErr) {
    // Roll back so the half-built state can't reach a customer. If the rollback
    // itself fails, say so loudly — that is the one case needing a human.
    try {
      await deleteCustomHostname(hostnameId);
      console.error(
        "[domains] route creation failed; custom hostname rolled back",
        hostname,
        String(routeErr),
      );
    } catch (rollbackErr) {
      console.error(
        "[domains] ORPHANED CUSTOM HOSTNAME — manual cleanup required",
        hostname,
        "hostnameId=",
        hostnameId,
        "routeError=",
        String(routeErr),
        "rollbackError=",
        String(rollbackErr),
      );
    }
    throw routeErr instanceof Error ? routeErr : new Error(String(routeErr));
  }

  return { hostnameId, routeId };
}

/** Best-effort teardown on disconnect. Never throws — a disconnect must
 * complete in our database even if Cloudflare is unreachable. */
export async function deprovisionDomainAtEdge(
  hostnameId: string | null,
  routeId: string | null,
): Promise<void> {
  if (!isEdgeProvisioningConfigured()) return;
  if (routeId) {
    try {
      await deleteWorkerRoute(routeId);
    } catch (e) {
      console.error("[domains] route teardown failed", routeId, String(e));
    }
  }
  if (hostnameId) {
    try {
      await deleteCustomHostname(hostnameId);
    } catch (e) {
      console.error("[domains] hostname teardown failed", hostnameId, String(e));
    }
  }
}
