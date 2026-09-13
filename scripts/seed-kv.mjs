#!/usr/bin/env node
// Seeds the KV fallback that carries the subscription while the upstream
// provider's certificate is broken.
//
//   npm run seed
//
// Reads .dev.vars, fetches both sources, uploads them with
// `wrangler kv key put --remote`, and prints byte counts. Source text never
// reaches stdout, stderr, or a message, and the temp files are removed before
// the script exits. Run this yourself. The Worker never writes KV.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_NAMESPACE_ID = "REPLACE_WITH_KV_NAMESPACE_ID";
const FETCH_TIMEOUT_MS = 30_000;
const CURL_TIMEOUT_SECONDS = 60;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_REPORTED_STDERR_CHARS = 1500;

/** An error whose message is safe to print: no URL, no body, no credential. */
class SourceError extends Error {}

function parseDotenv(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    let value = body.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (key !== "") vars[key] = value;
  }
  return vars;
}

/** Describe a failure without quoting the request URL or any response text. */
function failureReason(error) {
  if (error instanceof SourceError) return error.message;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    const code = error.code;
    if (typeof code === "number") return `exit code ${code}`;
    if (typeof code === "string") return code;
    if (error.name === "TypeError") return "network error";
    return error.name && error.name !== "Error" ? error.name : "failed";
  }
  return "failed";
}

async function fetchText(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new SourceError(`${label}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.trim() === "") throw new SourceError(`${label}: empty body`);
  return text;
}

async function curlText(url, label) {
  const { stdout } = await execFileAsync(
    "curl",
    ["-k", "-sS", "-L", "--max-time", String(CURL_TIMEOUT_SECONDS), url],
    { maxBuffer: MAX_CHILD_OUTPUT_BYTES, encoding: "utf8" },
  );
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw new SourceError(`${label}: curl returned an empty body`);
  }
  return stdout;
}

/**
 * The provider's certificate chain is broken, so a strict fetch keeps failing
 * until they fix it. `curl -k` is the documented way through for the seed step.
 */
async function fetchUpstream(url, label) {
  try {
    return await fetchText(url, label);
  } catch (error) {
    console.warn(`${label}: direct fetch failed (${failureReason(error)}), retrying with curl -k`);
  }
  return curlText(url, label);
}

async function putKv(key, filePath) {
  try {
    await execFileAsync(
      "npx",
      ["wrangler", "kv", "key", "put", key, "--binding", "PROXY_SUB_KV", "--path", filePath, "--remote"],
      { cwd: ROOT, maxBuffer: MAX_CHILD_OUTPUT_BYTES, encoding: "utf8" },
    );
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const tail = stderr.slice(-MAX_REPORTED_STDERR_CHARS);
    throw new SourceError(`wrangler upload failed for ${key}${tail ? `\n${tail}` : ""}`);
  }
}

async function main() {
  const config = await readFile(join(ROOT, "wrangler.jsonc"), "utf8").catch(() => null);
  if (config === null) {
    console.error("wrangler.jsonc not found.");
    console.error("Copy wrangler.jsonc.example to wrangler.jsonc, then paste your KV namespace id.");
    process.exitCode = 1;
    return;
  }
  if (config.includes(PLACEHOLDER_NAMESPACE_ID)) {
    console.error("wrangler.jsonc still has the placeholder KV namespace id.");
    console.error("Run `npx wrangler kv namespace create PROXY_SUB_KV`, then paste the id in.");
    process.exitCode = 1;
    return;
  }

  const dotenv = await readFile(join(ROOT, ".dev.vars"), "utf8").catch(() => null);
  if (dotenv === null) {
    console.error(".dev.vars not found. Copy .dev.vars.example to .dev.vars and fill it in.");
    process.exitCode = 1;
    return;
  }

  const vars = parseDotenv(dotenv);
  const missing = ["PROFILE_URL", "UPSTREAM_URL"].filter((name) => !vars[name]);
  if (missing.length > 0) {
    console.error(`.dev.vars is missing: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "proxy-sub-worker-seed-"));
  try {
    const sources = [
      { key: "profile", text: () => fetchText(vars.PROFILE_URL, "profile") },
      { key: "upstream", text: () => fetchUpstream(vars.UPSTREAM_URL, "upstream") },
    ];

    for (const source of sources) {
      const text = await source.text();
      const filePath = join(workDir, `${source.key}.yaml`);
      await writeFile(filePath, text, { mode: 0o600 });
      await putKv(source.key, filePath);
      console.log(`${source.key}: ${Buffer.byteLength(text, "utf8")} bytes -> PROXY_SUB_KV/${source.key}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`seed failed: ${failureReason(error)}`);
  process.exitCode = 1;
}
