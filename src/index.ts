import type { Env } from "./types";
import { createLoader } from "./upstream";
import { parsePolicy } from "./policy";
import { mergeSubscription } from "./merge";
import { parseConfig, stringifyConfig } from "./yaml";

const HEALTHZ_BODY = JSON.stringify({ status: "ok" });

/**
 * used when the runtime has no Cache API, which happens under the offline test
 * runner. The loader treats a cache miss and a failed cache call the same way,
 * so the chain still ends at KV.
 */
const NO_CACHE = {
  match: async (): Promise<undefined> => undefined,
  put: async (): Promise<void> => undefined,
  delete: async (): Promise<boolean> => false,
} as unknown as Cache;

function requestCache(): Cache {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (!storage || !storage.default) return NO_CACHE;
  return storage.default;
}

function textResponse(status: number, body: string, extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}

/** Header lookup that does not depend on the case a runtime reports. */
function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** Leading slash, no trailing slashes. Undefined when there is nothing to match. */
function normalizePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return absolute.replace(/\/+$/, "") || "/";
}

function isAuthorized(pathname: string, configured: string | undefined): boolean {
  const wanted = normalizePath(configured);
  if (!wanted) return false;
  return normalizePath(pathname) === wanted;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return textResponse(405, "method not allowed", { allow: "GET" });
    }

    const { pathname } = new URL(request.url);

    if (normalizePath(pathname) === "/healthz") {
      return new Response(HEALTHZ_BODY, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (!isAuthorized(pathname, env.PROXY_SUB_PATH)) {
      return textResponse(404, "not found");
    }

    const loader = createLoader(env, requestCache());
    const [profileSettled, upstreamSettled] = await Promise.allSettled([
      loader.load("profile", env.PROFILE_URL),
      loader.load("upstream", env.UPSTREAM_URL),
    ] as const);

    if (profileSettled.status !== "fulfilled" || upstreamSettled.status !== "fulfilled") {
      const failed: string[] = [];
      if (profileSettled.status !== "fulfilled") failed.push("profile");
      if (upstreamSettled.status !== "fulfilled") failed.push("upstream");
      return textResponse(502, `failed to load ${failed.join(", ")}`);
    }

    try {
      const policy = parsePolicy(env.GROUPS_JSON);
      const merged = mergeSubscription(
        parseConfig(profileSettled.value.text),
        parseConfig(upstreamSettled.value.text),
        policy,
      );

      const headers = new Headers({
        "content-type": "text/yaml; charset=utf-8",
        "cache-control": "no-store",
      });

      const userInfo = findHeader(upstreamSettled.value.headers, "subscription-userinfo");
      if (userInfo !== undefined) headers.set("subscription-userinfo", userInfo);

      return new Response(stringifyConfig(merged), { status: 200, headers });
    } catch (error) {
      return textResponse(500, errorMessage(error));
    }
  },
};
