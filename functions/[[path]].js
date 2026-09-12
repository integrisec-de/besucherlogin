// Portable single-tenant backend for besucherlogin.de (integrisec)
// Runs on BOTH:
//   - Cloudflare Pages Functions  (storage = Workers KV)        -> public demo
//   - Node 24 via server.mjs      (storage = node:sqlite shim)  -> inhouse / VM
//
// The handler only talks to a tiny KV-style interface (get/put/delete/list),
// so the same code works on either backend.
//
// Roles: "admin" (users + settings + visitors) and "user" (visitors only).
//
// KV namespaces (bindings on Cloudflare, SQLite tables on Node):
//   AUTH_KV       user:<name>, config:settings, config:lastPurge
//   SESSIONS_KV   sess:<token>
//   VISITORS_KV   visitor:<id>
//   AUDIT_KV      audit:<ts>:<user>   (optional)

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ------------ Root serves the app ------------
  if (path === "/" && method === "GET") {
    return serveFile(env, context, request, "/index.html");
  }

  // ------------ Demo mode: block admin-config writes ------------
  if (isDemo(env) && isBlockedInDemo(path, method)) return demoBlocked();

  // ------------ AUTH ------------
  if (path === "/auth/login" && method === "POST") return login(env, request);
  if (path === "/auth/logout" && method === "POST") return logout(env, request);
  if (path === "/auth/me" && method === "GET") return whoAmI(env, request);
  if (path === "/auth/change-password" && method === "POST") return changePassword(env, request);

  // ------------ 2FA (TOTP) ------------
  if (path === "/auth/2fa/status" && method === "GET") return twoFactorStatus(env, request);
  if (path === "/auth/2fa/setup" && method === "POST") return twoFactorSetup(env, request);
  if (path === "/auth/2fa/enable" && method === "POST") return twoFactorEnable(env, request);
  if (path === "/auth/2fa/disable" && method === "POST") return twoFactorDisable(env, request);

  if (path === "/auth/audit" && method === "GET") return listAudit(env, request);

  // ------------ User management (admin only) ------------
  if (path === "/auth/users" && method === "GET") return listUsers(env, request);
  if (path === "/auth/users" && method === "POST") return createUser(env, request);
  if (path.startsWith("/auth/users/") && method === "PUT") {
    const username = decodeURIComponent(path.substring("/auth/users/".length));
    return updateUser(env, request, username);
  }
  if (path.startsWith("/auth/users/") && method === "DELETE") {
    const username = decodeURIComponent(path.substring("/auth/users/".length));
    return deleteUser(env, request, username);
  }

  // ------------ Public branding (no auth: login page needs logo/theme) ------------
  if (path === "/branding" && method === "GET") return branding(env);

  // ------------ Settings (admin only): session, retention, branding ------------
  if (path === "/settings" && method === "GET") return getSettingsApi(env, request);
  if (path === "/settings" && method === "PUT") return updateSettings(env, request);

  // ------------ Backup / Restore ------------
  if (path === "/backup" && method === "POST") return downloadBackup(env, request);
  if (path === "/backup/restore" && method === "POST") return restoreBackup(env, request);
  if (path === "/backup/rollback" && method === "POST") return rollbackRestore(env, request);

  // ------------ Visitors (any logged-in user) ------------
  if (path === "/visitors" && method === "GET") return listVisitors(env, request);
  if (path === "/visitors" && method === "POST") return createVisitor(env, request);
  if (path === "/visitors/import" && method === "POST") return importVisitors(env, request);
  if (path.startsWith("/visitors/checkout/") && method === "POST") {
    const id = decodeURIComponent(path.substring("/visitors/checkout/".length));
    return checkoutVisitor(env, request, id);
  }
  if (path.startsWith("/visitors/") && method === "PUT") {
    const id = decodeURIComponent(path.substring("/visitors/".length));
    return updateVisitor(env, request, id);
  }

  // ------------ Don't serve repo tooling / docs as public assets ------------
  if (/^\/(functions|node_modules|\.wrangler|\.claude|\.git)\//.test(path) ||
      /\.(md|toml|mjs)$/i.test(path) ||
      path === "/sbom.cdx.json") {
    return new Response("Not found", { status: 404 });
  }

  // ------------ Static assets fallback ------------
  if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
    return env.ASSETS.fetch(request);
  }
  if (typeof context.next === "function") {
    return context.next();
  }
  return new Response("Not found", { status: 404 });
}

// ====================================================================
// Helpers
// ====================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// Serve a specific static file (used for the apex/demo host split on "/").
function serveFile(env, context, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  const req = new Request(url.toString(), { method: "GET", headers: request.headers });
  if (env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(req);
  if (typeof context.next === "function") return context.next();
  return new Response("Not found", { status: 404 });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ------------ Demo mode ------------
// On the public Cloudflare demo, DEMO=true blocks admin-config changes
// (users / settings / branding / 2FA / password); visitor CRUD stays open.
function isDemo(env) {
  return !!env && (env.DEMO === "true" || env.DEMO === true || env.DEMO === "1");
}

function isBlockedInDemo(path, method) {
  if (path === "/auth/users" && method === "POST") return true;
  if (path.startsWith("/auth/users/") && (method === "PUT" || method === "DELETE")) return true;
  if (path === "/settings" && method === "PUT") return true;
  if (path === "/auth/change-password" && method === "POST") return true;
  if (path.startsWith("/auth/2fa/") && method === "POST") return true;
  if (path.startsWith("/backup")) return true;
  return false;
}

function demoBlocked() {
  return new Response("Demo-Modus: Änderungen am Admin sind deaktiviert.", { status: 403 });
}

// ------------ base64-Helfer (genutzt von Backup/Restore) ------------

function b64ToBytes(b64) {
  const bin = atob((b64 || "").replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------ Backup / Restore (passphrase-encrypted, portable) ------------
const BACKUP_NS = [["auth", "AUTH_KV"], ["visitors", "VISITORS_KV"], ["audit", "AUDIT_KV"]];

async function deriveBackupKey(passphrase, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// blob = salt(16) | iv(12) | AES-GCM ciphertext, base64-encoded
async function encryptBackup(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(28 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return bytesToB64(out);
}

async function decryptBackup(passphrase, b64) {
  const bytes = b64ToBytes(b64);
  const key = await deriveBackupKey(passphrase, bytes.slice(0, 16));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(16, 28) }, key, bytes.slice(28));
  return new TextDecoder().decode(pt);
}

async function listAllKeys(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete === false ? res.cursor : null;
  } while (cursor);
  return keys;
}

async function collectData(env) {
  const data = {};
  for (const [name, binding] of BACKUP_NS) {
    const kv = env[binding];
    data[name] = {};
    for (const key of await listAllKeys(kv, "")) {
      if (key.startsWith("snapshot:")) continue; // internal, not part of a backup
      const v = await kv.get(key);
      if (v != null) data[name][key] = v;
    }
  }
  return data;
}

async function writeData(env, data, wipe) {
  for (const [name, binding] of BACKUP_NS) {
    const kv = env[binding];
    if (wipe) {
      for (const key of await listAllKeys(kv, "")) {
        if (key.startsWith("snapshot:")) continue; // keep the rollback snapshot
        await kv.delete(key);
      }
    }
    const ns = (data && data[name]) || {};
    for (const key of Object.keys(ns)) await kv.put(key, ns[key]);
  }
}

const DEFAULT_THEME = {
  primary: "#1a4fd6",  // Buttons, Links
  accent:  "#00c896",  // Akzent / Highlights
  dark:    "#0e1e3d",  // Topbar, Überschriften
  bg:      "#f4f7fb",  // Seitenhintergrund
  text:    "#18243a"   // Fließtext
};

const DEFAULT_SETTINGS = {
  sessionTtlMinutes: 480,
  retentionEnabled: true,
  retentionDays: 90,
  logoUrl: "",
  theme: { ...DEFAULT_THEME }
};

async function getSettings(env) {
  const s = await env.AUTH_KV.get("config:settings", { type: "json" }) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    theme: { ...DEFAULT_THEME, ...(s.theme || {}) }
  };
}

// ====================================================================
// Sessions
// ====================================================================

async function getSession(env, request) {
  const token = request.headers.get("x-session-token");
  if (!token) return null;
  const raw = await env.SESSIONS_KV.get("sess:" + token, { type: "json" });
  if (!raw) return null;
  if (raw.expiresAt && Date.now() > raw.expiresAt) {
    await env.SESSIONS_KV.delete("sess:" + token);
    return null;
  }
  return { token, ...raw };
}

async function createSession(env, user, settings) {
  const token = crypto.randomUUID();
  const ttlMinutes = (settings && settings.sessionTtlMinutes) || 480;
  const ttlMs = ttlMinutes * 60_000;
  const now = Date.now();

  const session = {
    username: user.username,
    role: user.role || "user",
    createdAt: now,
    expiresAt: now + ttlMs
  };

  await env.SESSIONS_KV.put("sess:" + token, JSON.stringify(session), {
    expirationTtl: Math.ceil(ttlMs / 1000)
  });

  return { token, ...session };
}

async function destroySession(env, request) {
  const token = request.headers.get("x-session-token");
  if (token) {
    await env.SESSIONS_KV.delete("sess:" + token);
  }
}

// Any valid, non-expired session
async function requireSession(env, request) {
  return getSession(env, request);
}

// Session with role === "admin"
export async function requireAdmin(env, request) {
  const session = await getSession(env, request);
  if (!session) return null;
  if (session.role !== "admin") return null;
  return session;
}

// ----- Password hashing (PBKDF2-SHA256, salted) -----

async function hashPasswordSha256(pw) {
  const enc = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(pw) {
  const enc = new TextEncoder().encode(pw);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;

  const key = await crypto.subtle.importKey(
    "raw", enc, { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key, 256
  );
  const hashBytes = new Uint8Array(bits);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  return "pbkdf2:" + iterations + ":" + saltHex + ":" + hashHex;
}

async function verifyPassword(pw, expectedHash) {
  if (!expectedHash) return false;

  if (expectedHash.startsWith("pbkdf2:")) {
    try {
      const parts = expectedHash.split(":");
      if (parts.length !== 4) return false;
      const iterations = parseInt(parts[1], 10);
      if (!Number.isFinite(iterations) || iterations <= 0) return false;
      const saltHex = parts[2];
      const hashHex = parts[3];

      const saltBytes = new Uint8Array(saltHex.length / 2);
      for (let i = 0; i < saltBytes.length; i++) {
        saltBytes[i] = parseInt(saltHex.substr(i * 2, 2), 16);
      }

      const enc = new TextEncoder().encode(pw);
      const key = await crypto.subtle.importKey(
        "raw", enc, { name: "PBKDF2" }, false, ["deriveBits"]
      );
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
        key, 256
      );
      const hashBytes = new Uint8Array(bits);
      const calcHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      return calcHex === hashHex;
    } catch (e) {
      console.error("PBKDF2 verify error", e);
      return false;
    }
  }

  // Legacy SHA-256 hashes (no prefix)
  const legacy = await hashPasswordSha256(pw);
  return legacy === expectedHash;
}

// ====================================================================
// TOTP (RFC 6238) — optional second factor
// ====================================================================

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = (str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

function totpAuthUri(username, secret, issuer) {
  const label = encodeURIComponent(issuer + ":" + username);
  return "otpauth://totp/" + label +
    "?secret=" + secret +
    "&issuer=" + encodeURIComponent(issuer) +
    "&algorithm=SHA1&digits=6&period=30";
}

async function hotp(keyBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return (code % 1000000).toString().padStart(6, "0");
}

// Verify a 6-digit token, allowing +/-1 step (~30s) for clock drift.
async function verifyTotp(secret, token, window = 1) {
  if (!secret || !/^\d{6}$/.test(token || "")) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    if (await hotp(key, counter + w) === token) return true;
  }
  return false;
}

// Audit (optional)
async function audit(env, entry) {
  if (!env.AUDIT_KV) return;
  try {
    const ts = Date.now();
    const key = "audit:" + ts + ":" + (entry.username || "system");
    const data = { timestamp: ts, ...entry };
    await env.AUDIT_KV.put(key, JSON.stringify(data));
  } catch {
    // ignore audit errors
  }
}

// ====================================================================
// AUTH
// ====================================================================

async function login(env, request) {
  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  const username = (body.username || "").trim();
  const password = body.password || "";

  const user = await env.AUTH_KV.get("user:" + username, { type: "json" });
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.disabled) return new Response("Disabled", { status: 403 });

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await audit(env, { username, action: "auth.login.failed", details: "Wrong password" });
    return new Response("Unauthorized", { status: 401 });
  }

  // Second factor (TOTP), if enabled for this user
  if (user.twoFactorEnabled) {
    const code = (body.code || "").trim();
    if (!code) return jsonResponse({ error: "2fa_required" }, 401);
    if (!(await verifyTotp(user.totpSecret, code))) {
      await audit(env, { username, action: "auth.login.2fa_failed", details: "" });
      return jsonResponse({ error: "2fa_invalid" }, 401);
    }
  }

  const settings = await getSettings(env);
  const session = await createSession(env, user, settings);
  await audit(env, { username: user.username, action: "auth.login.success", details: "Login ok" });

  return jsonResponse({
    token: session.token,
    username: user.username,
    role: user.role || "user"
  });
}

async function logout(env, request) {
  const session = await getSession(env, request);
  if (session) {
    await audit(env, { username: session.username, action: "auth.logout", details: "" });
  }
  await destroySession(env, request);
  return jsonResponse({ ok: true });
}

async function whoAmI(env, request) {
  const session = await getSession(env, request);
  return jsonResponse({ session: session || null });
}

async function changePassword(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  const oldPassword = body.oldPassword || "";
  const newPassword = body.newPassword || "";
  if (!newPassword || newPassword.length < 6) {
    return new Response("Neues Passwort zu kurz (mind. 6 Zeichen)", { status: 400 });
  }

  const user = await env.AUTH_KV.get("user:" + session.username, { type: "json" });
  if (!user) return new Response("Not found", { status: 404 });

  const ok = await verifyPassword(oldPassword, user.passwordHash);
  if (!ok) return new Response("Altes Passwort falsch", { status: 403 });

  user.passwordHash = await hashPassword(newPassword);
  await env.AUTH_KV.put("user:" + session.username, JSON.stringify(user));
  await destroySession(env, request);
  await audit(env, { username: session.username, action: "auth.change-password", details: "" });

  return jsonResponse({ ok: true });
}

// ====================================================================
// 2FA (TOTP) – per-account enrollment
// ====================================================================

async function twoFactorStatus(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const user = await env.AUTH_KV.get("user:" + session.username, { type: "json" });
  return jsonResponse({ enabled: !!(user && user.twoFactorEnabled) });
}

async function twoFactorSetup(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const user = await env.AUTH_KV.get("user:" + session.username, { type: "json" });
  if (!user) return new Response("Not found", { status: 404 });

  const secret = generateTotpSecret();
  user.pendingTotpSecret = secret;
  await env.AUTH_KV.put("user:" + session.username, JSON.stringify(user));

  return jsonResponse({
    secret,
    otpauthUri: totpAuthUri(session.username, secret, "Besucherlogin")
  });
}

async function twoFactorEnable(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = await readJson(request);
  const code = ((body && body.code) || "").trim();

  const user = await env.AUTH_KV.get("user:" + session.username, { type: "json" });
  if (!user || !user.pendingTotpSecret) return new Response("Kein 2FA-Setup aktiv", { status: 400 });
  if (!(await verifyTotp(user.pendingTotpSecret, code))) return new Response("Code ungültig", { status: 400 });

  user.totpSecret = user.pendingTotpSecret;
  user.twoFactorEnabled = true;
  delete user.pendingTotpSecret;
  await env.AUTH_KV.put("user:" + session.username, JSON.stringify(user));
  await audit(env, { username: session.username, action: "auth.2fa.enable", details: "" });

  return jsonResponse({ ok: true });
}

async function twoFactorDisable(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = await readJson(request);
  const code = ((body && body.code) || "").trim();

  const user = await env.AUTH_KV.get("user:" + session.username, { type: "json" });
  if (!user) return new Response("Not found", { status: 404 });
  if (user.twoFactorEnabled && !(await verifyTotp(user.totpSecret, code))) {
    return new Response("Code ungültig", { status: 400 });
  }

  user.twoFactorEnabled = false;
  delete user.totpSecret;
  delete user.pendingTotpSecret;
  await env.AUTH_KV.put("user:" + session.username, JSON.stringify(user));
  await audit(env, { username: session.username, action: "auth.2fa.disable", details: "" });

  return jsonResponse({ ok: true });
}

// ====================================================================
// User management (admin)
// ====================================================================

async function listUsers(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  const list = await env.AUTH_KV.list({ prefix: "user:" });
  const users = [];
  for (const k of list.keys) {
    const u = await env.AUTH_KV.get(k.name, { type: "json" });
    if (!u) continue;
    users.push({
      username: u.username,
      role: u.role || "user",
      disabled: !!u.disabled
    });
  }
  users.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
  return jsonResponse(users);
}

async function createUser(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  const username = (body.username || "").trim();
  const password = body.password || "";
  const role = (body.role || "user").trim();

  if (!username || !password) {
    return new Response("Username + Passwort erforderlich", { status: 400 });
  }
  const allowedRoles = ["user", "admin"];
  if (!allowedRoles.includes(role)) {
    return new Response("Ungültige Rolle", { status: 400 });
  }

  const existing = await env.AUTH_KV.get("user:" + username);
  if (existing) return new Response("Benutzer existiert bereits", { status: 400 });

  const user = {
    username,
    passwordHash: await hashPassword(password),
    role,
    disabled: false,
    createdAt: Date.now()
  };

  await env.AUTH_KV.put("user:" + username, JSON.stringify(user));
  await audit(env, { username: session.username, action: "auth.user.create", details: "user=" + username + ";role=" + role });

  return jsonResponse({ ok: true });
}

async function updateUser(env, request, username) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  const key = "user:" + username;
  const existing = await env.AUTH_KV.get(key, { type: "json" });
  if (!existing) return new Response("Not found", { status: 404 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  if (body.password) {
    existing.passwordHash = await hashPassword(body.password);
  }
  if (body.role) {
    const allowedRoles = ["user", "admin"];
    if (!allowedRoles.includes(body.role)) {
      return new Response("Ungültige Rolle", { status: 400 });
    }
    // never let the seeded admin lose its admin role
    if (username !== "admin") existing.role = body.role;
  }
  if (body.disabled !== undefined && username !== "admin") {
    existing.disabled = !!body.disabled;
  }

  await env.AUTH_KV.put(key, JSON.stringify(existing));
  await audit(env, { username: session.username, action: "auth.user.update", details: "user=" + username });

  return jsonResponse({ ok: true });
}

async function deleteUser(env, request, username) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  if (username === "admin") {
    return new Response("System-Admin kann nicht gelöscht werden", { status: 400 });
  }

  const key = "user:" + username;
  const existing = await env.AUTH_KV.get(key, { type: "json" });
  if (!existing) return new Response("Not found", { status: 404 });

  await env.AUTH_KV.delete(key);
  await audit(env, { username: session.username, action: "auth.user.delete", details: "user=" + username });

  return jsonResponse({ ok: true });
}

// ====================================================================
// Settings (admin): session timeout + data retention
// ====================================================================

// Public, unauthenticated: logo + color palette (needed before login).
async function branding(env) {
  const s = await getSettings(env);
  return new Response(JSON.stringify({ logoUrl: s.logoUrl || "", theme: s.theme, demo: isDemo(env) }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function getSettingsApi(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });
  return jsonResponse(await getSettings(env));
}

// ------------ Backup API ------------

async function downloadBackup(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });
  const body = await readJson(request);
  const passphrase = (body && body.passphrase) || "";
  if (passphrase.length < 6) return new Response("Passphrase zu kurz (mind. 6 Zeichen)", { status: 400 });

  const backup = { v: 1, createdAt: Date.now(), data: await collectData(env) };
  const b64 = await encryptBackup(passphrase, JSON.stringify(backup));
  await audit(env, { username: session.username, action: "backup.download", details: "" });
  return jsonResponse({
    filename: "besucherlogin-backup-" + new Date(backup.createdAt).toISOString().slice(0, 10) + ".bak",
    backup: b64
  });
}

async function restoreBackup(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });
  const body = await readJson(request);
  const passphrase = (body && body.passphrase) || "";
  const b64 = (body && body.backup) || "";
  if (!passphrase || !b64) return new Response("Passphrase und Backup erforderlich", { status: 400 });

  let backup;
  try {
    backup = JSON.parse(await decryptBackup(passphrase, b64));
  } catch {
    return new Response("Entschlüsselung fehlgeschlagen (falsche Passphrase oder beschädigtes Backup)", { status: 400 });
  }
  if (!backup || !backup.data) return new Response("Ungültiges Backup", { status: 400 });

  // pre-restore safety snapshot (survives the wipe; used by /backup/rollback)
  await env.AUTH_KV.put("snapshot:preRestore", JSON.stringify({ at: Date.now(), data: await collectData(env) }));
  await writeData(env, backup.data, true);
  await audit(env, { username: session.username, action: "backup.restore", details: "from=" + (backup.createdAt || "") });
  return jsonResponse({ ok: true, restoredFrom: backup.createdAt || null });
}

async function rollbackRestore(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });
  const snap = await env.AUTH_KV.get("snapshot:preRestore", { type: "json" });
  if (!snap || !snap.data) return new Response("Kein Wiederherstellungs-Snapshot vorhanden", { status: 400 });
  await writeData(env, snap.data, true);
  await audit(env, { username: session.username, action: "backup.rollback", details: "" });
  return jsonResponse({ ok: true });
}

async function updateSettings(env, request) {
  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  const current = await getSettings(env);
  const next = { ...current };

  if (body.sessionTtlMinutes !== undefined) {
    const m = parseInt(body.sessionTtlMinutes, 10);
    if (!Number.isFinite(m) || m <= 0) return new Response("Ungültiger Session-Timeout", { status: 400 });
    next.sessionTtlMinutes = m;
  }
  if (body.retentionEnabled !== undefined) {
    next.retentionEnabled = !!body.retentionEnabled;
  }
  if (body.retentionDays !== undefined) {
    const d = parseInt(body.retentionDays, 10);
    if (!Number.isFinite(d) || d <= 0) return new Response("Ungültige Aufbewahrungsfrist", { status: 400 });
    next.retentionDays = d;
  }
  if (body.logoUrl !== undefined) {
    next.logoUrl = String(body.logoUrl || "").trim().slice(0, 600);
  }
  if (body.theme && typeof body.theme === "object") {
    const hex = /^#[0-9a-fA-F]{6}$/;
    const t = { ...next.theme };
    for (const key of ["primary", "accent", "dark", "bg", "text"]) {
      if (body.theme[key] !== undefined) {
        if (!hex.test(body.theme[key])) return new Response("Ungültiger Hex-Wert: " + key, { status: 400 });
        t[key] = body.theme[key];
      }
    }
    next.theme = t;
  }

  await env.AUTH_KV.put("config:settings", JSON.stringify(next));
  await audit(env, {
    username: session.username,
    action: "settings.update",
    details: "retention=" + (next.retentionEnabled ? next.retentionDays + "d" : "off") + ";sessionTtl=" + next.sessionTtlMinutes
  });

  return jsonResponse(next);
}

// ====================================================================
// Visitors
// ====================================================================

async function listVisitors(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  await maybePurge(env);

  const list = await env.VISITORS_KV.list({ prefix: "visitor:" });
  const visitors = [];
  for (const k of list.keys) {
    const v = await env.VISITORS_KV.get(k.name, { type: "json" });
    if (v) visitors.push(v);
  }
  visitors.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return jsonResponse(visitors);
}

async function createVisitor(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  if (!(body.name || "").trim() || !(body.firma || "").trim()
      || !(body.ansprechpartner || body.ansprech || "").trim() || !(body.grund || "").trim()) {
    return new Response("Name, Firma, Ansprechpartner und Grund sind Pflichtfelder.", { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const visitor = {
    id,
    name: body.name || "",
    firma: body.firma || "",
    ansprechpartner: body.ansprechpartner || body.ansprech || "",
    grund: body.grund || "",
    ausweisnummer: body.ausweisnummer || "",
    timestamp: now,
    checkin: now,
    checkout: null,
    createdBy: session.username || ""
  };

  await env.VISITORS_KV.put("visitor:" + id, JSON.stringify(visitor));
  await audit(env, { username: session.username, action: "visitor.create", details: "id=" + id });

  return jsonResponse(visitor, 201);
}

// Bulk import (additive) — rows: [{name, firma, ansprechpartner, grund, ausweisnummer, checkin?, checkout?}]
async function importVisitors(env, request) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await readJson(request);
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return new Response("Keine Datensätze", { status: 400 });
  if (rows.length > 5000) return new Response("Zu viele Datensätze (max. 5000)", { status: 400 });

  let imported = 0;
  for (const r of rows) {
    if (!r || !(r.name || "").trim()) continue;
    const id = crypto.randomUUID();
    const checkin = Date.parse(r.checkin || "");
    const ts = Number.isFinite(checkin) ? checkin : Date.now();
    const checkout = Date.parse(r.checkout || "");
    await env.VISITORS_KV.put("visitor:" + id, JSON.stringify({
      id,
      name: (r.name || "").trim(),
      firma: (r.firma || "").trim(),
      ansprechpartner: (r.ansprechpartner || "").trim(),
      grund: (r.grund || "").trim(),
      ausweisnummer: (r.ausweisnummer || "").trim(),
      timestamp: ts,
      checkin: ts,
      checkout: Number.isFinite(checkout) ? checkout : null,
      createdBy: session.username || "(Import)"
    }));
    imported++;
  }
  await audit(env, { username: session.username, action: "visitor.import", details: "count=" + imported });
  return jsonResponse({ ok: true, imported });
}

async function updateVisitor(env, request, id) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const key = "visitor:" + id;
  const existing = await env.VISITORS_KV.get(key, { type: "json" });
  if (!existing) return new Response("Not found", { status: 404 });
  if (existing.checkout) return new Response("Schon ausgecheckt", { status: 400 });

  const body = await readJson(request);
  if (!body) return new Response("Bad JSON", { status: 400 });

  existing.name = body.name ?? existing.name;
  existing.firma = body.firma ?? existing.firma;
  existing.ansprechpartner = body.ansprechpartner ?? body.ansprech ?? existing.ansprechpartner;
  existing.grund = body.grund ?? existing.grund;
  existing.ausweisnummer = body.ausweisnummer ?? existing.ausweisnummer;

  await env.VISITORS_KV.put(key, JSON.stringify(existing));
  await audit(env, { username: session.username, action: "visitor.update", details: "id=" + id });

  return jsonResponse(existing);
}

async function checkoutVisitor(env, request, id) {
  const session = await requireSession(env, request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const key = "visitor:" + id;
  const existing = await env.VISITORS_KV.get(key, { type: "json" });
  if (!existing) return new Response("Not found", { status: 404 });
  if (existing.checkout) return new Response("Schon ausgecheckt", { status: 400 });

  existing.checkout = Date.now();
  await env.VISITORS_KV.put(key, JSON.stringify(existing));
  await audit(env, { username: session.username, action: "visitor.checkout", details: "id=" + id });

  return jsonResponse(existing);
}

// ====================================================================
// Data retention (DSGVO Speicherbegrenzung)
// ====================================================================

// Delete visitor records whose check-in is older than the retention window.
export async function purgeOldVisitors(env) {
  const settings = await getSettings(env);
  if (!settings.retentionEnabled) return 0;

  const days = settings.retentionDays || 90;
  const cutoff = Date.now() - days * 86_400_000;

  const list = await env.VISITORS_KV.list({ prefix: "visitor:" });
  let deleted = 0;
  for (const k of list.keys) {
    const v = await env.VISITORS_KV.get(k.name, { type: "json" });
    if (!v) continue;
    const ref = v.timestamp || v.checkin || 0;
    if (ref && ref < cutoff) {
      await env.VISITORS_KV.delete(k.name);
      deleted++;
    }
  }
  return deleted;
}

// Throttled lazy purge (used on Cloudflare where there is no always-on process).
// Runs at most once per hour.
async function maybePurge(env) {
  try {
    const last = await env.AUTH_KV.get("config:lastPurge");
    const lastTs = last ? parseInt(last, 10) : 0;
    if (Date.now() - lastTs < 3_600_000) return;
    await env.AUTH_KV.put("config:lastPurge", String(Date.now()));
    await purgeOldVisitors(env);
  } catch {
    // ignore purge errors
  }
}

// ====================================================================
// Audit log (admin)
// ====================================================================

async function listAudit(env, request) {
  if (!env.AUDIT_KV) return jsonResponse([]);

  const session = await requireAdmin(env, request);
  if (!session) return new Response("Forbidden", { status: 403 });

  const list = await env.AUDIT_KV.list({ prefix: "audit:" });
  const entries = [];
  for (const k of list.keys) {
    const entry = await env.AUDIT_KV.get(k.name, { type: "json" });
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return jsonResponse(entries.slice(0, 50));
}
