import { MergeError } from "./errors";
import { buildGroups } from "./groups";
import { BUILTIN_NAMES } from "./policy";
import type { ClashConfig, ClashGroup, ClashProxy, GroupPolicy } from "./types";

/** Rule types whose target must resolve to something the merged config defines. */
const KNOWN_TARGET_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-REGEX",
  "GEOSITE",
  "GEOIP",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-ASN",
  "SRC-IP-CIDR",
  "SRC-PORT",
  "DST-PORT",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "RULE-SET",
  "MATCH",
]);

/** Field index that carries the target. MATCH has no payload field. */
const DEFAULT_TARGET_INDEX = 2;
const MATCH_TARGET_INDEX = 1;

/** Profile keys the merge replaces rather than copies. */
const REPLACED_KEYS = new Set(["proxies", "proxy-groups"]);

/**
 * Merge one profile with one upstream subscription.
 *
 * Output = every key of `profile` except `proxies` and `proxy-groups`, copied
 * deep, with `proxies` from upstream (duplicate names dropped, first wins) and
 * `proxy-groups` from the policy. Rules pass through verbatim. Neither input
 * is mutated.
 */
export function mergeSubscription(
  profile: ClashConfig,
  upstream: ClashConfig,
  policy: GroupPolicy,
): ClashConfig {
  const rules = readRules(profile);
  const proxies = readProxies(upstream);
  const groups = buildGroups(
    proxies.map((proxy) => proxy.name),
    policy,
  );

  const allowed = new Set<string>(BUILTIN_NAMES);
  for (const group of groups) allowed.add(group.name);
  for (const proxy of proxies) allowed.add(proxy.name);
  validateRules(rules, allowed);

  return assemble(profile, proxies, groups);
}

function readRules(profile: ClashConfig): string[] {
  const rules: unknown = profile.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new MergeError("profile.rules must be a non-empty array of rule strings");
  }
  for (const rule of rules) {
    if (typeof rule !== "string") {
      throw new MergeError("profile.rules must contain only strings");
    }
  }
  return rules as string[];
}

function readProxies(upstream: ClashConfig): ClashProxy[] {
  const raw: unknown = upstream.proxies;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MergeError("upstream.proxies must be a non-empty array");
  }

  const proxies: ClashProxy[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MergeError(`upstream.proxies[${index}] is not a mapping`);
    }
    const name: unknown = (entry as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new MergeError(`upstream.proxies[${index}] has no usable name`);
    }
    if (seen.has(name)) return; // first occurrence wins
    seen.add(name);
    proxies.push(deepClone(entry) as ClashProxy);
  });
  return proxies;
}

function validateRules(rules: string[], allowed: Set<string>): void {
  rules.forEach((rule, index) => {
    const fields = stripComment(rule).split(",");
    const type = (fields[0] ?? "").trim();
    if (!KNOWN_TARGET_TYPES.has(type)) return; // unknown types may carry parenthesised logic

    const target = fields[type === "MATCH" ? MATCH_TARGET_INDEX : DEFAULT_TARGET_INDEX];
    if (target === undefined || !allowed.has(target.trim())) {
      throw new MergeError(
        `profile.rules[${index}] (${type}) does not route to a builtin, a generated group, or an upstream proxy`,
      );
    }
  });
}

/** Drop a trailing " # comment" from a rule line. */
function stripComment(rule: string): string {
  const at = rule.indexOf(" # ");
  return at === -1 ? rule : rule.slice(0, at);
}

function assemble(
  profile: ClashConfig,
  proxies: ClashProxy[],
  groups: ClashGroup[],
): ClashConfig {
  const keys = Object.keys(profile);
  const hasProxies = keys.includes("proxies");
  const hasGroups = keys.includes("proxy-groups");
  const anchor = insertionAnchor(keys.filter((key) => !REPLACED_KEYS.has(key)));

  const entries: Array<[string, unknown]> = [];
  let keptSeen = 0;
  let injected = hasProxies; // with a proxies key of its own, both slots are replaced in place

  for (const key of keys) {
    if (key === "proxies") {
      entries.push(["proxies", proxies]);
      if (!hasGroups) entries.push(["proxy-groups", groups]);
      continue;
    }
    if (key === "proxy-groups") {
      // Without a proxies key the pair is injected below instead, as a unit.
      if (hasProxies) entries.push(["proxy-groups", groups]);
      continue;
    }
    if (!injected && keptSeen === anchor) {
      // No proxies key: both go immediately before `rules`, after
      // `rule-providers` when that sits right above it.
      entries.push(["proxies", proxies], ["proxy-groups", groups]);
      injected = true;
    }
    entries.push([key, deepClone(profile[key])]);
    keptSeen += 1;
  }

  if (!injected) entries.push(["proxies", proxies], ["proxy-groups", groups]);

  return Object.fromEntries(entries) as ClashConfig;
}

function insertionAnchor(keptKeys: string[]): number {
  const rulesAt = keptKeys.indexOf("rules");
  if (rulesAt === -1) return keptKeys.length; // unreachable once rules are validated
  const providersAt = keptKeys.indexOf("rule-providers");
  if (providersAt !== -1 && providersAt < rulesAt) return providersAt + 1;
  return rulesAt;
}

/** Plain-data deep copy: the output shares nothing mutable with the inputs. */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = deepClone(item);
    return copy as T;
  }
  return value;
}
