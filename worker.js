/**
 * Shubham Birajdar — portfolio Worker
 *
 * Serves the static site from assets and exposes a small backend:
 *   POST /api/contact   — receive a message, store it in D1 (rate-limited)
 *   GET  /api/health    — liveness probe
 *   GET  /api/messages  — read stored messages (requires X-Admin-Key: ADMIN_KEY)
 */

const MAX_BODY_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_MAX = 5; // messages per IP per window

let schemaReady = false;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     message TEXT NOT NULL,
     ip TEXT,
     user_agent TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ip ON messages(ip)`,
];

async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
  schemaReady = true;
}

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

function isTrustedOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin form posts may omit it
  try {
    const host = request.headers.get("Host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

async function handleContact(request, env) {
  if (!isTrustedOrigin(request)) {
    return json({ ok: false, error: "Cross-origin submissions are not allowed." }, 403);
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown";

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: "Payload too large." }, 413);
    body = JSON.parse(text || "{}");
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // Honeypot: bots fill hidden fields — pretend success, store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true });
  }

  const name = String(body.name || "").trim().slice(0, 100);
  const email = String(body.email || "").trim().slice(0, 200);
  const message = String(body.message || "").trim();

  if (name.length < 2) return json({ ok: false, error: "Please enter your name (2+ characters)." }, 400);
  if (!validEmail(email)) return json({ ok: false, error: "Please enter a valid email address." }, 400);
  if (message.length < 5) return json({ ok: false, error: "Message is too short (5+ characters)." }, 400);
  if (message.length > 5000) return json({ ok: false, error: "Message is too long (max 5000 characters)." }, 400);

  await ensureSchema(env.DB);

  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { results: recent } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE ip = ? AND created_at > ?"
  )
    .bind(ip, since)
    .all();
  const used = (recent && recent[0] && recent[0].n) || 0;
  if (used >= RATE_MAX) {
    return json({ ok: false, error: "Too many messages too quickly — please try again later." }, 429);
  }

  await env.DB.prepare(
    "INSERT INTO messages (name, email, message, ip, user_agent) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(name, email, message, ip, (request.headers.get("User-Agent") || "").slice(0, 300))
    .run();

  return json({ ok: true });
}

async function handleMessages(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: "ADMIN_KEY is not configured on this deployment." }, 503);
  }
  const given = key || new URL(request.url).searchParams.get("key") || "";
  if (given !== env.ADMIN_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, name, email, message FROM messages ORDER BY created_at DESC LIMIT 200"
  ).all();
  return json({ ok: true, count: results.length, messages: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/health") {
        return json({ ok: true, service: "portfolio", time: new Date().toISOString() });
      }
      if (path === "/api/contact") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
        return await handleContact(request, env);
      }
      if (path === "/api/messages") {
        if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
        return await handleMessages(request, env);
      }
      if (path.startsWith("/api/")) {
        return json({ ok: false, error: "Not found." }, 404);
      }

      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      if (path === "/") headers.set("cache-control", "no-cache");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      console.error("worker error", err);
      return json({ ok: false, error: "Internal error." }, 500);
    }
  },
};
