#!/usr/bin/env node
/*
 * filum — local thread server.
 * Serves the static PWA and persists each thread as one JSON file in
 *   ~/.filum/threads/<id>.json  (override with FILUM_THREADS_DIR)
 *
 * Zero dependencies. Node 18+ required.
 */

const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.FILUM_PORT) || 4317;
const THREADS_DIR =
  process.env.FILUM_THREADS_DIR || path.join(os.homedir(), ".filum", "threads");
const STATIC_DIR = __dirname;
const SCHEMA_VERSION = 1;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

async function ensureThreadsDir() {
  await fs.mkdir(THREADS_DIR, { recursive: true });
}

function threadPath(id) {
  return path.join(THREADS_DIR, `${id}.json`);
}

function isValidId(id) {
  return /^[a-z0-9-]{8,64}$/i.test(id);
}

async function readThread(id) {
  const raw = await fs.readFile(threadPath(id), "utf8");
  return JSON.parse(raw);
}

async function writeThread(thread) {
  const tmp = threadPath(thread.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tmp, threadPath(thread.id));
}

async function listThreads() {
  const files = await fs.readdir(THREADS_DIR);
  const items = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(THREADS_DIR, file), "utf8");
      const thread = JSON.parse(raw);
      items.push({
        id: thread.id,
        name: thread.name,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    } catch {
      // skip unreadable or malformed files quietly
    }
  }
  items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return items;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      // Raised from 2 MB to fit a couple of inline image references (data URLs)
      // attached to tasks. See new_features/PRD.md §5.
      if (total > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function emptyState() {
  return { tasks: [], currentStep: "capture", focusIndex: 0 };
}

function nowIso() {
  return new Date().toISOString();
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "threads", maybeId]
  const id = segments[2];

  if (segments[1] !== "threads") {
    return sendError(res, 404, "unknown endpoint");
  }

  if (!id) {
    if (req.method === "GET") {
      const items = await listThreads();
      return sendJson(res, 200, items);
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const thread = {
        id: crypto.randomUUID(),
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled thread",
        schemaVersion: SCHEMA_VERSION,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        state: body.state && typeof body.state === "object" ? body.state : emptyState(),
      };
      await writeThread(thread);
      return sendJson(res, 201, thread);
    }
    res.writeHead(405, { allow: "GET, POST" });
    return res.end();
  }

  if (!isValidId(id)) {
    return sendError(res, 400, "invalid thread id");
  }

  if (req.method === "GET") {
    try {
      const thread = await readThread(id);
      return sendJson(res, 200, thread);
    } catch (err) {
      if (err.code === "ENOENT") return sendError(res, 404, "thread not found");
      throw err;
    }
  }

  if (req.method === "PUT") {
    const body = await readJsonBody(req);
    let existing;
    try {
      existing = await readThread(id);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      existing = null;
    }
    const thread = {
      id,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : existing?.name || "Untitled thread",
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      state: body.state && typeof body.state === "object" ? body.state : existing?.state || emptyState(),
    };
    await writeThread(thread);
    return sendJson(res, 200, thread);
  }

  if (req.method === "DELETE") {
    try {
      await fs.unlink(threadPath(id));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err.code === "ENOENT") return sendError(res, 404, "thread not found");
      throw err;
    }
  }

  res.writeHead(405, { allow: "GET, PUT, DELETE" });
  res.end();
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(STATIC_DIR, target);
  if (!resolved.startsWith(STATIC_DIR)) return null;
  return resolved;
}

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    return res.end();
  }
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      return streamFile(res, indexPath);
    }
    return streamFile(res, filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404);
      return res.end("not found");
    }
    throw err;
  }
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache",
  });
  fssync.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await handleStatic(req, res, url);
    }
  } catch (err) {
    console.error("[filum]", err);
    if (!res.headersSent) sendError(res, 500, "internal error");
    else res.end();
  }
});

(async () => {
  try {
    await ensureThreadsDir();
  } catch (err) {
    console.error(`[filum] could not create threads directory at ${THREADS_DIR}`);
    console.error(err.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`[filum] serving on http://localhost:${PORT}`);
    console.log(`[filum] threads at ${THREADS_DIR}`);
  });
})();
