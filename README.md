# proxy-sub-worker

A Cloudflare Worker that serves one Clash subscription built from two sources:

- the profile from a self-hosted subscription, which carries the settings,
  `dns`, `geox-url`, `rule-providers` and `rules`
- a third-party provider's node list

The Worker keeps the profile, drops its `proxies`, swaps in the provider's
`proxies` in the provider's own order, and regenerates `proxy-groups` from a
policy. Rules pass through untouched. `DESIGN.md` is the frozen contract for the
module layout and the semantics.

This repo does not deploy anything. You deploy it.

## Route shape

| request | response |
| --- | --- |
| `GET <PROXY_SUB_PATH>` | 200 `text/yaml`, the merged subscription |
| `GET /healthz` | 200 `{"status":"ok"}`, no source is loaded |
| any other method | 405 |
| any other path | 404 `not found` |

The path is compared as a whole, after ensuring a leading slash and dropping
trailing slashes on both sides. So `/example/path` and `/example/path/` are
the same request, and `/example` is not. There is no per-segment match and no
wildcard.

Authorized requests load both sources, parse, merge and stringify. Failures map
like this:

- 502 `text/plain`, naming the source that could not be loaded at all
- 500 `text/plain`, with the parse, policy or merge error message

If the upstream response carried a `subscription-userinfo` header, the merged
response carries it too. The KV fallback has no headers, so nothing is passed
through on that path.

## Requirements

- Node 20 or newer, because the code uses `fetch`, `AbortSignal.timeout` and
  `node:` prefixed imports
- `curl` on `PATH` for the seed script's upstream fallback
- a Cloudflare account with Workers and KV for the deploy steps

## Install

```sh
npm install
```

## Configuration

```sh
cp .dev.vars.example .dev.vars
```

`.dev.vars` holds `PROXY_SUB_PATH`, `PROFILE_URL`, `UPSTREAM_URL`, an optional
`GROUPS_JSON`, an optional `UPSTREAM_UA` and an optional `CACHE_TTL_SECONDS`. It
is gitignored. Both URLs carry their own credentials, so treat the whole file as
a secret.

`wrangler.jsonc` follows the same pattern, because it carries the KV namespace
id of your account:

```sh
cp wrangler.jsonc.example wrangler.jsonc
```

## Local development

The fixture server stands in for both sources on loopback, so `wrangler dev` can
be exercised end to end without touching the network.

```sh
node tests/fixtures/source-server.mjs 8788 8789
```

It prints the URLs it serves. Both ports serve `/profile.yaml` and
`/upstream.yaml`, so one process can play either source, and pointing a URL at a
port nothing is listening on exercises the failure path. The `/upstream.yaml`
response carries a synthetic `subscription-userinfo` header of zeros, so the
pass-through can be observed locally.

Point `.dev.vars` at it:

```
PROXY_SUB_PATH=/dev-token
PROFILE_URL=http://127.0.0.1:8788/profile.yaml
UPSTREAM_URL=http://127.0.0.1:8789/upstream.yaml
```

Then, in a second terminal:

```sh
npm run dev
curl -sS http://127.0.0.1:8787/dev-token
```

`wrangler dev` binds port 8787 by default, which is why the fixture server is
given two other ports.

The local KV namespace starts empty, so the KV fallback misses under
`wrangler dev` unless you seed it yourself:

```sh
npx wrangler kv key put profile --binding PROXY_SUB_KV --local --path <file>
```

Without `--local`, the same command writes to the deployed namespace. The
`npm run seed` script always writes remotely.

## Tests

```sh
npm test
```

The suite runs offline against synthetic fixtures that contain no real proxy
credentials and no real rules.

`npm run smoke` is the only test that touches the network. It pulls the two real
URLs from `.dev.vars`, runs the merge, writes `/tmp/proxy-sub-merged.yaml`, and
prints structural counts only: node count, group sizes, rule count, bytes.

## Seed the KV fallback

The KV fallback is what serves the subscription today, because the provider's
certificate is broken. See the certificate section below.

```sh
npx wrangler kv namespace create PROXY_SUB_KV
# paste the printed id into the kv_namespaces entry of wrangler.jsonc
npm run seed
```

`npm run seed` reads `.dev.vars`, fetches both sources, and uploads them with
`wrangler kv key put --remote`. It prints byte counts only. Source text never
reaches the terminal, and the temporary files are deleted before it exits. The
profile is fetched with `fetch`. The upstream is fetched with `fetch` first and
falls back to `curl -k`, which is the way through the broken certificate chain.

Re-run it whenever the provider changes its node list, and after you change
either URL. The Worker never writes KV, so the write path stays under your
control.

## Deploy (your steps)

```sh
cp wrangler.jsonc.example wrangler.jsonc
npx wrangler kv namespace create PROXY_SUB_KV
# paste the printed id into the kv_namespaces entry of wrangler.jsonc
npm run push-secrets
npx wrangler deploy
```

`wrangler.jsonc` is gitignored, so keep your local copy: a fresh clone starts
from the example and needs the id pasted in again.

`npm run push-secrets` is `wrangler secret bulk .dev.vars`. It uploads every
active key of `.dev.vars` in one request, so the values you tested locally are
the values that go live. It skips comment and blank lines. Check that the file
holds your real URLs and not the fixture ones from the local development section
before you run it.

To change one secret later, `npx wrangler secret put PROXY_SUB_PATH` prompts for
that single value and leaves the others alone. `GROUPS_JSON` and
`CACHE_TTL_SECONDS` are plain vars: leaving them active in `.dev.vars` uploads
them as secrets, which behaves the same, or put them in the `vars` block of
`wrangler.jsonc` if you would rather see them in the repo.

If wrangler says the Worker does not exist yet, run `npx wrangler deploy` once,
push the secrets, and deploy again.

Then point the Clash client at `https://<worker-host><PROXY_SUB_PATH>`. The value
carries its own leading slash.

## Group policy

`GROUPS_JSON` replaces the built-in policy. It is a `GroupPolicy` object:

```json
{
  "groups": [
    {
      "name": "default",
      "type": "select",
      "members": [
        { "kind": "builtin", "name": "DIRECT" },
        { "kind": "group", "name": "proxy" }
      ]
    },
    {
      "name": "proxy",
      "type": "select",
      "members": [{ "kind": "nodes", "include": ["^HK", "^SG"] }, { "kind": "builtin", "name": "DIRECT" }]
    }
  ]
}
```

There are three member kinds:

- `{"kind":"builtin","name":"DIRECT"}`. The accepted names are `DIRECT`,
  `REJECT`, `REJECT-DROP`, `PASS` and `COMPATIBLE`.
- `{"kind":"group","name":"proxy"}` refers to another group in the same policy.
  The referenced group must exist.
- `{"kind":"nodes","include":["^HK"],"exclude":["01$"]}` expands to upstream
  node names. `include` and `exclude` are regular expression sources tested
  against the proxy name, entries in `include` are OR-ed, and a missing
  `include` matches every node.

The default policy reproduces the group structure of the ansible template, with
all upstream nodes standing in for the template's `proxy_hostnames`:

| group | members in order |
| --- | --- |
| `default` | `DIRECT`, group `proxy` |
| `proxy` | all nodes, `DIRECT` |
| `cn` | `DIRECT`, all nodes |
| `ai` | all nodes, `DIRECT` |

Keep those four names, and keep the profile's rules routing to them. Rules pass
through untouched, so a group you rename here has to be renamed in the profile
too. Every rule whose type carries a target (`DOMAIN-SUFFIX`, `GEOSITE`,
`RULE-SET`, `MATCH` and the rest) must name a builtin policy, one of the
generated groups, or an upstream node; a target that resolves to none of those
fails the request with 500 instead of serving a config the client cannot load.
Malformed JSON, an unknown member kind, and a member that resolves to nothing
fail the same way.

## The upstream certificate blocker

The provider serves a single leaf certificate and no intermediate, and that
certificate expired 2026-09-12 23:59:59 GMT. Workers subrequests to a hostname
outside your own zone are always made in Full (strict) mode, and the runtime has
no switch that skips certificate verification. The direct fetch therefore fails
until the provider renews its certificate.

Each source is loaded through the same fallback chain, independently:

1. the Cloudflare cache, keyed by the full URL, with a TTL of
   `CACHE_TTL_SECONDS` (default 300)
2. a network `fetch` with an 8 second timeout, sending `UPSTREAM_UA` as the
   `User-Agent` (default `mihomo/1.19.0`, because panels reject a request with
   no User-Agent)
3. the `PROXY_SUB_KV` binding, key `profile` or `upstream`, raw text, no headers

The network is still tried first, so nothing needs to change when the provider
fixes its certificate. Until then, `npm run seed` is how new node lists reach the
Worker.

## The path is the credential

The subscription path is a bearer secret that travels in the URL. Anyone who
sees the URL can fetch the subscription, and a path is recorded in places a
header would not be:

- Cloudflare's request logs and analytics for the Worker
- the Clash client's own logs and its config backup
- shell history, if you test with `curl`
- any proxy or middlebox that logs full URLs

What the Worker does about it. Any other path gets a 404 with a fixed body, so
the endpoint confirms nothing about the path shape. The merged response is sent
with `cache-control: no-store`, so neither the edge nor the client keeps a copy
that outlives a rotation. Comparison is plain string equality on the whole
normalized path.

What you should do. Use a long random path, keep it out of screenshots and
issues, and rotate it with `npx wrangler secret put PROXY_SUB_PATH` if it leaks.
One path covers every client, so a rotation means updating every client URL.

## What never happens

- No response body, URL or proxy credential reaches a log line.
- Rules are opaque. They pass through byte for byte, comments included.
- The Worker never writes KV. Only `npm run seed` does, and only when you run it.
