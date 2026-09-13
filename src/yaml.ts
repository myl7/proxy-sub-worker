import { parse, stringify } from "yaml";
import { MergeError } from "./errors";
import type { ClashConfig } from "./types";

/** Parse a Clash YAML document. Throws MergeError on syntax errors or a non-mapping root. */
export function parseConfig(text: string): ClashConfig {
  let value: unknown;
  try {
    value = parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    throw new MergeError(`source is not valid YAML: ${reason}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MergeError("source root must be a YAML mapping");
  }
  return value as ClashConfig;
}

/**
 * Serialize a Clash config. `lineWidth: 0` keeps long rule lines from being
 * folded, and aliases are off so two equal-but-distinct values stay spelled
 * out instead of collapsing into an anchor.
 */
export function stringifyConfig(config: ClashConfig): string {
  return stringify(config, { lineWidth: 0, aliasDuplicateObjects: false });
}
