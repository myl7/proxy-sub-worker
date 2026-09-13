/**
 * Shared types. Frozen by DESIGN.md; the three workstreams implement against
 * these names, so do not rename or reshape them.
 */

export interface ClashProxy {
  name: string;
  [key: string]: unknown;
}

export interface ClashGroup {
  name: string;
  type: string;
  proxies: string[];
  [key: string]: unknown;
}

export interface ClashConfig {
  proxies?: ClashProxy[];
  "proxy-groups"?: ClashGroup[];
  rules?: string[];
  [key: string]: unknown;
}

export type BuiltinName = "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE";

export type MemberSpec =
  | { kind: "builtin"; name: BuiltinName }
  | { kind: "group"; name: string }
  // include/exclude are JS regex sources, OR-ed.
  | { kind: "nodes"; include?: string[]; exclude?: string[] };

export interface GroupSpec {
  name: string;
  type: "select";
  members: MemberSpec[];
}

export interface GroupPolicy {
  groups: GroupSpec[];
}

export interface LoadResult {
  text: string;
  source: "cache" | "network" | "kv";
  headers?: Record<string, string>; // response headers, absent for the KV fallback
}

export interface Env {
  PROXY_SUB_PATH: string; // secret, the exact request path this Worker serves
  PROFILE_URL: string; // secret
  UPSTREAM_URL: string; // secret
  GROUPS_JSON?: string; // optional var
  UPSTREAM_UA?: string; // optional var, User-Agent sent to the upstream panel
  CACHE_TTL_SECONDS?: string;
  PROXY_SUB_KV: KVNamespace; // binding
}
