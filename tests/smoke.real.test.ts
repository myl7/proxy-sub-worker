// Opt-in smoke test: `SMOKE=1 vitest run tests/smoke.real.test.ts`.
// Everything lives inside describe.skipIf, so a plain `vitest run` never touches
// the network. This file prints structural counts only: it must never print rule
// text, node names, URLs, or credentials.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mergeSubscription } from "../src/merge";
import { DEFAULT_POLICY, parsePolicy } from "../src/policy";
import { parseConfig, stringifyConfig } from "../src/yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS_PATH = join(ROOT, ".dev.vars");
const OUTPUT_PATH = "/tmp/proxy-sub-merged.yaml";
const TIMEOUT_MS = 20000;

function readDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(DEV_VARS_PATH)) return vars;

  for (const rawLine of readFileSync(DEV_VARS_PATH, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    vars[key] = value;
  }

  return vars;
}

async function loadText(url: string, allowInsecureFallback: boolean): Promise<string> {
  let fetchFailure = "unknown error";

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP status ${response.status}`);
    return await response.text();
  } catch (error) {
    fetchFailure = error instanceof Error ? error.message : "unknown error";
  }

  if (!allowInsecureFallback) {
    throw new Error(`fetch failed (${fetchFailure})`);
  }

  // The provider's leaf certificate is not verifiable, so retry without TLS
  // verification. Only the exit status is reported, never the URL.
  const result = spawnSync("curl", ["-kfsS", "--max-time", "20", url], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`fetch failed (${fetchFailure}) and curl exited with status ${result.status}`);
  }

  return result.stdout;
}

const devVars = readDevVars();
const profileUrl = devVars.PROFILE_URL;
const upstreamUrl = devVars.UPSTREAM_URL;

describe.skipIf(!process.env.SMOKE)("real subscription smoke", () => {
  it.skipIf(!profileUrl || !upstreamUrl)("merges the real profile with the real upstream", async () => {
    const profile = parseConfig(await loadText(profileUrl as string, false));
    const upstream = parseConfig(await loadText(upstreamUrl as string, true));
    const policy = devVars.GROUPS_JSON ? parsePolicy(devVars.GROUPS_JSON) : DEFAULT_POLICY;

    const merged = mergeSubscription(profile, upstream, policy);
    const output = stringifyConfig(merged);
    writeFileSync(OUTPUT_PATH, output, "utf8");

    const nodeCount = merged.proxies?.length ?? 0;
    const groups = merged["proxy-groups"] ?? [];
    const groupSummary = groups.map((group) => `${group.name}(${group.proxies.length})`).join(", ");
    const ruleCount = merged.rules?.length ?? 0;
    const bytes = Buffer.byteLength(output, "utf8");

    process.stdout.write(
      `smoke: nodes=${nodeCount} groups=${groupSummary} rules=${ruleCount} bytes=${bytes} out=${OUTPUT_PATH}\n`,
    );

    expect(nodeCount).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(0);
    expect(ruleCount).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(0);
  });
});
