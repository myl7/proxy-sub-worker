# proxy-sub-worker

A Cloudflare Worker that turns a third-party Clash subscription into one that
carries this user's standard profile: the provider's `proxies`, everything else
from a self-hosted subscription rendered by an ansible template.

Not deployed by us. The user deploys it themselves.

## Data flow

```
GET <PROXY_SUB_PATH>
  |
  +-- load profile   <- PROFILE_URL  (Cloudflare, valid cert)
  +-- load upstream  <- UPSTREAM_URL (third-party provider, expired cert, see below)
  |
  +-- mergeSubscription(profile, upstream, policy)
  |
  +-- text/yaml
```

Both sources are fetched with the fallback chain below, independently.

## Sources and fallback

For each of profile and upstream:

1. Cloudflare cache, key = full URL, TTL = `CACHE_TTL_SECONDS` (default 300).
2. Network `fetch` with a 8s timeout via `AbortSignal.timeout`, sending
   `user-agent: UPSTREAM_UA || "mihomo/1.19.0"` because panels reject a fetch
   with no User-Agent.
3. KV binding `PROXY_SUB_KV`, key `profile` / `upstream`, raw text.

If a source cannot be loaded at all, respond 502 with a short plain-text body
naming which source failed. Never include upstream URLs, proxy credentials, or
rule text in a response body or a log line.

The Worker never writes KV. KV is written only by `npm run seed`, run by the
user. This keeps the write path predictable and free.

## Upstream certificate blocker

The provider serves a single leaf certificate, no intermediate, and it
expired 2026-09-12 23:59:59 GMT. Workers subrequests to a hostname outside the
account's own zone are always made in Full (strict) mode, and the runtime has no
"I skip certificate verification" switch. So the direct fetch will fail with a
526-class error until the provider fixes its certificate.

The KV fallback is what makes this work today. Direct fetch keeps being tried
first; nothing needs to change when the provider renews.

## Module contracts

Frozen. Three workers implement against these signatures in parallel, so the
names and shapes must not drift.

### `src/types.ts`

```ts
export interface ClashProxy { name: string; [key: string]: unknown }

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
  | { kind: "nodes"; include?: string[]; exclude?: string[] };  // include/exclude are JS regex sources, OR-ed

export interface GroupSpec { name: string; type: "select"; members: MemberSpec[] }

export interface GroupPolicy { groups: GroupSpec[] }

export interface LoadResult {
  text: string;
  source: "cache" | "network" | "kv";
  headers?: Record<string, string>;  // response headers, absent for the KV fallback
}
```

### `src/policy.ts`

```ts
export const DEFAULT_POLICY: GroupPolicy;
export function parsePolicy(json: string | undefined): GroupPolicy; // undefined/empty -> DEFAULT_POLICY
```

`DEFAULT_POLICY` reproduces the group structure of the ansible clash template,
with "all upstream nodes" standing in for the template's `proxy_hostnames`:

| group     | members (in order)          |
| --------- | --------------------------- |
| `default` | `DIRECT`, group `proxy`     |
| `proxy`   | nodes(all), `DIRECT`        |
| `cn`      | `DIRECT`, nodes(all)        |
| `ai`      | nodes(all), `DIRECT`        |

Group names are load-bearing: the standard rules route to `default`, `proxy`,
`cn`, and `ai`. Do not rename them. A `nodes` member matches `include` (if
given) and does not match `exclude`, both as `new RegExp(source)`, tested
against the proxy `name`; a missing `include` means "all".

`parsePolicy` throws `PolicyError` on malformed JSON or unknown `kind`.

### `src/groups.ts`

```ts
export function buildGroups(proxyNames: string[], policy: GroupPolicy): ClashGroup[];
```

- Throws `MergeError` if a member resolves to zero names, if a `group` member
  names a group that is not in the policy, or if `proxyNames` is empty.
- Output group names keep the policy's order. Member order is the policy's
  member order; a `nodes` member expands to proxy names in `proxyNames` order.
- Duplicate member names inside one group are dropped, first occurrence wins.

### `src/merge.ts`

```ts
export function mergeSubscription(
  profile: ClashConfig,
  upstream: ClashConfig,
  policy: GroupPolicy,
): ClashConfig;
```

Semantics:

- Output = every key of `profile` except `proxies` and `proxy-groups`, copied
  deep (the inputs are never mutated), with:
  - `proxies` = `upstream.proxies`, byte-for-byte as parsed, in upstream order.
    Duplicate names are dropped, first occurrence wins.
  - `proxy-groups` = `buildGroups(...)`.
- Key order: keep `profile`'s own key order; `proxies` and `proxy-groups`
  replace `profile`'s own entries in place. If `profile` has no `proxies` key,
  insert both immediately before `rules` (after `rule-providers` if present).
- `rules` come from `profile` verbatim, comments and all. No reordering, no
  rewriting, no filtering.
- Validation, each throwing `MergeError` with a message that names the problem
  but never quotes a rule payload or a rule target:
  - `profile.rules` must be a non-empty array of strings.
  - `upstream.proxies` must be a non-empty array; every entry an object with a
    non-empty string `name`.
  - Every rule whose type is in the known-target set below must resolve its
    target to a builtin, a generated group name, or a proxy name.
- Unknown rule types are not validated (they may carry parenthesised logic).

Known-target rule types: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`,
`DOMAIN-REGEX`, `GEOSITE`, `GEOIP`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN`,
`SRC-IP-CIDR`, `SRC-PORT`, `DST-PORT`, `PROCESS-NAME`, `PROCESS-PATH`,
`RULE-SET`, `MATCH`.

Target position: field index 2 for every type above except `MATCH`, which uses
index 1. Strip a trailing ` # comment` before splitting. Blank lines do not
appear after YAML parsing and need no special handling.

### `src/yaml.ts`

```ts
export function parseConfig(text: string): ClashConfig;   // throws MergeError on YAML syntax errors / non-mapping root
export function stringifyConfig(config: ClashConfig): string;
```

Uses the `yaml` package. `stringifyConfig` must set `lineWidth: 0` so long rule
lines are not folded. Proxy names are CJK and must round-trip: parse of the
output must deep-equal the input.

### `src/upstream.ts`

```ts
export interface Loader {
  load(name: "profile" | "upstream", url: string): Promise<LoadResult>;
}
export function createLoader(env: Env, cache: Cache): Loader;
```

Implements the fallback chain and the timeout. It must not log or return
response bodies.

### `src/index.ts`

```ts
export default { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
```

- `GET /healthz` -> `200 {"status":"ok"}`, no upstream load.
- Any other method -> 405.
- Path: authorized when the normalized request path equals the normalized
  `env.PROXY_SUB_PATH`: a leading slash is ensured and trailing slashes are
  dropped on both sides. Anything else -> 404 with body `not found`.
- Authorized: load both sources, parse, merge, stringify.
- 200 headers: `content-type: text/yaml; charset=utf-8`, `cache-control: no-store`.
  If the upstream response carried `subscription-userinfo`, pass it through.
- Source failure -> 502 `text/plain` naming the failed source.
- Merge failure -> 500 `text/plain` with the error message.

### `Env`

```ts
export interface Env {
  PROXY_SUB_PATH: string;    // secret, the exact request path this Worker serves
  PROFILE_URL: string;       // secret
  UPSTREAM_URL: string;      // secret
  GROUPS_JSON?: string;      // optional var
  UPSTREAM_UA?: string;      // optional var, User-Agent on upstream fetches
  CACHE_TTL_SECONDS?: string;
  PROXY_SUB_KV: KVNamespace; // binding
}
```

## Local development

`.dev.vars` (gitignored, template in `.dev.vars.example`) holds `PROXY_SUB_PATH`,
`PROFILE_URL`, `UPSTREAM_URL`, `GROUPS_JSON`. `wrangler.jsonc` is gitignored for
the same reason, because it carries the KV namespace id, and has its own template
`wrangler.jsonc.example`.

`tests/fixtures/source-server.mjs` is a Node http server that serves
`tests/fixtures/profile.yaml` and `tests/fixtures/upstream.yaml` on loopback, so
`wrangler dev` can be exercised end-to-end without touching the network. It
takes two port arguments, serves both files on each, and prints the URLs it
serves. The two YAML files are owned by the test workstream.

## Scripts

- `npm run dev` — `wrangler dev`, local mode.
- `npm test` — `vitest run`, offline, synthetic fixtures only.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run seed` — `scripts/seed-kv.mjs`: reads `.dev.vars`, fetches both URLs
  (falling back to `curl -k` for the upstream), writes `profile` and `upstream`
  into the KV namespace via `wrangler kv key put`. Prints byte counts only.
- `npm run smoke` — `SMOKE=1 vitest run tests/smoke.real.test.ts`: pulls the two
  real URLs, runs the merge, writes `/tmp/proxy-sub-merged.yaml`, prints structural
  counts only (node count, group sizes, rule count, bytes). Skipped unless
  `SMOKE=1`.

## Tests

`tests/` runs offline with synthetic fixtures that deliberately contain no real
proxy credentials and no real rules:

- a profile fixture shaped like the ansible rendering (settings, `dns`,
  `geox-url`, `rule-providers`, rules routing to `default`/`proxy`/`cn`/`ai`);
- an upstream fixture with a handful of fake nodes, CJK names, a duplicate
  name, and an unrelated `proxy-groups`/`rules` section that must be ignored.

Cover: proxies preserved in order, profile keys preserved, group membership per
policy, include/exclude filtering, duplicate handling, every `MergeError` path,
YAML round-trip with CJK names, and key order in the serialized output.

## Hard rules

- The private rules overlay that feeds the profile is never opened from here.
  Rules are opaque data that flows through this Worker untouched.
- No real credentials, tokens, node details, or rule text in the repo, fixtures,
  test output, or logs.
- No `wrangler deploy`, no `wrangler kv namespace create` against the user's
  account. Those are the user's steps, documented in `README.md`.
