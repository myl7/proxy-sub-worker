import { MergeError } from "./errors";
import type { ClashGroup, GroupPolicy, MemberSpec } from "./types";

/**
 * Expand a group policy against the upstream proxy names.
 *
 * Output groups keep the policy's order. Member order is the policy's member
 * order, and a `nodes` member expands to proxy names in `proxyNames` order.
 * Duplicate member names inside one group are dropped, first occurrence wins.
 */
export function buildGroups(proxyNames: string[], policy: GroupPolicy): ClashGroup[] {
  if (proxyNames.length === 0) {
    throw new MergeError("cannot build groups: the upstream subscription exposes no proxies");
  }

  const knownGroups = new Set(policy.groups.map((group) => group.name));

  return policy.groups.map((spec) => {
    if (spec.members.length === 0) {
      throw new MergeError(`group "${spec.name}" has no members in the policy`);
    }

    const proxies: string[] = [];
    const seen = new Set<string>();
    for (const member of spec.members) {
      const resolved = resolveMember(member, spec.name, proxyNames, knownGroups);
      if (resolved.length === 0) {
        throw new MergeError(`group "${spec.name}": a ${member.kind} member resolves to no names`);
      }
      for (const name of resolved) {
        if (seen.has(name)) continue;
        seen.add(name);
        proxies.push(name);
      }
    }

    return { name: spec.name, type: spec.type, proxies };
  });
}

function resolveMember(
  member: MemberSpec,
  groupName: string,
  proxyNames: string[],
  knownGroups: Set<string>,
): string[] {
  switch (member.kind) {
    case "builtin":
      return [member.name];
    case "group":
      if (!knownGroups.has(member.name)) {
        throw new MergeError(
          `group "${groupName}" references group "${member.name}", which the policy does not define`,
        );
      }
      return [member.name];
    case "nodes":
      return proxyNames.filter((name) => matchesNodes(member, name));
  }
}

function matchesNodes(
  member: Extract<MemberSpec, { kind: "nodes" }>,
  proxyName: string,
): boolean {
  // A missing include means "all".
  const included =
    member.include === undefined ||
    member.include.some((source) => compile(source).test(proxyName));
  if (!included) return false;
  return !(member.exclude ?? []).some((source) => compile(source).test(proxyName));
}

function compile(source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    throw new MergeError(`a nodes member carries an unusable regex source: ${reason}`);
  }
}
