#!/usr/bin/env node
// Local stand-in for the two upstream sources. Serves the YAML fixtures on
// loopback so `wrangler dev` can be exercised end to end without touching the
// network. Both ports serve both paths, so one process can play either source,
// and either port can be pointed at to simulate a source that cannot be reached.
//
//   node tests/fixtures/source-server.mjs 8788 8789
//
// Pass 0 for a port to have the OS pick a free one. The bound URLs are printed.

import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

/** Request path -> fixture file, in print order. */
const ROUTES = new Map([
  ["/profile.yaml", "profile.yaml"],
  ["/upstream.yaml", "upstream.yaml"],
]);

const ports = process.argv.slice(2).map((value) => Number(value));
const valid =
  ports.length === 2 &&
  ports.every((port) => Number.isInteger(port) && port >= 0 && port <= 65535);
if (!valid) {
  console.error("usage: node tests/fixtures/source-server.mjs <port> <port>");
  process.exit(1);
}

function send(res, status, body, extraHeaders) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function handle(req, res) {
  const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
  const file = ROUTES.get(path);

  if (req.method !== "GET") {
    send(res, 405, "method not allowed", { allow: "GET" });
    return;
  }

  if (!file) {
    send(res, 404, "not found");
    return;
  }

  let body;
  try {
    body = await readFile(join(FIXTURE_DIR, file), "utf8");
  } catch {
    // The fixtures are the test workstream's files and may not exist yet.
    send(res, 500, `fixture not readable: ${file}`);
    return;
  }

  const headers = { "content-type": "text/yaml; charset=utf-8" };
  if (file === "upstream.yaml") {
    // Exists so the Worker's subscription-userinfo pass-through can be observed
    // locally. Synthetic numbers only, no account data.
    headers["subscription-userinfo"] = "upload=0; download=0; total=0; expire=0";
  }

  send(res, 200, body, headers);
}

const servers = await Promise.all(
  ports.map(
    (port) =>
      new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          handle(req, res).catch(() => {
            if (!res.headersSent) send(res, 500, "internal error");
          });
        });
        server.once("error", reject);
        server.listen(port, HOST, () => resolve(server));
      }),
  ),
);

for (const file of ROUTES.values()) {
  try {
    await access(join(FIXTURE_DIR, file));
  } catch {
    console.warn(`warning: tests/fixtures/${file} does not exist yet, it will answer 500`);
  }
}

console.log(`source-server up on ${servers.length} ports`);
for (const server of servers) {
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : 0;
  for (const route of ROUTES.keys()) {
    console.log(`http://${HOST}:${boundPort}${route}`);
  }
}

function shutdown() {
  for (const server of servers) server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
