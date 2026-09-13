import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MergeError } from "../src/errors";
import { buildGroups } from "../src/groups";
import { mergeSubscription } from "../src/merge";
import { DEFAULT_POLICY } from "../src/policy";
import type { ClashConfig, ClashGroup, ClashProxy } from "../src/types";
import { parseConfig, stringifyConfig } from "../src/yaml";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

const profile = parseConfig(readFixture("profile.yaml"));
const upstream = parseConfig(readFixture("upstream.yaml"));

// The upstream fixture declares "Alpha Node" twice; the second entry is dropped.
const UPSTREAM_NAMES = ["Alpha Node", "Bravo-Node", "香港 01", "A: B #1"];

const KNOWN_RULE_TYPES = [
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
];

function merge(): ClashConfig {
  return mergeSubscription(profile, upstream, DEFAULT_POLICY);
}

function expectMergeError(fn: () => unknown): void {
  expect(fn).toThrow(MergeError);
}

/**
 * The negative tests below feed the merge a shape the type system forbids on
 * purpose. This is the single place that cast happens.
 */
function malformedConfig(raw: Record<string, unknown>): ClashConfig {
  return raw as unknown as ClashConfig;
}

describe("mergeSubscription", () => {
  it("takes the upstream proxies in order and drops duplicate names first-wins", () => {
    const result = merge();

    expect(result.proxies).toHaveLength(4);
    expect(result.proxies?.map((proxy) => proxy.name)).toEqual(UPSTREAM_NAMES);

    // Byte-for-byte: the surviving entries are the parsed upstream objects.
    expect(result.proxies?.[0]).toEqual(upstream.proxies?.[0]);
    expect(result.proxies?.[1]).toEqual(upstream.proxies?.[1]);
    expect(result.proxies?.[2]).toEqual(upstream.proxies?.[2]);
    expect(result.proxies?.[3]).toEqual(upstream.proxies?.[3]);

    // The duplicate upstream entry differs from the first one, so keeping the
    // first occurrence is observable.
    expect(upstream.proxies?.[4]?.name).toBe(upstream.proxies?.[0]?.name);
    expect(upstream.proxies?.[4]?.port).not.toBe(upstream.proxies?.[0]?.port);
    expect(result.proxies?.[0]?.port).toBe(upstream.proxies?.[0]?.port);
  });

  it("keeps every other profile key deep-equal and drops the profile's own proxies", () => {
    const result = merge();

    for (const key of Object.keys(profile)) {
      if (key === "proxies" || key === "proxy-groups") continue;
      expect(result[key], `profile key ${key}`).toEqual(profile[key]);
    }

    expect(Object.keys(result).sort()).toEqual(Object.keys(profile).sort());
    expect(JSON.stringify(result)).not.toContain("placeholder-node");
    expect(JSON.stringify(result)).not.toContain("placeholder-group");
  });

  it("ignores the upstream's own settings, groups and rules", () => {
    const result = merge();

    expect(result.port).toBeUndefined();
    expect(result["socks-port"]).toBeUndefined();
    expect(result["external-controller"]).toBeUndefined();
    expect(result["mixed-port"]).toBe(profile["mixed-port"]);

    expect(result["proxy-groups"]?.map((group) => group.name)).not.toContain("upstream-group");
    expect(result.rules).not.toContain("MATCH,upstream-group");
    expect(JSON.stringify(result)).not.toContain("upstream-group");
  });

  it("builds the groups from the deduped upstream names", () => {
    const result = merge();

    expect(result["proxy-groups"]).toEqual(buildGroups(UPSTREAM_NAMES, DEFAULT_POLICY));
  });

  it("passes the profile rules through byte-identical", () => {
    const result = merge();

    expect(result.rules).toEqual(profile.rules);
    expect(result.rules).toHaveLength(profile.rules?.length ?? 0);
    // Quoted in the fixture, so the comment is part of the rule string.
    expect(result.rules).toContain("DOMAIN-SUFFIX,internal.example.invalid,default # pinned route");
    // Unquoted in the fixture: the YAML comment never reaches the string.
    expect(result.rules).toContain("DOMAIN-SUFFIX,pinned.example.invalid,Alpha Node");
    expect(result.rules).not.toContain("DOMAIN-SUFFIX,pinned.example.invalid,Alpha Node # manual pin");
  });

  it("places proxies and proxy-groups where the profile had them", () => {
    const keys = Object.keys(merge());

    expect(keys).toEqual(Object.keys(profile));
    expect(keys.indexOf("proxies")).toBeGreaterThan(keys.indexOf("geox-url"));
    expect(keys.indexOf("proxy-groups")).toBe(keys.indexOf("proxies") + 1);
    expect(keys.indexOf("proxy-groups")).toBeLessThan(keys.indexOf("rule-providers"));
    expect(keys.indexOf("rules")).toBe(keys.length - 1);
  });

  it("inserts proxies and proxy-groups before rules when the profile has no proxies key", () => {
    const withProvider: ClashConfig = {
      "log-level": "info",
      "rule-providers": {
        anything: {
          type: "http",
          behavior: "domain",
          url: "https://rules.example.invalid/anything.yaml",
          path: "./ruleset/anything.yaml",
          interval: 86400,
        },
      },
      rules: ["MATCH,default"],
    };

    const result = mergeSubscription(withProvider, upstream, DEFAULT_POLICY);

    expect(Object.keys(result)).toEqual(["log-level", "rule-providers", "proxies", "proxy-groups", "rules"]);
    expect(result.proxies).toHaveLength(4);
    expect(result["proxy-groups"]?.map((group) => group.name)).toEqual(["default", "proxy", "cn", "ai"]);

    const withoutProvider: ClashConfig = { mode: "rule", rules: ["MATCH,DIRECT"] };
    const second = mergeSubscription(withoutProvider, upstream, DEFAULT_POLICY);

    expect(Object.keys(second)).toEqual(["mode", "proxies", "proxy-groups", "rules"]);
  });

  it("puts proxy-groups immediately after an existing proxies key", () => {
    const withProxiesOnly: ClashConfig = {
      mode: "rule",
      proxies: [{ name: "placeholder-node", type: "ss", server: "192.0.2.9", port: 1080 }],
      rules: ["MATCH,default"],
    };

    const result = mergeSubscription(withProxiesOnly, upstream, DEFAULT_POLICY);

    expect(Object.keys(result)).toEqual(["mode", "proxies", "proxy-groups", "rules"]);
    // The profile's own proxies are still replaced, not kept.
    expect(result.proxies?.map((proxy) => proxy.name)).toEqual(UPSTREAM_NAMES);
  });

  it("round-trips the merged config through stringify and parse", () => {
    const result = merge();
    const reparsed = parseConfig(stringifyConfig(result));

    expect(reparsed).toEqual(result);
    expect(reparsed.rules).toEqual(profile.rules);
  });

  it("does not mutate its inputs", () => {
    const profileSnapshot = structuredClone(profile);
    const upstreamSnapshot = structuredClone(upstream);

    const result = mergeSubscription(profile, upstream, DEFAULT_POLICY);

    expect(result).not.toBe(profile);
    expect(profile).toEqual(profileSnapshot);
    expect(upstream).toEqual(upstreamSnapshot);

    (result.rules as string[]).push("MATCH,DIRECT");
    (result.proxies as ClashProxy[]).pop();
    (result["proxy-groups"] as ClashGroup[]).pop();
    (result.dns as Record<string, unknown>).enable = false;

    expect(profile).toEqual(profileSnapshot);
    expect(upstream).toEqual(upstreamSnapshot);
  });
});

describe("mergeSubscription validation", () => {
  it("rejects an empty upstream proxies list", () => {
    expectMergeError(() => mergeSubscription(profile, { ...upstream, proxies: [] }, DEFAULT_POLICY));
  });

  it("rejects a proxy with no name", () => {
    const upstreamWithoutName = malformedConfig({
      ...upstream,
      proxies: [{ type: "ss", server: "192.0.2.99", port: 1080 }],
    });

    expectMergeError(() => mergeSubscription(profile, upstreamWithoutName, DEFAULT_POLICY));
  });

  it("rejects non-array rules", () => {
    const profileWithStringRules = malformedConfig({ ...profile, rules: "MATCH,DIRECT" });

    expectMergeError(() => mergeSubscription(profileWithStringRules, upstream, DEFAULT_POLICY));
  });

  it("rejects a profile with no rules key", () => {
    const withoutRules: ClashConfig = { ...profile };
    delete withoutRules.rules;

    expectMergeError(() => mergeSubscription(withoutRules, upstream, DEFAULT_POLICY));
  });

  it("rejects a profile with an empty rules list", () => {
    expectMergeError(() => mergeSubscription({ ...profile, rules: [] }, upstream, DEFAULT_POLICY));
  });

  it("rejects a known-type rule whose target resolves to nothing", () => {
    expectMergeError(() =>
      mergeSubscription(
        { ...profile, rules: ["DOMAIN-SUFFIX,orphan.example.invalid,NoSuchGroup"] },
        upstream,
        DEFAULT_POLICY,
      ),
    );

    // MATCH reads its target from field index 1, not 2.
    expectMergeError(() =>
      mergeSubscription({ ...profile, rules: ["MATCH,NoSuchGroup"] }, upstream, DEFAULT_POLICY),
    );

    // A nodes name that the upstream does not carry is not a valid target.
    expectMergeError(() =>
      mergeSubscription(
        { ...profile, rules: ["DOMAIN-SUFFIX,orphan.example.invalid,Alpha Node 2"] },
        upstream,
        DEFAULT_POLICY,
      ),
    );
  });

  it("accepts a rule whose target is a proxy name", () => {
    const config: ClashConfig = { ...profile, rules: ["DOMAIN-SUFFIX,pin.example.invalid,Alpha Node"] };

    expect(mergeSubscription(config, upstream, DEFAULT_POLICY).rules).toEqual(config.rules);
  });

  it("does not validate unknown rule types", () => {
    const config: ClashConfig = {
      ...profile,
      rules: [
        "AND,((DOMAIN-SUFFIX,logic.example.invalid),(NETWORK,tcp)),NoSuchGroup",
        "NOT,((GEOIP,CN)),NoSuchGroup",
        "MATCH,DIRECT",
      ],
    };

    expect(mergeSubscription(config, upstream, DEFAULT_POLICY).rules).toEqual(config.rules);
  });

  it.each(KNOWN_RULE_TYPES)("resolves the target of a %s rule", (type) => {
    const accepted: ClashConfig = { ...profile, rules: [`${type},placeholder-payload,cn`] };
    expect(mergeSubscription(accepted, upstream, DEFAULT_POLICY).rules).toEqual(accepted.rules);

    const rejected: ClashConfig = { ...profile, rules: [`${type},placeholder-payload,NoSuchGroup`] };
    expectMergeError(() => mergeSubscription(rejected, upstream, DEFAULT_POLICY));
  });
});
