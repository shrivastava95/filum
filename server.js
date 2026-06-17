#!/usr/bin/env node
/*
 * filum — local thread server.
 * In auth mode it verifies Google sign-ins and stores user records encrypted
 * at rest. Thread payloads are opaque client-side encrypted blobs.
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

loadEnvFile(path.join(__dirname, ".env"));
loadEnvFile(path.join(__dirname, ".env.local"));

const PORT = Number(process.env.FILUM_PORT) || 4317;
const STATIC_DIR = __dirname;
const DATA_DIR = process.env.FILUM_DATA_DIR || path.join(os.homedir(), ".filum");
const LEGACY_THREADS_DIR = process.env.FILUM_THREADS_DIR || path.join(DATA_DIR, "threads");
const USERS_ROOT = path.join(DATA_DIR, "users");
const USERS_FILE = path.join(DATA_DIR, "users.json.enc");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json.enc");
const MASTER_KEY = loadMasterKey();
const AUTH_ENABLED = Boolean(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_COOKIE = "filum_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 3;

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

const authStore = {
  users: [],
  sessions: [],
};

async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(USERS_ROOT, { recursive: true });
  await fs.mkdir(LEGACY_THREADS_DIR, { recursive: true });
}

function loadMasterKey() {
  const raw = (process.env.FILUM_MASTER_KEY || process.env.FILUM_DATA_KEY || "").trim();
  if (raw) {
    const normalized = raw.startsWith("base64:") ? raw.slice(7) : raw;
    const key = /^[0-9a-fA-F]{64}$/.test(normalized)
      ? Buffer.from(normalized, "hex")
      : Buffer.from(normalized, "base64");
    if (key.length !== 32) {
      throw new Error("FILUM_MASTER_KEY must decode to exactly 32 bytes");
    }
    return key;
  }

  const keyPath = path.join(DATA_DIR, "master.key");
  try {
    const stored = fssync.readFileSync(keyPath, "utf8").trim();
    const key = /^[0-9a-fA-F]{64}$/.test(stored)
      ? Buffer.from(stored, "hex")
      : Buffer.from(stored, "base64");
    if (key.length !== 32) {
      throw new Error("invalid key length");
    }
    return key;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const key = crypto.randomBytes(32);
    fssync.mkdirSync(DATA_DIR, { recursive: true });
    fssync.writeFileSync(keyPath, key.toString("base64url"), { mode: 0o600 });
    return key;
  }
}

function loadEnvFile(filePath) {
  try {
    const raw = fssync.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function threadPath(id) {
  return path.join(LEGACY_THREADS_DIR, `${id}.json`);
}

function userThreadsDir(userId) {
  return path.join(USERS_ROOT, userId, "threads");
}

function userThreadPath(userId, id) {
  return path.join(userThreadsDir(userId), `${id}.json.enc`);
}

function isValidId(id) {
  return /^[a-z0-9-]{8,64}$/i.test(id);
}

function nowIso() {
  return new Date().toISOString();
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

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function secretHash(value, label) {
  return crypto.createHmac("sha256", MASTER_KEY).update(label).update("\0").update(value).digest("hex");
}

function emptyState() {
  return { tasks: [], currentStep: "capture", focusIndex: 0 };
}

function encryptObject(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: base64url(iv),
    tag: base64url(tag),
    data: base64url(ciphertext),
  };
}

function decryptObject(payload, fallback = null) {
  if (!payload || typeof payload !== "object") return fallback;
  if (payload.v !== 1 || typeof payload.iv !== "string" || typeof payload.tag !== "string" || typeof payload.data !== "string") {
    return fallback;
  }
  try {
    const iv = Buffer.from(payload.iv, "base64url");
    const tag = Buffer.from(payload.tag, "base64url");
    const data = Buffer.from(payload.data, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    return fallback;
  }
}

async function readEncryptedFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return decryptObject(JSON.parse(raw), fallback);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writeEncryptedFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(encryptObject(value), null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function loadAuthStore() {
  const users = await readEncryptedFile(USERS_FILE, { version: 1, users: [] });
  const sessions = await readEncryptedFile(SESSIONS_FILE, { version: 1, sessions: [] });
  authStore.users = Array.isArray(users.users) ? users.users : [];
  authStore.sessions = Array.isArray(sessions.sessions) ? sessions.sessions : [];
}

async function saveUsersStore() {
  await writeEncryptedFile(USERS_FILE, { version: 1, users: authStore.users });
}

async function saveSessionsStore() {
  await writeEncryptedFile(SESSIONS_FILE, { version: 1, sessions: authStore.sessions });
}

function rebuildAuthIndexes() {
  authStore.usersById = new Map(authStore.users.map((user) => [user.id, user]));
  authStore.usersBySubHash = new Map(authStore.users.map((user) => [user.googleSubHash, user]));
  authStore.sessionsByHash = new Map(authStore.sessions.map((session) => [session.tokenHash, session]));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.profile?.name || "Google user",
    email: user.profile?.email || "",
    picture: user.profile?.picture || "",
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const chunk of header.split(";")) {
    const index = chunk.indexOf("=");
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function setSessionCookie(res, token, expiresAt, secure) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, secure) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requestIsSecure(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https" || Boolean(req.socket.encrypted);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
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

async function readLegacyThread(id) {
  const raw = await fs.readFile(threadPath(id), "utf8");
  return JSON.parse(raw);
}

async function writeLegacyThread(thread) {
  const tmp = threadPath(thread.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tmp, threadPath(thread.id));
}

async function listLegacyThreads() {
  const files = await fs.readdir(LEGACY_THREADS_DIR);
  const items = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(LEGACY_THREADS_DIR, file), "utf8");
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

async function listUserThreads(userId) {
  const dir = userThreadsDir(userId);
  try {
    const files = await fs.readdir(dir);
    const items = [];
    for (const file of files) {
      if (!file.endsWith(".json.enc")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        const thread = JSON.parse(raw);
        if (!thread || thread.encrypted !== true) continue;
        items.push({
          id: thread.id,
          name: thread.name || "Locked thread",
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          encrypted: true,
        });
      } catch {
        // skip unreadable or malformed files quietly
      }
    }
    items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return items;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function readUserThread(userId, id) {
  const raw = await fs.readFile(userThreadPath(userId, id), "utf8");
  return JSON.parse(raw);
}

async function writeUserThread(userId, thread) {
  const filePath = userThreadPath(userId, thread.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function deleteUserThread(userId, id) {
  await fs.unlink(userThreadPath(userId, id));
}

async function getSessionUser(req) {
  if (!AUTH_ENABLED) return null;
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = secretHash(token, "session");
  const session = authStore.sessionsByHash.get(tokenHash);
  if (!session) return null;
  if (!session.expiresAt || Date.now() > Date.parse(session.expiresAt)) {
    authStore.sessions = authStore.sessions.filter((entry) => entry.tokenHash !== tokenHash);
    rebuildAuthIndexes();
    await saveSessionsStore();
    return null;
  }
  return authStore.usersById.get(session.userId) || null;
}

async function issueSession(userId, req, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tokenHash = secretHash(token, "session");
  authStore.sessions = authStore.sessions.filter((entry) => entry.tokenHash !== tokenHash);
  authStore.sessions.push({
    tokenHash,
    userId,
    createdAt: nowIso(),
    expiresAt,
  });
  rebuildAuthIndexes();
  await saveSessionsStore();
  setSessionCookie(res, token, expiresAt, requestIsSecure(req));
}

async function clearSession(req, res) {
  if (!AUTH_ENABLED) return;
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const tokenHash = secretHash(token, "session");
    authStore.sessions = authStore.sessions.filter((entry) => entry.tokenHash !== tokenHash);
    rebuildAuthIndexes();
    await saveSessionsStore();
  }
  clearSessionCookie(res, requestIsSecure(req));
}

async function verifyGoogleCredential(credential) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!response.ok) {
    throw new Error("Google token verification failed");
  }
  const claims = await response.json();
  const aud = claims.aud || "";
  const iss = String(claims.iss || "");
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const expiresAt = Number(claims.exp || 0) * 1000;
  if (aud !== GOOGLE_CLIENT_ID) {
    throw new Error("Google token audience mismatch");
  }
  if (!emailVerified) {
    throw new Error("Google email not verified");
  }
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") {
    throw new Error("Invalid Google issuer");
  }
  if (!claims.sub || !claims.email) {
    throw new Error("Incomplete Google profile");
  }
  if (Number.isFinite(expiresAt) && expiresAt && expiresAt < Date.now()) {
    throw new Error("Google token expired");
  }
  return claims;
}

async function upsertGoogleUser(claims) {
  const subHash = secretHash(String(claims.sub), "google-sub");
  let user = authStore.usersBySubHash.get(subHash) || null;
  const profile = {
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : "Google user",
    email: typeof claims.email === "string" ? claims.email.trim() : "",
    picture: typeof claims.picture === "string" ? claims.picture : "",
  };

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      provider: "google",
      googleSubHash: subHash,
      profile,
      createdAt: nowIso(),
      lastLoginAt: nowIso(),
    };
    authStore.users.push(user);
  } else {
    user.profile = profile;
    user.lastLoginAt = nowIso();
  }

  rebuildAuthIndexes();
  await saveUsersStore();
  return user;
}

async function handleAuthGoogle(req, res) {
  if (!AUTH_ENABLED) {
    return sendError(res, 400, "auth is not enabled on this server");
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }
  const body = await readJsonBody(req);
  const credential = typeof body.credential === "string" ? body.credential.trim() : "";
  if (!credential) {
    return sendError(res, 400, "missing Google credential");
  }
  const claims = await verifyGoogleCredential(credential);
  const user = await upsertGoogleUser(claims);
  await issueSession(user.id, req, res);
  return sendJson(res, 200, { user: publicUser(user) });
}

async function handleAuthLogout(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }
  await clearSession(req, res);
  return sendJson(res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "threads", maybeId]
  const resource = segments[1];
  const id = segments[2];

  if (resource === "config") {
    const user = await getSessionUser(req);
    return sendJson(res, 200, {
      authEnabled: AUTH_ENABLED,
      googleClientId: AUTH_ENABLED ? GOOGLE_CLIENT_ID : null,
      user: publicUser(user),
    });
  }

  if (resource === "me") {
    const user = await getSessionUser(req);
    if (!user) return sendError(res, 401, "not signed in");
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (resource === "threads") {
    const user = AUTH_ENABLED ? await getSessionUser(req) : null;
    if (AUTH_ENABLED && !user) {
      return sendError(res, 401, "sign in required");
    }
    const userId = user ? user.id : null;

    if (!id) {
      if (req.method === "GET") {
        const items = AUTH_ENABLED ? await listUserThreads(userId) : await listLegacyThreads();
        return sendJson(res, 200, items);
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const thread = {
          id: crypto.randomUUID(),
          encrypted: Boolean(body.encrypted),
          name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Locked thread",
          schemaVersion: SCHEMA_VERSION,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          payload: body.payload && typeof body.payload === "object" ? body.payload : null,
        };
        if (AUTH_ENABLED) {
          await writeUserThread(userId, thread);
        } else {
          await writeLegacyThread(thread);
        }
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
        const thread = AUTH_ENABLED ? await readUserThread(userId, id) : await readLegacyThread(id);
        if (!thread) return sendError(res, 404, "thread not found");
        return sendJson(res, 200, thread);
      } catch (err) {
        if (err.code === "ENOENT") return sendError(res, 404, "thread not found");
        throw err;
      }
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      let existing = null;
      try {
        existing = AUTH_ENABLED ? await readUserThread(userId, id) : await readLegacyThread(id);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      const thread = {
        id,
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : existing?.name || "Locked thread",
        encrypted: Boolean(body.encrypted ?? existing?.encrypted),
        schemaVersion: SCHEMA_VERSION,
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso(),
        payload: body.payload && typeof body.payload === "object" ? body.payload : existing?.payload || null,
      };
      if (AUTH_ENABLED) {
        await writeUserThread(userId, thread);
      } else {
        await writeLegacyThread(thread);
      }
      return sendJson(res, 200, thread);
    }

    if (req.method === "DELETE") {
      try {
        if (AUTH_ENABLED) {
          await deleteUserThread(userId, id);
        } else {
          await fs.unlink(threadPath(id));
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err.code === "ENOENT") return sendError(res, 404, "thread not found");
        throw err;
      }
    }

    res.writeHead(405, { allow: "GET, PUT, DELETE" });
    return res.end();
  }

  return sendError(res, 404, "unknown endpoint");
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
    if (url.pathname === "/api/config" || url.pathname === "/api/me") {
      await handleApi(req, res, url);
    } else if (url.pathname === "/auth/google") {
      await handleAuthGoogle(req, res);
    } else if (url.pathname === "/auth/logout") {
      await handleAuthLogout(req, res);
    } else if (url.pathname.startsWith("/api/")) {
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
    await ensureDataDirs();
    if (AUTH_ENABLED) {
      await loadAuthStore();
      rebuildAuthIndexes();
    } else {
      // Keep the anonymous/local mode data shape working for the original PWA flow.
      await fs.mkdir(LEGACY_THREADS_DIR, { recursive: true });
    }
  } catch (err) {
    console.error(`[filum] could not initialize data directories under ${DATA_DIR}`);
    console.error(err.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`[filum] serving on http://localhost:${PORT}`);
    console.log(`[filum] data at ${DATA_DIR}`);
    if (AUTH_ENABLED) {
      console.log("[filum] auth mode enabled");
    } else {
      console.log("[filum] auth mode disabled");
    }
  });
})();
