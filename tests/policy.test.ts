import { describe, expect, it } from "vitest";

import { PolicyError } from "../src/errors";
import { DEFAULT_POLICY, parsePolicy } from "../src/policy";
import type { GroupPolicy, MemberSpec } from "../src/types";

function expectPolicyError(fn: () => unknown): void {
  expect(fn).toThrow(PolicyError);
}

function membersOf(policy: GroupPolicy, name: string): MemberSpec[] {
  const group = policy.groups.find((candidate) => candidate.name === name);
  expect(group, `policy should declare a ${name} group`).toBeDefined();
  return group?.members ?? [];
}

describe("DEFAULT_POLICY", () => {
  it("declares the four standard groups in order", () => {
    expect(DEFAULT_POLICY.groups.map((group) => group.name)).toEqual(["default", "proxy", "cn", "ai"]);
    expect(DEFAULT_POLICY.groups.map((group) => group.type)).toEqual([
      "select",
      "select",
      "select",
      "select",
    ]);
  });

  it("orders the members the way the rule targets expect", () => {
    const kinds = (name: string) => membersOf(DEFAULT_POLICY, name).map((member) => member.kind);
    const names = (name: string) =>
      membersOf(DEFAULT_POLICY, name).map((member) => ("name" in member ? member.name : undefined));

    expect(kinds("default")).toEqual(["builtin", "group"]);
    expect(names("default")).toEqual(["DIRECT", "proxy"]);

    expect(kinds("proxy")).toEqual(["nodes", "builtin"]);
    expect(names("proxy")).toEqual([undefined, "DIRECT"]);

    expect(kinds("cn")).toEqual(["builtin", "nodes"]);
    expect(names("cn")).toEqual(["DIRECT", undefined]);

    expect(kinds("ai")).toEqual(["nodes", "builtin"]);
    expect(names("ai")).toEqual([undefined, "DIRECT"]);
  });

  it("lets the nodes members match every proxy name", () => {
    const sample = ["Alpha Node", "香港 01", "plain-node-name"];

    for (const group of DEFAULT_POLICY.groups) {
      for (const member of group.members) {
        if (member.kind !== "nodes") continue;

        const include = member.include ?? [];
        const exclude = member.exclude ?? [];

        for (const name of sample) {
          const matched = include.length === 0 || include.some((source) => new RegExp(source).test(name));
          expect(matched, `${group.name} should match ${name}`).toBe(true);

          for (const source of exclude) {
            expect(new RegExp(source).test(name), `${group.name} should not exclude ${name}`).toBe(false);
          }
        }
      }
    }
  });
});

describe("parsePolicy", () => {
  it("returns DEFAULT_POLICY for undefined", () => {
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY);
  });

  it("returns DEFAULT_POLICY for an empty string", () => {
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
  });

  it("parses a custom policy", () => {
    const json = JSON.stringify({
      groups: [
        {
          name: "proxy",
          type: "select",
          members: [{ kind: "nodes", include: ["^HK-"] }, { kind: "builtin", name: "DIRECT" }],
        },
        { name: "cn", type: "select", members: [{ kind: "builtin", name: "DIRECT" }] },
      ],
    });

    const policy = parsePolicy(json);

    expect(policy).toEqual(JSON.parse(json));
    expect(policy.groups.map((group) => group.name)).toEqual(["proxy", "cn"]);
  });

  it("parses every builtin name", () => {
    const json = JSON.stringify({
      groups: [
        {
          name: "proxy",
          type: "select",
          members: [
            { kind: "builtin", name: "DIRECT" },
            { kind: "builtin", name: "REJECT" },
            { kind: "builtin", name: "REJECT-DROP" },
            { kind: "builtin", name: "PASS" },
            { kind: "builtin", name: "COMPATIBLE" },
          ],
        },
      ],
    });

    expect(membersOf(parsePolicy(json), "proxy")).toHaveLength(5);
  });

  it("throws PolicyError on malformed JSON", () => {
    expectPolicyError(() => parsePolicy("{ this is not json"));
    expectPolicyError(() => parsePolicy('{"groups": ['));
  });

  it("throws PolicyError on an unknown member kind", () => {
    const json = JSON.stringify({
      groups: [{ name: "proxy", type: "select", members: [{ kind: "wildcard", name: "x" }] }],
    });

    expectPolicyError(() => parsePolicy(json));
  });
});
