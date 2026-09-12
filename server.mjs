// Inhouse / on-prem entrypoint.
//
// Runs the SAME request handler as Cloudflare Pages (functions/[[path]].js),
// but backs it with a local SQLite file instead of Workers KV and serves the
// static HTML/CSS/asset files itself. No external services, no CDN.
//
// Start:  node --experimental-sqlite server.mjs
//   PORT            (default 8787)
//   DB_PATH         (default ./besucher.db)
//   ADMIN_PASSWORD  (initial admin password on first run, default "admin")
//   TLS_DIR         (cert.pem/key.pem für eingebautes HTTPS; Default <DB-Verzeichnis>/tls)
//
// HTTPS wird direkt hier terminiert (kein Reverse-Proxy nötig): liegt ein Zertifikat
// im TLS_DIR, läuft HTTPS auf HTTPS_PORT und HTTP leitet dorthin um.

import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

import { onRequest, hashPassword, purgeOldVisitors, requireAdmin } from "./functions/[[path]].js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8787", 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "8443", 10);
const DB_PATH = process.env.DB_PATH || join(ROOT, "besucher.db");
const TLS_DIR = process.env.TLS_DIR || join(dirname(DB_PATH), "tls");
const TLS_CERT = join(TLS_DIR, "cert.pem");
const TLS_KEY = join(TLS_DIR, "key.pem");

// ---------------------------------------------------------------- SQLite KV
const db = new DatabaseSync(DB_PATH);

// Robustheit im Appliance-Betrieb: WAL übersteht unsaubere Container-Stopps
// deutlich besser, Busy-Timeout entschärft parallele Lese-/Backup-Zugriffe.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    ns         TEXT    NOT NULL,
    k          TEXT    NOT NULL,
    v          TEXT    NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (ns, k)
  );
`);

// Idempotente, vorwärts-gerichtete Schema-Migrationen (PRAGMA user_version).
// Regel: NUR additiv (Spalten/Tabellen/Indizes ergänzen) – nie droppen oder
// umbenennen, damit ein Rollback auf ein älteres Image die DB weiterlesen kann.
const MIGRATIONS = [
  // Index i erzeugt user_version = i + 1. Beispiel v1:
  // (d) => d.exec("CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at);"),
];
{
  const cur = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i](db);
    db.exec(`PRAGMA user_version = ${i + 1};`);
  }
}

const stmtGet = db.prepare("SELECT v, expires_at FROM kv WHERE ns = ? AND k = ?");
const stmtDel = db.prepare("DELETE FROM kv WHERE ns = ? AND k = ?");
const stmtPut = db.prepare(
  "INSERT INTO kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at"
);

function likeEscape(s) {
  return s.replace(/[%_\\]/g, c => "\\" + c);
}

// Implements the Workers-KV surface the handler relies on: get / put / delete / list.
function makeKV(ns) {
  const stmtList = db.prepare(
    "SELECT k FROM kv WHERE ns = ? AND k LIKE ? ESCAPE '\\' ORDER BY k"
  );
  return {
    async get(key, opts) {
      const row = stmtGet.get(ns, key);
      if (!row) return null;
      if (row.expires_at && Date.now() > row.expires_at) {
        stmtDel.run(ns, key);
        return null;
      }
      if (opts && opts.type === "json") {
        try { return JSON.parse(row.v); } catch { return null; }
      }
      return row.v;
    },
    async put(key, value, opts) {
      let expires = null;
      if (opts && opts.expirationTtl) expires = Date.now() + opts.expirationTtl * 1000;
      stmtPut.run(ns, key, String(value), expires);
    },
    async delete(key) {
      stmtDel.run(ns, key);
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      const rows = stmtList.all(ns, likeEscape(prefix) + "%");
      return { keys: rows.map(r => ({ name: r.k })) };
    }
  };
}

// ---------------------------------------------------------------- static files
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function mimeFor(file) {
  const dot = file.lastIndexOf(".");
  return MIME[file.substring(dot).toLowerCase()] || "application/octet-stream";
}

// Mirror Cloudflare Pages clean-URL behaviour: "/login" -> login.html
function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  for (const candidate of [rel, rel + ".html"]) {
    const full = normalize(join(ROOT, candidate));
    if (!full.startsWith(ROOT)) continue; // path-traversal guard
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

function serveStatic(request) {
  const { pathname } = new URL(request.url);
  const file = resolveFile(pathname);
  if (!file) {
    // Gebrandete 404-Seite ausliefern (auf Cloudflare macht das Pages automatisch).
    const notFound = resolveFile("/404.html");
    if (notFound) return new Response(readFileSync(notFound), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
    return new Response("Not found", { status: 404 });
  }
  // Fonts/images may cache; HTML/CSS/JS must stay fresh (theme + app logic).
  const cache = /\.(woff2|png|ico|webp|svg|jpe?g)$/i.test(file)
    ? "public, max-age=86400"
    : "no-store";
  return new Response(readFileSync(file), {
    headers: { "content-type": mimeFor(file), "cache-control": cache }
  });
}

// ---------------------------------------------------------------- env
const env = {
  AUTH_KV: makeKV("auth"),
  SESSIONS_KV: makeKV("sessions"),
  VISITORS_KV: makeKV("visitors"),
  AUDIT_KV: makeKV("audit"),
  ASSETS: { fetch: req => serveStatic(req) },
  DEMO: process.env.DEMO || ""
};

// ---------------------------------------------------------------- seed admin
async function seedAdmin() {
  const existing = await env.AUTH_KV.get("user:admin");
  if (existing) return;
  const pw = process.env.ADMIN_PASSWORD || "admin";
  await env.AUTH_KV.put("user:admin", JSON.stringify({
    username: "admin",
    passwordHash: await hashPassword(pw),
    role: "admin",
    disabled: false,
    createdAt: Date.now()
  }));
  // Kein Klartext-Passwort ins Log: auf der Appliance landet stdout in journalctl
  // bzw. den Container-Logs und bleibt dort dauerhaft lesbar. Das Passwort kennt
  // ohnehin, wer ADMIN_PASSWORD gesetzt hat; setup.sh zeigt es selbst an.
  console.log("[seed] Admin-Benutzer 'admin' angelegt (Passwort aus ADMIN_PASSWORD).");
  if (pw === "admin") console.log("[seed] WARNUNG: Standardpasswort! Bitte nach dem ersten Login ändern.");
}

// ---------------------------------------------------------------- http bridge
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- TLS
function readTls() {
  if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) {
    try { return { cert: readFileSync(TLS_CERT, "utf8"), key: readFileSync(TLS_KEY, "utf8") }; }
    catch { return null; }
  }
  return null;
}

// Prüft Zertifikat (+ optional Schlüssel) und liest Eckdaten fürs GUI.
function certInfo(certPem, keyPem) {
  let x;
  try { x = new X509Certificate(certPem); }
  catch { return { ok: false, reason: "Kein gültiges Zertifikat (PEM erwartet)." }; }
  if (keyPem != null) {
    let k;
    try { k = createPrivateKey(keyPem); }
    catch { return { ok: false, reason: "Kein gültiger privater Schlüssel (PEM erwartet)." }; }
    if (!x.checkPrivateKey(k)) return { ok: false, reason: "Schlüssel passt nicht zum Zertifikat." };
  }
  const expired = !(new Date(x.validTo).getTime() > Date.now());
  return {
    ok: !expired,
    reason: expired ? "Zertifikat ist abgelaufen." : "",
    subject: x.subject || "", san: x.subjectAltName || "", issuer: x.issuer || "",
    validFrom: x.validFrom, validTo: x.validTo, expired,
    selfSigned: !!x.subject && x.subject === x.issuer
  };
}

let httpsServer = null;

// Admin-Endpunkte für TLS (nur inhouse/Node): Status abfragen + Zertifikat einspielen.
async function handleTls(request, res) {
  const session = await requireAdmin(env, request);
  if (!session) { res.statusCode = 403; res.end("Forbidden"); return; }
  const path = new URL(request.url).pathname;
  const send = (obj, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  };
  if (path === "/tls/status" && request.method === "GET") {
    const tls = readTls();
    return send(tls ? { present: true, ...certInfo(tls.cert) } : { present: false });
  }
  if (path === "/tls" && request.method === "POST") {
    const data = await request.json().catch(() => null);
    const cert = ((data && data.cert) || "").trim();
    const key = ((data && data.key) || "").trim();
    if (!cert || !key) return send({ ok: false, reason: "Zertifikat und Schlüssel erforderlich." }, 400);
    const info = certInfo(cert, key);
    if (!info.ok) return send(info, 400);
    mkdirSync(TLS_DIR, { recursive: true });
    writeFileSync(TLS_CERT, cert.endsWith("\n") ? cert : cert + "\n", { mode: 0o644 });
    writeFileSync(TLS_KEY, key.endsWith("\n") ? key : key + "\n", { mode: 0o600 });
    let applied = false;
    if (httpsServer) { try { httpsServer.setSecureContext({ cert, key }); applied = true; } catch {} }
    return send({ ...info, applied });
  }
  res.statusCode = 404; res.end("Not found");
}

async function handleApp(req, res) {
  try {
    const url = "http://" + (req.headers.host || "localhost") + req.url;
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const bodyBuf = hasBody ? await readBody(req) : null;

    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: bodyBuf && bodyBuf.length ? bodyBuf : undefined
    });

    if (new URL(request.url).pathname.startsWith("/tls")) {
      return await handleTls(request, res);
    }

    const response = await onRequest({ request, env });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("Request error:", err);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
}

// HTTP nimmt an, leitet aber auf HTTPS um, sobald ein Zertifikat aktiv ist.
const server = createServer((req, res) => {
  if (httpsServer) {
    const host = (req.headers.host || "localhost").split(":")[0];
    res.statusCode = 308;
    res.setHeader("location", "https://" + host + req.url);
    res.end();
    return;
  }
  handleApp(req, res);
});

// ---------------------------------------------------------------- boot
await seedAdmin();

// Authoritative retention purge: once at boot, then every 6 hours.
purgeOldVisitors(env).then(n => { if (n) console.log(`[purge] ${n} alte Besucher gelöscht`); }).catch(() => {});
setInterval(() => {
  purgeOldVisitors(env).then(n => { if (n) console.log(`[purge] ${n} alte Besucher gelöscht`); }).catch(() => {});
}, 6 * 3600 * 1000);

// Eingebautes HTTPS, sobald ein Zertifikat vorliegt (sonst nur HTTP, z. B. lokal).
const tls0 = readTls();
if (tls0) {
  httpsServer = createHttpsServer({ cert: tls0.cert, key: tls0.key }, handleApp);
  httpsServer.listen(HTTPS_PORT, () => console.log(`HTTPS läuft auf  https://localhost:${HTTPS_PORT}`));
}

server.listen(PORT, () => {
  console.log(`besucherlogin (inhouse) läuft auf  http://localhost:${PORT}${tls0 ? "  (→ HTTPS-Redirect)" : ""}`);
  console.log(`SQLite-Datenbank: ${DB_PATH}`);
});

// Sauberes Herunterfahren (z. B. `podman stop` während eines Updates): keine
// neuen Verbindungen mehr annehmen, dann die DB-Datei konsistent schließen.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} – fahre herunter…`);
  try { if (httpsServer) httpsServer.close(); } catch {}
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
