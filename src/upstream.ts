import type { Env, LoadResult } from "./types";

/** The two remote sources this Worker reads. */
type SourceName = "profile" | "upstream";

export interface Loader {
  load(name: "profile" | "upstream", url: string): Promise<LoadResult>;
}

const NETWORK_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_SECONDS = 300;

/**
 * Several subscription panels reject a request with no User-Agent, so every
 * upstream fetch sends one. Overridable through UPSTREAM_UA for a panel that
 * pins a different client.
 */
const DEFAULT_UPSTREAM_UA = "mihomo/1.19.0";

function cacheTtlSeconds(env: Env): number {
  const raw = env.CACHE_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.floor(parsed);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * Store a copy of the fetched text under the full URL, with a cache-control
 * header that carries this Worker's TTL. The upstream's own cache-control is
 * dropped so that a `no-store` or a short `max-age` cannot silently disable or
 * shorten the cache. `age` and `date` are dropped because they describe the
 * origin's copy and would fight the freshness window we ask for here.
 *
 * A cache write failure must never fail the load. The text is already in hand.
 */
async function writeCache(
  cache: Cache,
  url: string,
  text: string,
  headers: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  try {
    const stored: Record<string, string> = { "cache-control": `max-age=${ttlSeconds}` };
    for (const [key, value] of Object.entries(headers)) {
      const lowered = key.toLowerCase();
      if (lowered === "cache-control" || lowered === "age" || lowered === "date") continue;
      stored[key] = value;
    }
    await cache.put(url, new Response(text, { status: 200, headers: stored }));
  } catch {
    // Ignored on purpose. See above.
  }
}

async function readCache(cache: Cache, url: string): Promise<LoadResult | null> {
  try {
    const hit = await cache.match(url);
    if (!hit || !hit.ok) return null;
    const text = await hit.text();
    return { text, source: "cache", headers: headersToRecord(hit.headers) };
  } catch {
    return null;
  }
}

async function readNetwork(env: Env, cache: Cache, url: string): Promise<LoadResult | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": env.UPSTREAM_UA || DEFAULT_UPSTREAM_UA },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const headers = headersToRecord(response.headers);
    await writeCache(cache, url, text, headers, cacheTtlSeconds(env));
    return { text, source: "network", headers };
  } catch {
    return null;
  }
}

async function readKv(env: Env, name: SourceName): Promise<LoadResult | null> {
  try {
    const text = await env.PROXY_SUB_KV?.get(name);
    if (text === null || text === undefined) return null;
    // The KV fallback carries no response headers.
    return { text, source: "kv" };
  } catch {
    return null;
  }
}

/**
 * Build the cache -> network -> KV loader for one request.
 *
 * The error thrown when every step fails names the source and nothing else. No
 * URL, no status detail and no body text reaches the caller or a log line.
 */
export function createLoader(env: Env, cache: Cache): Loader {
  return {
    async load(name: SourceName, url: string): Promise<LoadResult> {
      if (url) {
        const cached = await readCache(cache, url);
        if (cached !== null) return cached;

        const fetched = await readNetwork(env, cache, url);
        if (fetched !== null) return fetched;
      }

      const stored = await readKv(env, name);
      if (stored !== null) return stored;

      throw new Error(`failed to load ${name} from cache, network, or KV`);
    },
  };
}
