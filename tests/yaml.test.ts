import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MergeError } from "../src/errors";
import type { ClashConfig, ClashProxy } from "../src/types";
import { parseConfig, stringifyConfig } from "../src/yaml";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function expectMergeError(fn: () => unknown): void {
  expect(fn).toThrow(MergeError);
}

const NAMES = [
  "香港 01",
  "A: B #1",
  "新加坡 高速",
  'quote"inside',
  "single'quote",
  "[bracket] 02",
  "back\\slash",
  "🚀 fast lane",
  "true",
  "plain-node",
];

function fakeProxy(name: string, index: number): ClashProxy {
  return {
    name,
    type: "ss",
    server: "192.0.2.10",
    port: 8000 + index,
    cipher: "aes-128-gcm",
    password: `placeholder-${index}`,
  };
}

function sampleConfig(): ClashConfig {
  return {
    "mixed-port": 7890,
    "log-level": "info",
    proxies: NAMES.map(fakeProxy),
    "proxy-groups": [
      { name: "proxy", type: "select", proxies: [...NAMES, "DIRECT"] },
      { name: "cn", type: "select", proxies: ["DIRECT", ...NAMES] },
    ],
    rules: [
      "DOMAIN-SUFFIX,internal.example.invalid,default",
      "GEOIP,CN,cn,no-resolve",
      "MATCH,proxy",
    ],
  };
}

describe("parseConfig", () => {
  it("reads the provider-style upstream fixture", () => {
    const upstream = parseConfig(readFixture("upstream.yaml"));

    expect(upstream.proxies).toHaveLength(5);
    expect(upstream.proxies?.map((entry) => entry.name)).toEqual([
      "Alpha Node",
      "Bravo-Node",
      "香港 01",
      "A: B #1",
      "Alpha Node",
    ]);
    expect(upstream.proxies?.[3]?.type).toBe("hysteria2");
    expect(upstream.rules).toEqual(["MATCH,upstream-group"]);
  });

  it("reads the profile fixture and preserves its key order", () => {
    const profile = parseConfig(readFixture("profile.yaml"));

    expect(Object.keys(profile)).toEqual([
      "log-level",
      "mixed-port",
      "allow-lan",
      "ipv6",
      "mode",
      "unified-delay",
      "profile",
      "sniffer",
      "dns",
      "geodata-mode",
      "geo-auto-update",
      "geo-update-interval",
      "geox-url",
      "proxies",
      "proxy-groups",
      "rule-providers",
      "rules",
    ]);
    expect(profile.proxies).toHaveLength(2);
    expect(profile.rules).toHaveLength(9);
    // The trailing YAML comment never reaches the rule string.
    expect(profile.rules?.[1]).toBe("DOMAIN-SUFFIX,pinned.example.invalid,Alpha Node");
  });

  it("throws MergeError on a non-mapping root", () => {
    expectMergeError(() => parseConfig("- one\n- two\n"));
    expectMergeError(() => parseConfig("just a scalar"));
  });

  it("throws MergeError on a YAML syntax error", () => {
    expectMergeError(() => parseConfig("a: [unclosed\n"));
    expectMergeError(() => parseConfig("---\na: one\n---\nb: two\n"));
  });
});

describe("stringifyConfig", () => {
  it("round-trips CJK and special-character proxy names", () => {
    const config = sampleConfig();
    const text = stringifyConfig(config);

    expect(parseConfig(text)).toEqual(config);

    const twice = parseConfig(stringifyConfig(parseConfig(text)));
    expect(twice).toEqual(config);
  });

  it("round-trips the provider-style upstream fixture", () => {
    const parsed = parseConfig(readFixture("upstream.yaml"));

    expect(parseConfig(stringifyConfig(parsed))).toEqual(parsed);
  });

  it("keeps a long rule on one line", () => {
    const rule = `DOMAIN-SUFFIX,${"segment.".repeat(20)}example.invalid,Alpha Node`;
    expect(rule.length).toBeGreaterThan(120);

    const text = stringifyConfig({ rules: [rule] });

    expect(text).toContain(rule);
    const ruleLine = text.split("\n").find((line) => line.includes("DOMAIN-SUFFIX,"));
    expect(ruleLine).toContain("Alpha Node");
    expect(parseConfig(text).rules).toEqual([rule]);
  });

  it("keeps a long rule whose target forces quoting on one line", () => {
    const rule = `DOMAIN-SUFFIX,${"segment.".repeat(20)}example.invalid,A: B`;
    expect(rule.length).toBeGreaterThan(120);

    const text = stringifyConfig({ rules: [rule, "MATCH,DIRECT"] });

    expect(text).toContain(rule);
    expect(parseConfig(text).rules).toEqual([rule, "MATCH,DIRECT"]);
  });
});
