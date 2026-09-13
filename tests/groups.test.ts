import { describe, expect, it } from "vitest";

import { MergeError } from "../src/errors";
import { buildGroups } from "../src/groups";
import { DEFAULT_POLICY } from "../src/policy";
import type { ClashGroup, GroupPolicy } from "../src/types";

const NAMES = ["香港 01", "Bravo-Node", "Alpha Node"];

function expectMergeError(fn: () => unknown): void {
  expect(fn).toThrow(MergeError);
}

/** Most policies below are small enough that a group is addressed by index. */
function groupAt(groups: ClashGroup[], index: number): ClashGroup {
  const group = groups[index];
  if (group === undefined) throw new Error(`expected a group at index ${index}`);
  return group;
}

function firstGroup(groups: ClashGroup[]): ClashGroup {
  return groupAt(groups, 0);
}

function selectPolicy(groups: GroupPolicy["groups"]): GroupPolicy {
  return { groups };
}

describe("buildGroups with DEFAULT_POLICY", () => {
  it("keeps the policy's group order and names", () => {
    const groups = buildGroups(NAMES, DEFAULT_POLICY);

    expect(groups.map((group) => group.name)).toEqual(["default", "proxy", "cn", "ai"]);
    expect(groups.map((group) => group.type)).toEqual(["select", "select", "select", "select"]);
  });

  it("expands each member in policy order", () => {
    const groups = buildGroups(NAMES, DEFAULT_POLICY);
    const members = new Map(groups.map((group) => [group.name, group.proxies]));

    expect(members.get("default")).toEqual(["DIRECT", "proxy"]);
    expect(members.get("proxy")).toEqual(["香港 01", "Bravo-Node", "Alpha Node", "DIRECT"]);
    expect(members.get("cn")).toEqual(["DIRECT", "香港 01", "Bravo-Node", "Alpha Node"]);
    expect(members.get("ai")).toEqual(["香港 01", "Bravo-Node", "Alpha Node", "DIRECT"]);
  });

  it("throws when there are no proxy names", () => {
    expectMergeError(() => buildGroups([], DEFAULT_POLICY));
  });
});

describe("buildGroups member resolution", () => {
  it("filters a nodes member with include and exclude regexes", () => {
    const policy = selectPolicy([
      {
        name: "proxy",
        type: "select",
        members: [
          { kind: "nodes", include: ["^HK-", "^SG-"], exclude: ["-exp$"] },
          { kind: "builtin", name: "DIRECT" },
        ],
      },
    ]);

    const groups = buildGroups(["HK-01", "SG-1", "US-1", "HK-exp", "HK-02"], policy);

    expect(firstGroup(groups).proxies).toEqual(["HK-01", "SG-1", "HK-02", "DIRECT"]);
  });

  it("treats a missing include as all names and a missing exclude as no filter", () => {
    const excludeOnly = selectPolicy([
      { name: "proxy", type: "select", members: [{ kind: "nodes", exclude: ["^US-"] }] },
    ]);
    expect(firstGroup(buildGroups(["HK-01", "SG-1", "US-1"], excludeOnly)).proxies).toEqual([
      "HK-01",
      "SG-1",
    ]);

    const noFilter = selectPolicy([{ name: "proxy", type: "select", members: [{ kind: "nodes" }] }]);
    expect(firstGroup(buildGroups(["HK-01", "SG-1"], noFilter)).proxies).toEqual(["HK-01", "SG-1"]);
  });

  it("keeps proxy order inside a nodes member", () => {
    const policy = selectPolicy([
      { name: "proxy", type: "select", members: [{ kind: "nodes", exclude: ["^Bravo"] }] },
    ]);

    expect(firstGroup(buildGroups(["香港 01", "Bravo-Node", "Alpha Node"], policy)).proxies).toEqual([
      "香港 01",
      "Alpha Node",
    ]);
  });

  it("resolves a group member to the referenced group's name", () => {
    const policy = selectPolicy([
      {
        name: "default",
        type: "select",
        members: [
          { kind: "builtin", name: "DIRECT" },
          { kind: "group", name: "proxy" },
        ],
      },
      {
        name: "proxy",
        type: "select",
        members: [{ kind: "nodes" }, { kind: "builtin", name: "REJECT" }],
      },
    ]);

    const groups = buildGroups(["n1", "n2"], policy);

    expect(groups.map((group) => group.name)).toEqual(["default", "proxy"]);
    expect(groupAt(groups, 0).proxies).toEqual(["DIRECT", "proxy"]);
    expect(groupAt(groups, 1).proxies).toEqual(["n1", "n2", "REJECT"]);
  });

  it("throws when a nodes member matches nothing", () => {
    const policy = selectPolicy([
      { name: "proxy", type: "select", members: [{ kind: "nodes", include: ["^ZZZ-"] }] },
    ]);

    expectMergeError(() => buildGroups(["HK-01", "SG-1"], policy));
  });

  it("throws when an exclude filter leaves a nodes member empty", () => {
    const policy = selectPolicy([
      { name: "proxy", type: "select", members: [{ kind: "nodes", include: ["^HK-"], exclude: ["^HK-"] }] },
    ]);

    expectMergeError(() => buildGroups(["HK-01", "SG-1"], policy));
  });

  it("throws when a group member names a group outside the policy", () => {
    const policy = selectPolicy([
      { name: "default", type: "select", members: [{ kind: "group", name: "does-not-exist" }] },
    ]);

    expectMergeError(() => buildGroups(["HK-01"], policy));
  });

  it("drops duplicate member names inside one group, first occurrence wins", () => {
    const policy = selectPolicy([
      {
        name: "proxy",
        type: "select",
        members: [
          { kind: "nodes", include: ["^HK-01$"] },
          { kind: "nodes", include: ["^HK-"] },
          { kind: "builtin", name: "DIRECT" },
          { kind: "nodes", include: ["^HK-01$"] },
        ],
      },
    ]);

    const groups = buildGroups(["HK-01", "HK-02"], policy);

    expect(firstGroup(groups).proxies).toEqual(["HK-01", "HK-02", "DIRECT"]);
  });

  it("collapses duplicates across member kinds", () => {
    const policy = selectPolicy([
      {
        name: "proxy",
        type: "select",
        members: [
          { kind: "builtin", name: "DIRECT" },
          { kind: "nodes", include: ["^DIRECT$"] },
        ],
      },
    ]);

    expect(firstGroup(buildGroups(["DIRECT", "HK-01"], policy)).proxies).toEqual(["DIRECT"]);
  });

  it("keeps the policy's group order even when a group is referenced before it is declared", () => {
    const policy = selectPolicy([
      { name: "ai", type: "select", members: [{ kind: "group", name: "cn" }, { kind: "nodes" }] },
      { name: "cn", type: "select", members: [{ kind: "builtin", name: "DIRECT" }] },
    ]);

    const groups = buildGroups(["n1"], policy);

    expect(groups.map((group) => group.name)).toEqual(["ai", "cn"]);
    expect(firstGroup(groups).proxies).toEqual(["cn", "n1"]);
  });
});
