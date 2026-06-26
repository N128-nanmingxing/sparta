import { seedApps } from "../api/seed-data.js";

const sessionTtlMs = 1000 * 60 * 60 * 12;
const loginAttemptWindowMs = 1000 * 60 * 10;
const loginAttemptLimit = 5;
const loginBlockMs = 1000 * 60 * 15;
const sensitiveWords = ["赌博", "博彩", "色情", "私服", "外挂", "破解", "破解版", "非法", "病毒", "盗版", "洗钱"];
const correctionMap = new Map([
  ["微心", "微信"],
  ["丁丁", "钉钉"],
  ["腾迅会议", "腾讯会议"],
  ["企微", "企业微信"],
]);
const reviewStatuses = new Set(["pending", "approved", "rejected"]);
let schemaReadyPromise = null;
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeText(item, 40)).filter(Boolean);
  }
  return String(value || "")
    .split(/[;,；，]/g)
    .map((item) => sanitizeText(item, 40))
    .filter(Boolean);
}

function normalizeCompare(value) {
  return sanitizeText(value, 200).toLowerCase();
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "true").trim().toLowerCase();
  return !["false", "0", "否", "无效", "invalid"].includes(text);
}

function normalizeReviewStatus(value, fallback = "pending") {
  const candidate = sanitizeText(value || fallback, 20).toLowerCase();
  return reviewStatuses.has(candidate) ? candidate : fallback;
}

function normalizeUrl(value, label) {
  const text = sanitizeText(value, 400);
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}格式不正确`);
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error(`${label}必须使用 http 或 https`);
  }
  url.hash = "";
  return url.toString();
}

function normalizeDomain(value) {
  const text = sanitizeText(value, 200);
  if (!text) return "";
  return text
    .split(/[;,；，\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const source = item.includes("://") ? item : `https://${item}`;
      let url;
      try {
        url = new URL(source);
      } catch {
        throw new Error("官方主域名格式不正确");
      }
      const hostName = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
      if (!/^[a-z0-9.-]+$/.test(hostName)) {
        throw new Error("官方主域名格式不正确");
      }
      return hostName;
    })
    .join(";");
}

function deriveOfficialDomain(value) {
  const text = sanitizeText(value, 400);
  if (!text) return "";
  return normalizeDomain(text);
}

function hostMatchesDomain(hostName, officialDomain) {
  const host = hostName.toLowerCase();
  return String(officialDomain || "")
    .split(";")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function validateOfficialUrl(urlValue, officialDomain, label) {
  if (!urlValue) return;
  const hostName = new URL(urlValue).hostname.toLowerCase();
  if (!hostMatchesDomain(hostName, officialDomain)) {
    throw new Error(`${label}必须使用官方域名或其子域名`);
  }
}

function validateIosUrl(urlValue) {
  if (!urlValue) return;
  const hostName = new URL(urlValue).hostname.toLowerCase();
  if (hostName !== "apps.apple.com") {
    throw new Error("iOS官方下载地址必须使用 apps.apple.com");
  }
}

function makeId(name) {
  const safe = String(name || "app")
    .trim()
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `app_${safe || "item"}_${Date.now().toString(36)}`;
}

function normalizeQuery(query) {
  const lower = query.toLowerCase();
  return correctionMap.get(query) || correctionMap.get(lower) || query;
}

function containsSensitive(query) {
  return sensitiveWords.some((word) => query.includes(word));
}

function cleanQuery(value) {
  return String(value || "")
    .trim()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function rowToApp(row) {
  return {
    id: row.id,
    name: row.name,
    aliases: parseJson(row.aliases_json, []),
    icon: row.icon,
    officialSite: row.official_site,
    android: row.android,
    ios: row.ios,
    officialDomain: row.official_domain,
    valid: Boolean(row.valid),
    weight: Number(row.weight ?? 50),
    reviewStatus: row.review_status,
    reviewNote: row.review_note || "",
    reviewedAt: row.reviewed_at || "",
    reviewedBy: row.reviewed_by || "",
    updatedAt: row.updated_at,
  };
}

function toDbApp(app) {
  return {
    id: app.id,
    name: app.name,
    aliases_json: JSON.stringify(app.aliases),
    icon: app.icon,
    official_site: app.officialSite,
    android: app.android,
    ios: app.ios,
    official_domain: app.officialDomain,
    valid: app.valid ? 1 : 0,
    weight: app.weight,
    review_status: app.reviewStatus,
    review_note: app.reviewNote,
    reviewed_at: app.reviewedAt,
    reviewed_by: app.reviewedBy,
    updated_at: app.updatedAt,
  };
}

function makeJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders,
      ...extraHeaders,
    },
  });
}

function makeText(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders,
      ...extraHeaders,
    },
  });
}

function parseCookies(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function getRequestIp(request) {
  const forwarded = String(request.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  return sanitizeText(forwarded || request.headers.get("cf-connecting-ip") || "unknown", 80);
}

function safeEquals(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function ensureSchema(env) {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    const schemaStatements = [
      `CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        icon TEXT NOT NULL,
        official_site TEXT NOT NULL DEFAULT '',
        android TEXT NOT NULL DEFAULT '',
        ios TEXT NOT NULL DEFAULT '',
        official_domain TEXT NOT NULL,
        valid INTEGER NOT NULL DEFAULT 1,
        weight INTEGER NOT NULL DEFAULT 50,
        review_status TEXT NOT NULL DEFAULT 'pending',
        review_note TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ok',
        ip TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name)",
      "CREATE INDEX IF NOT EXISTS idx_apps_weight ON apps(weight DESC)",
      "CREATE INDEX IF NOT EXISTS idx_apps_review_status ON apps(review_status)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)",
    ];

    for (const statement of schemaStatements) {
      await env.DB.prepare(statement).run();
    }

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS total FROM apps").all();
    const total = Number(results?.[0]?.total || 0);
    if (total === 0) {
      await seedDatabase(env);
    }

    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()).run();
  })();
  return schemaReadyPromise;
}

async function seedDatabase(env) {
  const stmt = env.DB.prepare(`
    INSERT OR REPLACE INTO apps (
      id, name, aliases_json, icon, official_site, android, ios,
      official_domain, valid, weight, review_status, review_note,
      reviewed_at, reviewed_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const raw of seedApps) {
    const app = normalizeAppInput(
      {
        ...raw,
        officialDomain: raw.officialDomain || deriveOfficialDomain(raw.officialSite || raw.android),
        reviewStatus: raw.valid ? "approved" : "rejected",
        reviewNote: raw.valid ? "Seed data imported from apps.json" : "Seed data imported from apps.json",
        reviewedBy: "seed",
        reviewedAt: raw.updatedAt || nowIso(),
      },
      null,
      "seed",
    );
    await stmt.bind(...Object.values(toDbApp(app))).run();
  }
}

function normalizeAppInput(input, existing = null, reviewer = "") {
  const name = sanitizeText(input.name, 60);
  if (!name) {
    throw new Error("APP标准名称不能为空");
  }
  const aliases = normalizeAliases(input.aliases);
  const officialSite = normalizeUrl(input.officialSite, "官方官网地址");
  const android = normalizeUrl(input.android, "安卓官方下载地址");
  const ios = normalizeUrl(input.ios, "iOS官方下载地址");
  const officialDomain =
    normalizeDomain(input.officialDomain) ||
    normalizeDomain(existing?.officialDomain) ||
    deriveOfficialDomain(officialSite || android);
  if (!officialDomain) {
    throw new Error("请填写官方主域名，或至少填写一个可推导域名的官网/安卓地址");
  }
  if (!officialSite && !android && !ios) {
    throw new Error("至少填写一个官网或下载地址");
  }
  const reviewStatus = normalizeReviewStatus(input.reviewStatus, existing?.reviewStatus || "pending");
  const reviewNote = sanitizeText(input.reviewNote || existing?.reviewNote || "", 240);
  const valid = normalizeBoolean(input.valid);

  if (reviewStatus === "approved") {
    if (!valid) throw new Error("审核通过的记录必须标记为可对外展示");
    if (!reviewNote) throw new Error("审核通过时必须填写审核备注");
    if (!officialSite && !android) throw new Error("审核通过的记录至少需要官网或安卓官方地址之一");
  }
  if (reviewStatus === "rejected") {
    if (valid) throw new Error("已驳回记录不能标记为可对外展示");
    if (!reviewNote) throw new Error("驳回记录必须填写驳回原因");
  }
  if (reviewStatus === "pending" && valid) {
    throw new Error("待审核记录不能标记为可对外展示");
  }
  if (reviewStatus !== "rejected") {
    validateOfficialUrl(officialSite, officialDomain, "官方官网地址");
    validateOfficialUrl(android, officialDomain, "安卓官方下载地址");
    validateIosUrl(ios);
  }

  const now = nowIso();
  return {
    id: existing?.id || input.id || makeId(name),
    name,
    aliases,
    icon: sanitizeText(input.icon || name.slice(0, 1) || "官", 1) || "官",
    officialSite,
    android,
    ios,
    officialDomain,
    valid,
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 50,
    reviewStatus,
    reviewNote,
    reviewedAt: reviewStatus === "pending" ? "" : sanitizeText(input.reviewedAt || existing?.reviewedAt || now, 40),
    reviewedBy: reviewStatus === "pending" ? "" : sanitizeText(reviewer || input.reviewedBy || existing?.reviewedBy || "admin", 60),
    updatedAt: now,
  };
}

async function getAllApps(env) {
  const { results } = await env.DB.prepare("SELECT * FROM apps ORDER BY review_status, valid DESC, weight DESC, updated_at DESC").all();
  return results.map(rowToApp);
}

async function getAppById(env, id) {
  const row = await env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first();
  return row ? rowToApp(row) : null;
}

function getLinks(app) {
  return [app.officialSite, app.android, app.ios].map(normalizeCompare).filter(Boolean);
}

async function findDuplicate(env, app, ignoreId = "") {
  const apps = await getAllApps(env);
  const name = normalizeCompare(app.name);
  const aliases = normalizeAliases(app.aliases).map(normalizeCompare);
  const links = getLinks(app);
  return apps.find((item) => {
    if (item.id === ignoreId) return false;
    const itemName = normalizeCompare(item.name);
    const itemAliases = normalizeAliases(item.aliases).map(normalizeCompare);
    const itemLinks = getLinks(item);
    return (
      (name && (itemName === name || itemAliases.includes(name))) ||
      aliases.some((alias) => alias === itemName || itemAliases.includes(alias)) ||
      links.some((link) => itemLinks.includes(link))
    );
  });
}

async function assertAppValid(env, app, ignoreId = "") {
  const duplicate = await findDuplicate(env, app, ignoreId);
  if (duplicate) {
    throw new Error(`存在重复记录：${duplicate.name}`);
  }
}

async function recordAudit(env, { request = null, action, username = "", targetId = "", status = "ok", detail = {} }) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (action, username, target_id, status, ip, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sanitizeText(action, 60),
      sanitizeText(username, 60),
      sanitizeText(targetId, 120),
      sanitizeText(status, 20) || "ok",
      request ? getRequestIp(request) : "",
      JSON.stringify(detail || {}),
      nowIso(),
    )
    .run();
}

async function cleanupExpiredSessions(env) {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()).run();
}

async function getSession(env, request) {
  await cleanupExpiredSessions(env);
  const token = parseCookies(request).sparta_admin_session;
  if (!token) return null;
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE token = ?").bind(token).first();
  if (!row) return null;
  const expiresAt = Date.now() + sessionTtlMs;
  await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token = ?")
    .bind(expiresAt, nowIso(), token)
    .run();
  return {
    token: row.token,
    username: row.username,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt,
  };
}

async function issueSession(env, username) {
  const token = crypto.randomUUID().replace(/-/g, "");
  const csrfToken = crypto.randomUUID().replace(/-/g, "");
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO sessions (token, username, csrf_token, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(token, sanitizeText(username, 60), csrfToken, createdAt, createdAt, Date.now() + sessionTtlMs)
    .run();
  return { token, csrfToken };
}

async function clearSession(env, token) {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

function buildSessionCookie(token) {
  const parts = [`sparta_admin_session=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Secure", `Max-Age=${sessionTtlMs / 1000}`];
  return parts.join("; ");
}

function clearSessionCookie() {
  const parts = [`sparta_admin_session=`, "Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=0"];
  return parts.join("; ");
}

async function getLoginAttemptState(env, ip) {
  const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (!row) {
    return { blocked: false, remaining: loginAttemptLimit, retryAfterSeconds: 0, row: null };
  }
  const blocked = Number(row.blocked_until || 0) > Date.now();
  return {
    blocked,
    remaining: Math.max(loginAttemptLimit - Number(row.failures || 0), 0),
    retryAfterSeconds: blocked ? Math.ceil((Number(row.blocked_until) - Date.now()) / 1000) : 0,
    row,
  };
}

async function registerLoginFailure(env, ip) {
  const state = await getLoginAttemptState(env, ip);
  const now = Date.now();
  const failures = state.row && Number(state.row.last_failure_at || 0) + loginAttemptWindowMs > now ? Number(state.row.failures || 0) + 1 : 1;
  const blockedUntil = failures >= loginAttemptLimit ? now + loginBlockMs : 0;
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, last_failure_at, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at, blocked_until = excluded.blocked_until`,
  )
    .bind(ip, failures, now, blockedUntil)
    .run();
  return { failures, blockedUntil };
}

async function clearLoginFailures(env, ip) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

function requireTrustedOrigin(request) {
  const origin = request.headers.get("origin");
  const hostHeader = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  if (!origin || !hostHeader) {
    return false;
  }
  try {
    return new URL(origin).host === hostHeader.split(",")[0].trim();
  } catch {
    return false;
  }
}

function requireCsrfToken(request, session) {
  const token = request.headers.get("x-csrf-token") || "";
  return Boolean(token && session?.csrfToken && safeEquals(token, session.csrfToken));
}

async function getOpsStatus(env) {
  const counts = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM apps
  `).first();
  const auditCount = await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_logs").first();
  const activeSessions = await env.DB.prepare("SELECT COUNT(*) AS total FROM sessions WHERE expires_at > ?").bind(Date.now()).first();
  const lastBackup = await env.DB.prepare(`SELECT created_at FROM audit_logs WHERE action = 'backup_export' AND status = 'ok' ORDER BY id DESC LIMIT 1`).first();
  const recent = await env.DB.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10`).all();
  return {
    environment: "cloudflare",
    credentialsReady: Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
    sessionTtlHours: Math.round(sessionTtlMs / (1000 * 60 * 60)),
    storage: { type: "d1" },
    counts: {
      total: Number(counts?.total || 0),
      approved: Number(counts?.approved || 0),
      pending: Number(counts?.pending || 0),
      rejected: Number(counts?.rejected || 0),
      auditCount: Number(auditCount?.total || 0),
      activeSessions: Number(activeSessions?.total || 0),
    },
    lastBackupAt: lastBackup?.created_at || "",
    recentAudits: (recent.results || []).map((row) => ({
      id: row.id,
      action: row.action,
      username: row.username,
      targetId: row.target_id,
      status: row.status,
      ip: row.ip,
      detail: parseJson(row.detail_json, {}),
      createdAt: row.created_at,
    })),
  };
}

async function exportBackup(env, username) {
  const apps = await getAllApps(env);
  const audits = await env.DB.prepare("SELECT * FROM audit_logs ORDER BY id DESC").all();
  return {
    version: 1,
    exportedAt: nowIso(),
    exportedBy: sanitizeText(username, 60),
    environment: "cloudflare",
    apps,
    audits: (audits.results || []).map((row) => ({
      id: row.id,
      action: row.action,
      username: row.username,
      targetId: row.target_id,
      status: row.status,
      ip: row.ip,
      detail: parseJson(row.detail_json, {}),
      createdAt: row.created_at,
    })),
  };
}

function toCsv(apps) {
  const headers = ["name", "aliases", "icon", "officialSite", "android", "ios", "officialDomain", "valid", "weight", "reviewStatus", "reviewNote"];
  const escapeCsvCell = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${[
    headers.join(","),
    ...apps.map((app) =>
      [
        app.name,
        normalizeAliases(app.aliases).join(";"),
        app.icon,
        app.officialSite,
        app.android,
        app.ios,
        app.officialDomain,
        String(Boolean(app.valid)),
        String(app.weight ?? 50),
        app.reviewStatus,
        app.reviewNote,
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ].join("\n")}\n`;
}

async function searchApps(env, query) {
  const normalized = normalizeQuery(query);
  const lower = normalized.toLowerCase();
  const { results } = await env.DB.prepare("SELECT * FROM apps WHERE review_status = 'approved' ORDER BY valid DESC, weight DESC, updated_at DESC").all();

  const apps = results.map(rowToApp);
  if (lower === "app" || normalized === "软件") {
    return apps.filter((item) => item.valid).slice(0, 5);
  }

  const exactMatches = apps.filter((item) => {
    const itemName = normalizeCompare(item.name);
    const aliases = normalizeAliases(item.aliases).map(normalizeCompare);
    return itemName === lower || aliases.includes(lower);
  });

  if (exactMatches.length > 0) {
    return exactMatches.slice(0, 5);
  }

  return apps
    .filter((item) => {
      if (item.name.includes(normalized)) return true;
      return item.aliases.some((alias) => {
        const normalizedAlias = String(alias).toLowerCase();
        return normalizedAlias.includes(lower) || lower.includes(normalizedAlias);
      });
    })
    .slice(0, 5);
}

async function upsertApp(env, input, existing, username) {
  const app = normalizeAppInput(input, existing, username);
  await assertAppValid(env, app, existing?.id || "");
  await env.DB.prepare(
    `INSERT INTO apps (
      id, name, aliases_json, icon, official_site, android, ios,
      official_domain, valid, weight, review_status, review_note,
      reviewed_at, reviewed_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      aliases_json = excluded.aliases_json,
      icon = excluded.icon,
      official_site = excluded.official_site,
      android = excluded.android,
      ios = excluded.ios,
      official_domain = excluded.official_domain,
      valid = excluded.valid,
      weight = excluded.weight,
      review_status = excluded.review_status,
      review_note = excluded.review_note,
      reviewed_at = excluded.reviewed_at,
      reviewed_by = excluded.reviewed_by,
      updated_at = excluded.updated_at`,
  )
    .bind(
      app.id,
      app.name,
      JSON.stringify(app.aliases),
      app.icon,
      app.officialSite,
      app.android,
      app.ios,
      app.officialDomain,
      app.valid ? 1 : 0,
      app.weight,
      app.reviewStatus,
      app.reviewNote,
      app.reviewedAt,
      app.reviewedBy,
      app.updatedAt,
    )
    .run();
  return app;
}

async function handleApiRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (["POST", "PUT", "DELETE"].includes(method) && pathname.startsWith("/api/")) {
    if (!requireTrustedOrigin(request)) {
      return makeJson({ error: "来源站点校验失败", code: "ORIGIN_MISMATCH" }, 403);
    }
  }

  if (method === "GET" && pathname === "/healthz") {
    return makeJson({ ok: true });
  }

  await ensureSchema(env);

  if (method === "GET" && pathname === "/api/admin/session") {
    const session = await getSession(env, request);
    return makeJson({
      authenticated: Boolean(session),
      username: session?.username || "",
      csrfToken: session?.csrfToken || "",
      credentialsReady: Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
    });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
      return makeJson({ error: "后台登录未配置，请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD" }, 503);
    }
    const body = await request.json().catch(() => ({}));
    const username = sanitizeText(body.username, 60);
    const password = String(body.password || "").trim();
    const ip = getRequestIp(request);
    const attempt = await getLoginAttemptState(env, ip);
    if (attempt.blocked) {
      await recordAudit(env, { request, action: "login_rate_limited", username, status: "blocked", detail: { retryAfterSeconds: String(attempt.retryAfterSeconds) } });
      return makeJson(
        { error: `登录失败次数过多，请在 ${attempt.retryAfterSeconds} 秒后重试`, code: "LOGIN_RATE_LIMITED", retryAfterSeconds: attempt.retryAfterSeconds },
        429,
      );
    }
    if (!safeEquals(username, env.ADMIN_USERNAME) || !safeEquals(password, env.ADMIN_PASSWORD)) {
      const next = await registerLoginFailure(env, ip);
      await recordAudit(env, {
        request,
        action: "login_failure",
        username,
        status: "denied",
        detail: { failures: String(next.failures), blockedUntil: next.blockedUntil ? new Date(next.blockedUntil).toISOString() : "" },
      });
      return makeJson({ error: "账号或密码错误" }, 401);
    }
    await clearLoginFailures(env, ip);
    const session = await issueSession(env, username);
    await recordAudit(env, { request, action: "login_success", username, detail: { sessionCreated: "true" } });
    return makeJson(
      { ok: true, username, csrfToken: session.csrfToken },
      200,
      { "Set-Cookie": buildSessionCookie(session.token) },
    );
  }

  if (method === "POST" && pathname === "/api/admin/logout") {
    const session = await getSession(env, request);
    if (session && !requireCsrfToken(request, session)) {
      return makeJson({ error: "CSRF 校验失败，请刷新后台后重试", code: "CSRF_INVALID" }, 403);
    }
    await clearSession(env, session?.token);
    if (session) {
      await recordAudit(env, { request, action: "logout", username: session.username });
    }
    return makeJson({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (method === "GET" && pathname === "/api/search") {
    const query = cleanQuery(url.searchParams.get("q"));
    if (!query) {
      return makeJson({ error: "请输入需要查询的APP名称" }, 400);
    }
    if (containsSensitive(query)) {
      return makeJson({ blocked: true, results: [] });
    }
    return makeJson({ results: await searchApps(env, query) });
  }

  if (pathname === "/api/admin/ops/status" && method === "GET") {
    const session = await getSession(env, request);
    if (!session) return makeJson({ error: "请先登录后台账号", code: "AUTH_REQUIRED" }, 401);
    return makeJson(await getOpsStatus(env));
  }

  if (pathname === "/api/admin/ops/backup" && method === "POST") {
    const session = await getSession(env, request);
    if (!session) return makeJson({ error: "请先登录后台账号", code: "AUTH_REQUIRED" }, 401);
    if (!requireCsrfToken(request, session)) {
      return makeJson({ error: "CSRF 校验失败，请刷新后台后重试", code: "CSRF_INVALID" }, 403);
    }
    const snapshot = await exportBackup(env, session.username);
    await recordAudit(env, { request, action: "backup_export", username: session.username, detail: { appCount: String(snapshot.apps.length), auditCount: String(snapshot.audits.length) } });
    return new Response(JSON.stringify(snapshot, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="sparta-backup-${snapshot.exportedAt.replace(/[:.]/g, "-")}.json"`,
        ...securityHeaders,
      },
    });
  }

  const session = await getSession(env, request);
  if (!session) {
    return makeJson({ error: "请先登录后台账号", code: "AUTH_REQUIRED" }, 401);
  }
  if (["POST", "PUT", "DELETE"].includes(method) && !requireCsrfToken(request, session)) {
    return makeJson({ error: "CSRF 校验失败，请刷新后台后重试", code: "CSRF_INVALID" }, 403);
  }

  if (pathname === "/api/apps" && method === "GET") {
    return makeJson({ apps: await getAllApps(env) });
  }

  if (pathname === "/api/apps/export" && method === "GET") {
    return new Response(toCsv(await getAllApps(env)), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="app-addresses.csv"',
        ...securityHeaders,
      },
    });
  }

  if (pathname === "/api/apps" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const next = await upsertApp(env, body, null, session.username);
    await recordAudit(env, { request, action: "app_create", username: session.username, targetId: next.id, detail: { name: next.name, reviewStatus: next.reviewStatus } });
    return makeJson({ app: next }, 201);
  }

  if (pathname === "/api/apps/import" && method === "POST") {
    const raw = await request.text();
    const contentType = request.headers.get("content-type") || "";
    const { rows, rowOffset } = parseImportRows(raw, contentType);

    const skipped = [];
    const imported = [];
    for (const [index, row] of rows.entries()) {
      try {
        const app = await upsertApp(env, row, null, session.username);
        imported.push(app);
      } catch (error) {
        skipped.push({ row: Number(row.importRowNumber || index + rowOffset), error: error.message || "数据无效" });
      }
    }
    await recordAudit(env, { request, action: "app_import", username: session.username, detail: { imported: String(imported.length), skipped: String(skipped.length) } });
    return makeJson({ imported, skipped });
  }

  if (pathname.startsWith("/api/apps/")) {
    const id = decodeURIComponent(pathname.slice("/api/apps/".length));
    const existing = await getAppById(env, id);
    if (!existing) {
      return makeJson({ error: "未找到该APP" }, 404);
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const next = await upsertApp(env, body, existing, session.username);
      await recordAudit(env, { request, action: "app_update", username: session.username, targetId: next.id, detail: { name: next.name, reviewStatus: next.reviewStatus } });
      return makeJson({ app: next });
    }
    if (method === "DELETE") {
      const result = await env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(id).run();
      if (!result.meta?.changes) {
        return makeJson({ error: "未找到该APP" }, 404);
      }
      await recordAudit(env, { request, action: "app_delete", username: session.username, targetId: id });
      return makeJson({ ok: true });
    }
    if (method === "GET" && pathname === `/api/apps/${id}`) {
      return makeJson({ app: existing });
    }
  }

  return makeJson({ error: "接口不存在" }, 404);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmptyRows = rows.filter((item) => item.some((value) => String(value).trim()));
  if (nonEmptyRows.length === 0) return [];
  const headers = nonEmptyRows[0].map((header) => header.trim());
  return nonEmptyRows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function parseImportRows(raw, contentType) {
  if (!contentType.includes("application/json")) {
    return { rows: parseCsv(raw), rowOffset: 2 };
  }

  const payload = parseJson(raw, {});
  if (!Array.isArray(payload.apps)) {
    throw new Error("JSON导入内容必须包含 apps 数组");
  }
  return { rows: payload.apps, rowOffset: 1 };
}

export async function onRequest(context) {
  return handleApiRequest(context);
}
