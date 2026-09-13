import { PolicyError } from "./errors";
import type { BuiltinName, GroupPolicy, GroupSpec, MemberSpec } from "./types";

/** Names a rule target may use without naming a proxy or a generated group. */
export const BUILTIN_NAMES: readonly BuiltinName[] = [
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
];

/**
 * Group structure of the ansible clash template, with "all upstream nodes"
 * standing in for the template's proxy_hostnames.
 *
 * Group names are load-bearing: the standard rules route to default, proxy,
 * cn and ai. Do not rename them.
 */
export const DEFAULT_POLICY: GroupPolicy = {
  groups: [
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
      members: [{ kind: "nodes" }, { kind: "builtin", name: "DIRECT" }],
    },
    {
      name: "cn",
      type: "select",
      members: [{ kind: "builtin", name: "DIRECT" }, { kind: "nodes" }],
    },
    {
      name: "ai",
      type: "select",
      members: [{ kind: "nodes" }, { kind: "builtin", name: "DIRECT" }],
    },
  ],
};

/**
 * Parse GROUPS_JSON. `undefined` or an empty string yields DEFAULT_POLICY.
 * Throws PolicyError on malformed JSON or a member whose kind is unknown.
 */
export function parsePolicy(json: string | undefined): GroupPolicy {
  if (json === undefined || json.trim() === "") return clonePolicy(DEFAULT_POLICY);

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new PolicyError(`policy is not valid JSON: ${messageOf(err)}`);
  }
  return readPolicy(raw);
}

function clonePolicy(policy: GroupPolicy): GroupPolicy {
  return JSON.parse(JSON.stringify(policy)) as GroupPolicy;
}

function readPolicy(raw: unknown): GroupPolicy {
  if (!isRecord(raw)) throw new PolicyError("policy must be a JSON object");
  if (!Array.isArray(raw.groups)) throw new PolicyError("policy.groups must be an array");
  const groups = raw.groups.map((group, index) => readGroup(group, index));
  return { groups };
}

function readGroup(raw: unknown, index: number): GroupSpec {
  const at = `policy.groups[${index}]`;
  if (!isRecord(raw)) throw new PolicyError(`${at} must be an object`);

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new PolicyError(`${at}.name must be a non-empty string`);
  }

  const type = raw.type === undefined ? "select" : raw.type;
  if (typeof type !== "string" || type === "") {
    throw new PolicyError(`${at}.type must be a non-empty string`);
  }

  if (!Array.isArray(raw.members)) throw new PolicyError(`${at}.members must be an array`);
  const members = raw.members.map((member, memberIndex) => readMember(member, at, memberIndex));
  // GroupSpec pins the type to "select", but the value flows on into
  // ClashGroup.type, which is a free string, so a policy may widen it.
  return { name, type: type as GroupSpec["type"], members };
}

function readMember(raw: unknown, at: string, index: number): MemberSpec {
  const where = `${at}.members[${index}]`;
  if (!isRecord(raw)) throw new PolicyError(`${where} must be an object`);

  switch (raw.kind) {
    case "builtin": {
      const name = raw.name;
      if (typeof name !== "string" || !BUILTIN_NAMES.includes(name as BuiltinName)) {
        throw new PolicyError(`${where}.name must be one of ${BUILTIN_NAMES.join(", ")}`);
      }
      return { kind: "builtin", name: name as BuiltinName };
    }
    case "group": {
      const name = raw.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new PolicyError(`${where}.name must be a non-empty string`);
      }
      return { kind: "group", name };
    }
    case "nodes": {
      const member: MemberSpec = { kind: "nodes" };
      const include = readPatterns(raw.include, `${where}.include`);
      const exclude = readPatterns(raw.exclude, `${where}.exclude`);
      if (include !== undefined) member.include = include;
      if (exclude !== undefined) member.exclude = exclude;
      return member;
    }
    default:
      throw new PolicyError(`${where}.kind must be "builtin", "group", or "nodes"`);
  }
}

function readPatterns(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new PolicyError(`${where} must be an array of regex sources`);
  return raw.map((source, index) => {
    if (typeof source !== "string") {
      throw new PolicyError(`${where}[${index}] must be a string`);
    }
    try {
      new RegExp(source);
    } catch (err) {
      throw new PolicyError(`${where}[${index}] is not a valid regex: ${messageOf(err)}`);
    }
    return source;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
