import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { seedApps } from "./functions/api/seed-data.js";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, "data");
const legacyAppsFile = join(dataDir, "apps.json");
const dbFile = join(dataDir, "sparta.sqlite");
const preferredPort = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const adminUsername = process.env.ADMIN_USERNAME || (isProduction ? "" : "admin");
const adminPassword = process.env.ADMIN_PASSWORD || (isProduction ? "" : "as758521");
const sessionCookieName = "sparta_admin_session";
const sessionTtlMs = 1000 * 60 * 60 * 12;
const loginAttemptWindowMs = 1000 * 60 * 10;
const loginAttemptLimit = 5;
const loginBlockMs = 1000 * 60 * 15;
const siteRequestWindowMs = 1000 * 60 * 10;
const siteRequestLimit = 5;
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const sensitiveWords = [
  "赌博",
  "博彩",
  "色情",
  "私服",
  "外挂",
  "破解",
  "破解版",
  "非法",
  "病毒",
  "盗版",
  "洗钱",
];

const correctionMap = new Map([
  ["微心", "微信"],
  ["丁丁", "钉钉"],
  ["腾迅会议", "腾讯会议"],
  ["企微", "企业微信"],
]);

const reviewStatuses = new Set(["pending", "approved", "rejected"]);
const db = createDatabase();
const loginAttempts = new Map();

function createDatabase() {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(dbFile);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS apps (
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
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      ip TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      website TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_limits (
      scope TEXT NOT NULL,
      ip TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL,
      PRIMARY KEY (scope, ip)
    );
    CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
    CREATE INDEX IF NOT EXISTS idx_apps_weight ON apps(weight DESC);
    CREATE INDEX IF NOT EXISTS idx_apps_review_status ON apps(review_status);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_requests_created_at ON site_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_limits_window ON request_limits(window_started_at);
  `);
  migrateSeedApps(database);
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return database;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeJsonDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, 24)
      .map(([key, value]) => [sanitizeText(key, 60), sanitizeText(value, 240)]),
  );
}

function getRequestIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const raw = forwarded || request.socket?.remoteAddress || "unknown";
  return sanitizeText(raw, 80);
}

function recordAudit(action, { request = null, username = "", targetId = "", status = "ok", detail = {} } = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (action, username, target_id, status, ip, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizeText(action, 60),
      sanitizeText(username, 60),
      sanitizeText(targetId, 120),
      sanitizeText(status, 20) || "ok",
      request ? getRequestIp(request) : "",
      JSON.stringify(sanitizeJsonDetail(detail)),
      nowIso(),
    );
  } catch (error) {
    console.warn("Failed to record audit log:", error.message);
  }
}

function parseAuditRow(row) {
  let detail = {};
  try {
    detail = JSON.parse(row.detail_json || "{}");
  } catch {
    detail = {};
  }

  return {
    id: row.id,
    action: row.action,
    username: row.username,
    targetId: row.target_id,
    status: row.status,
    ip: row.ip,
    detail,
    createdAt: row.created_at,
  };
}

function getRecentAudits(limit = 12) {
  return db
    .prepare(`
      SELECT * FROM audit_logs
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map(parseAuditRow);
}

function getLastBackupAudit() {
  const row = db
    .prepare(`
      SELECT * FROM audit_logs
      WHERE action = 'backup_export' AND status = 'ok'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get();

  return row ? parseAuditRow(row) : null;
}

function parseSiteRequestRow(row) {
  return {
    id: row.id,
    name: row.name,
    website: row.website,
    note: row.note,
    contact: row.contact,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSiteRequests(limit = 80) {
  return db
    .prepare(`
      SELECT * FROM site_requests
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map(parseSiteRequestRow);
}

function getAdminOpsStatus() {
  const summary =
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM apps
    `).get() || {};
  const auditCount = db.prepare("SELECT COUNT(*) AS total FROM audit_logs").get().total;
  const activeSessions = db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE expires_at > ?").get(Date.now()).total;
  const lastBackup = getLastBackupAudit();

  return {
    environment: isProduction ? "production" : "development",
    credentialsReady: credentialsReady(),
    sessionTtlHours: Math.round(sessionTtlMs / (1000 * 60 * 60)),
    storage: {
      type: "sqlite",
      dataDir: isProduction ? "" : dataDir,
      dbFile: isProduction ? "" : dbFile,
    },
    counts: {
      total: Number(summary.total || 0),
      approved: Number(summary.approved || 0),
      pending: Number(summary.pending || 0),
      rejected: Number(summary.rejected || 0),
      auditCount: Number(auditCount || 0),
      activeSessions: Number(activeSessions || 0),
    },
    lastBackupAt: lastBackup?.createdAt || "",
    recentAudits: getRecentAudits(),
  };
}

function createSiteRequest(input) {
  const name = sanitizeText(input.name, 60);
  const website = sanitizeText(input.website, 200);
  const note = sanitizeText(input.note, 500);
  const contact = sanitizeText(input.contact, 120);

  if (!name) {
    throw new Error("请填写想添加的网站名称");
  }
  if (!note && !website) {
    throw new Error("请至少填写网站地址或需求说明");
  }

  const now = nowIso();
  const result = db
    .prepare(`
      INSERT INTO site_requests (name, website, note, contact, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'new', ?, ?)
    `)
    .run(name, website, note, contact, now, now);

  return parseSiteRequestRow(
    db.prepare("SELECT * FROM site_requests WHERE id = ?").get(result.lastInsertRowid),
  );
}

function updateSiteRequestStatus(id, status) {
  const nextStatus = ["new", "reviewed", "archived"].includes(status) ? status : "new";
  const row = db.prepare("SELECT * FROM site_requests WHERE id = ?").get(id);
  if (!row) {
    return null;
  }
  const now = nowIso();
  db.prepare("UPDATE site_requests SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, id);
  return parseSiteRequestRow(db.prepare("SELECT * FROM site_requests WHERE id = ?").get(id));
}

function deleteSiteRequest(id) {
  return db.prepare("DELETE FROM site_requests WHERE id = ?").run(id);
}

function exportBackupSnapshot(username) {
  const apps = getAllApps();
  const audits = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC").all().map(parseAuditRow);
  return {
    version: 1,
    exportedAt: nowIso(),
    exportedBy: sanitizeText(username, 60),
    environment: isProduction ? "production" : "development",
    apps,
    audits,
  };
}

function migrateSeedApps(database) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO apps (
      id, name, aliases_json, icon, official_site, android, ios,
      official_domain, valid, weight, review_status, review_note,
      reviewed_at, reviewed_by, updated_at
    ) VALUES (
      @id, @name, @aliasesJson, @icon, @officialSite, @android, @ios,
      @officialDomain, @valid, @weight, @reviewStatus, @reviewNote,
      @reviewedAt, @reviewedBy, @updatedAt
    )
  `);

  database.exec("BEGIN");
  try {
    seedApps.forEach((raw) => {
      const normalized = normalizeAppInput(
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
      insert.run(toDbApp(normalized));
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    console.warn("Failed to migrate seed apps:", error.message);
  }
}

function cleanQuery(value) {
  return String(value || "")
    .trim()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function sanitizeText(value, max = 200) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function normalizeQuery(query) {
  const lower = query.toLowerCase();
  return correctionMap.get(query) || correctionMap.get(lower) || query;
}

function containsSensitive(query) {
  return sensitiveWords.some((word) => query.includes(word));
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

function getLinks(app) {
  return [app.officialSite, app.android, app.ios].map(normalizeCompare).filter(Boolean);
}

function rowToApp(row) {
  return {
    id: row.id,
    name: row.name,
    aliases: JSON.parse(row.aliases_json || "[]"),
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
    aliasesJson: JSON.stringify(app.aliases),
    icon: app.icon,
    officialSite: app.officialSite,
    android: app.android,
    ios: app.ios,
    officialDomain: app.officialDomain,
    valid: app.valid ? 1 : 0,
    weight: app.weight,
    reviewStatus: app.reviewStatus,
    reviewNote: app.reviewNote,
    reviewedAt: app.reviewedAt,
    reviewedBy: app.reviewedBy,
    updatedAt: app.updatedAt,
  };
}

function getAllApps() {
  const rows = db.prepare(`
    SELECT * FROM apps
    ORDER BY
      CASE review_status
        WHEN 'pending' THEN 0
        WHEN 'rejected' THEN 1
        ELSE 2
      END,
      valid DESC,
      weight DESC,
      updated_at DESC
  `).all();
  return rows.map(rowToApp);
}

function findDuplicate(app, apps, ignoreId = "") {
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

  const nextReviewStatus = normalizeReviewStatus(input.reviewStatus, existing?.reviewStatus || "pending");
  const reviewNote = sanitizeText(input.reviewNote || existing?.reviewNote || "", 240);
  const nextValid = normalizeBoolean(input.valid);

  if (nextReviewStatus === "approved") {
    if (!nextValid) {
      throw new Error("审核通过的记录必须标记为可对外展示");
    }
    if (!reviewNote) {
      throw new Error("审核通过时必须填写审核备注");
    }
    if (!officialSite && !android) {
      throw new Error("审核通过的记录至少需要官网或安卓官方地址之一");
    }
  }

  if (nextReviewStatus === "rejected") {
    if (nextValid) {
      throw new Error("已驳回记录不能标记为可对外展示");
    }
    if (!reviewNote) {
      throw new Error("驳回记录必须填写驳回原因");
    }
  }

  if (nextReviewStatus === "pending" && nextValid) {
    throw new Error("待审核记录不能标记为可对外展示");
  }

  if (nextReviewStatus !== "rejected") {
    validateOfficialUrl(officialSite, officialDomain, "官方官网地址");
    validateOfficialUrl(android, officialDomain, "安卓官方下载地址");
    validateIosUrl(ios);
  }
  const now = new Date().toISOString();
  const reviewedAt = nextReviewStatus === "pending" ? "" : sanitizeText(input.reviewedAt || existing?.reviewedAt || now, 40);
  const reviewedBy = nextReviewStatus === "pending" ? "" : sanitizeText(reviewer || input.reviewedBy || existing?.reviewedBy || "admin", 60);

  return {
    id: existing?.id || input.id || makeId(name),
    name,
    aliases,
    icon: sanitizeText(input.icon || name.slice(0, 1) || "官", 1) || "官",
    officialSite,
    android,
    ios,
    officialDomain,
    valid: nextValid,
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 50,
    reviewStatus: nextReviewStatus,
    reviewNote,
    reviewedAt,
    reviewedBy,
    updatedAt: now,
  };
}

function assertAppValid(app, apps, ignoreId = "") {
  const duplicate = findDuplicate(app, apps, ignoreId);
  if (duplicate) {
    throw new Error(`存在重复记录：${duplicate.name}`);
  }
}

function insertApp(app) {
  db.prepare(`
    INSERT INTO apps (
      id, name, aliases_json, icon, official_site, android, ios,
      official_domain, valid, weight, review_status, review_note,
      reviewed_at, reviewed_by, updated_at
    ) VALUES (
      @id, @name, @aliasesJson, @icon, @officialSite, @android, @ios,
      @officialDomain, @valid, @weight, @reviewStatus, @reviewNote,
      @reviewedAt, @reviewedBy, @updatedAt
    )
  `).run(toDbApp(app));
}

function updateApp(app) {
  db.prepare(`
    UPDATE apps SET
      name = @name,
      aliases_json = @aliasesJson,
      icon = @icon,
      official_site = @officialSite,
      android = @android,
      ios = @ios,
      official_domain = @officialDomain,
      valid = @valid,
      weight = @weight,
      review_status = @reviewStatus,
      review_note = @reviewNote,
      reviewed_at = @reviewedAt,
      reviewed_by = @reviewedBy,
      updated_at = @updatedAt
    WHERE id = @id
  `).run(toDbApp(app));
}

function deleteApp(id) {
  return db.prepare("DELETE FROM apps WHERE id = ?").run(id);
}

function getAppById(id) {
  const row = db.prepare("SELECT * FROM apps WHERE id = ?").get(id);
  return row ? rowToApp(row) : null;
}

function findResults(query) {
  const normalized = normalizeQuery(query);
  const lower = normalized.toLowerCase();
  const apps = db
    .prepare("SELECT * FROM apps WHERE review_status = 'approved' ORDER BY valid DESC, weight DESC, updated_at DESC")
    .all()
    .map(rowToApp);

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

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
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
  return nonEmptyRows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function parseImportRows(raw, contentType) {
  if (!contentType.includes("application/json")) {
    return { rows: parseCsv(raw), rowOffset: 2 };
  }

  const payload = JSON.parse(raw || "{}");
  if (!Array.isArray(payload.apps)) {
    throw new Error("JSON导入内容必须包含 apps 数组");
  }
  return { rows: payload.apps, rowOffset: 1 };
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function toCsv(apps) {
  const headers = [
    "name",
    "aliases",
    "icon",
    "officialSite",
    "android",
    "ios",
    "officialDomain",
    "valid",
    "weight",
    "reviewStatus",
    "reviewNote",
  ];

  const lines = [
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
  ];
  return `${lines.join("\n")}\n`;
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
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

function cleanupExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [key, state] of loginAttempts.entries()) {
    if (state.blockedUntil <= now && state.lastFailureAt + loginAttemptWindowMs <= now) {
      loginAttempts.delete(key);
    }
  }
}

function getSession(request) {
  cleanupExpiredSessions();
  const cookies = parseCookies(request);
  const token = cookies[sessionCookieName];
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  const expiresAt = Date.now() + sessionTtlMs;
  db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token = ?").run(expiresAt, nowIso(), token);
  return {
    token: row.token,
    username: row.username,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt,
  };
}

function issueSession(username) {
  cleanupExpiredSessions();
  const token = randomBytes(24).toString("hex");
  const csrfToken = randomBytes(18).toString("hex");
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO sessions (token, username, csrf_token, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, sanitizeText(username, 60), csrfToken, createdAt, createdAt, Date.now() + sessionTtlMs);
  return { token, csrfToken };
}

function clearSession(token) {
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
}

function buildSessionCookie(token, maxAge = sessionTtlMs / 1000) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearSessionCookie() {
  const parts = [`${sessionCookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...headers,
  });
  response.end(text);
}

function sendAuthRequired(response) {
  sendJson(response, 401, { error: "请先登录后台账号", code: "AUTH_REQUIRED" });
}

function sendForbidden(response, message, code = "FORBIDDEN") {
  sendJson(response, 403, { error: message, code });
}

function requireAdminSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendAuthRequired(response);
    return null;
  }
  return session;
}

function credentialsReady() {
  return Boolean(adminUsername && adminPassword);
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function registerLoginFailure(ip) {
  cleanupLoginAttempts();
  const key = sanitizeText(ip, 80);
  const current = loginAttempts.get(key);
  const now = Date.now();
  const failures =
    current && current.lastFailureAt + loginAttemptWindowMs > now
      ? current.failures + 1
      : 1;
  const blockedUntil = failures >= loginAttemptLimit ? now + loginBlockMs : 0;
  loginAttempts.set(key, {
    failures,
    lastFailureAt: now,
    blockedUntil,
  });
  return {
    failures,
    blockedUntil,
  };
}

function checkRequestLimit(scope, ip, limit, windowMs) {
  const now = Date.now();
  const safeScope = sanitizeText(scope, 40);
  const safeIp = sanitizeText(ip, 80);
  db.prepare("DELETE FROM request_limits WHERE window_started_at < ?").run(now - windowMs * 2);
  const row = db.prepare("SELECT * FROM request_limits WHERE scope = ? AND ip = ?").get(safeScope, safeIp);

  if (!row || Number(row.window_started_at || 0) + windowMs <= now) {
    db.prepare(`
      INSERT INTO request_limits (scope, ip, count, window_started_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(scope, ip) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at
    `).run(safeScope, safeIp, now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const nextCount = Number(row.count || 0) + 1;
  db.prepare("UPDATE request_limits SET count = ? WHERE scope = ? AND ip = ?").run(nextCount, safeScope, safeIp);

  if (nextCount > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((Number(row.window_started_at) + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function clearLoginFailures(ip) {
  loginAttempts.delete(sanitizeText(ip, 80));
}

function getLoginLimitState(ip) {
  cleanupLoginAttempts();
  const state = loginAttempts.get(sanitizeText(ip, 80));
  if (!state) {
    return { blocked: false, retryAfterSeconds: 0, remaining: loginAttemptLimit };
  }
  const now = Date.now();
  const blocked = state.blockedUntil > now;
  const remaining = Math.max(loginAttemptLimit - state.failures, 0);
  return {
    blocked,
    retryAfterSeconds: blocked ? Math.ceil((state.blockedUntil - now) / 1000) : 0,
    remaining,
  };
}

function requireTrustedOrigin(request, response) {
  const origin = request.headers.origin;
  const hostHeader = String(request.headers["x-forwarded-host"] || request.headers.host || "")
    .split(",")[0]
    .trim();

  if (!hostHeader) {
    sendForbidden(response, "请求缺少可信 Origin", "ORIGIN_REQUIRED");
    return false;
  }

  if (!origin) {
    if (
      hostHeader === "127.0.0.1" ||
      hostHeader === "127.0.0.1:4173" ||
      hostHeader === "localhost" ||
      hostHeader === "localhost:4173"
    ) {
      return true;
    }
    sendForbidden(response, "请求缺少可信 Origin", "ORIGIN_REQUIRED");
    return false;
  }

  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== hostHeader) {
      sendForbidden(response, "来源站点校验失败", "ORIGIN_MISMATCH");
      return false;
    }
  } catch {
    sendForbidden(response, "来源站点格式不正确", "ORIGIN_INVALID");
    return false;
  }

  return true;
}

function requireCsrfToken(request, response, session) {
  const token = String(request.headers["x-csrf-token"] || "");
  if (!token || !session?.csrfToken || !safeEquals(token, session.csrfToken)) {
    sendForbidden(response, "CSRF 校验失败，请刷新后台后重试", "CSRF_INVALID");
    return false;
  }
  return true;
}

async function handleApi(request, response, url) {
  if (["POST", "PUT", "DELETE"].includes(request.method || "") && url.pathname.startsWith("/api/")) {
    if (!requireTrustedOrigin(request, response)) {
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    if (isProduction) {
      sendJson(response, 200, { ok: true });
      return true;
    }
    sendJson(response, 200, {
      ok: true,
      dataDir,
      dbFile,
      appCount: db.prepare("SELECT COUNT(*) AS total FROM apps").get().total,
      authConfigured: credentialsReady(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    const session = getSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      username: session?.username || "",
      csrfToken: session?.csrfToken || "",
      credentialsReady: credentialsReady(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    if (!credentialsReady()) {
      sendJson(response, 503, {
        error: "后台登录未配置，请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD",
      });
      return true;
    }

    try {
      const body = JSON.parse(await readBody(request));
      const username = sanitizeText(body.username, 60);
      const password = String(body.password || "").trim();
      const ip = getRequestIp(request);
      const limitState = getLoginLimitState(ip);

      if (isProduction && limitState.blocked) {
        sendJson(response, 429, {
          error: `登录失败次数过多，请在 ${limitState.retryAfterSeconds} 秒后重试`,
          code: "LOGIN_RATE_LIMITED",
          retryAfterSeconds: limitState.retryAfterSeconds,
        });
        recordAudit("login_rate_limited", {
          request,
          username,
          status: "blocked",
          detail: { retryAfterSeconds: String(limitState.retryAfterSeconds) },
        });
        return true;
      }

      if (!safeEquals(username, adminUsername) || !safeEquals(password, adminPassword)) {
        const nextLimit = isProduction ? registerLoginFailure(ip) : { failures: 1, blockedUntil: 0 };
        recordAudit("login_failure", {
          request,
          username,
          status: "denied",
          detail: {
            failures: String(nextLimit.failures),
            blockedUntil: nextLimit.blockedUntil ? new Date(nextLimit.blockedUntil).toISOString() : "",
          },
        });
        sendJson(response, 401, { error: "账号或密码错误" });
        return true;
      }

      clearLoginFailures(ip);
      const issued = issueSession(username);
      recordAudit("login_success", {
        request,
        username,
        detail: { sessionCreated: "true" },
      });
      sendJson(
        response,
        200,
        { ok: true, username, csrfToken: issued.csrfToken },
        {
          "Set-Cookie": buildSessionCookie(issued.token),
        },
      );
    } catch (error) {
      sendJson(response, 400, { error: error.message || "登录失败" });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    const session = getSession(request);
    if (session && !requireCsrfToken(request, response, session)) {
      return true;
    }
    clearSession(session?.token);
    if (session) {
      recordAudit("logout", {
        request,
        username: session.username,
      });
    }
    sendJson(
      response,
      200,
      { ok: true },
      {
        "Set-Cookie": clearSessionCookie(),
      },
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/site-requests") {
    try {
      const limit = checkRequestLimit("site_request", getRequestIp(request), siteRequestLimit, siteRequestWindowMs);
      if (!limit.allowed) {
        recordAudit("site_request_rate_limited", {
          request,
          status: "blocked",
          detail: { retryAfterSeconds: String(limit.retryAfterSeconds) },
        });
        sendJson(response, 429, {
          error: `提交太频繁，请 ${limit.retryAfterSeconds} 秒后再试`,
          code: "SITE_REQUEST_RATE_LIMITED",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
        return true;
      }
      const body = JSON.parse(await readBody(request));
      const created = createSiteRequest(body);
      recordAudit("site_request_create", {
        request,
        status: "ok",
        detail: { name: created.name, website: created.website },
      });
      sendJson(response, 200, { ok: true, request: created });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "提交失败" });
    }
    return true;
  }

  if (url.pathname.startsWith("/api/admin/ops")) {
    const session = requireAdminSession(request, response);
    if (!session) {
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/ops/status") {
      sendJson(response, 200, getAdminOpsStatus());
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/ops/backup") {
      if (!requireCsrfToken(request, response, session)) {
        return true;
      }

      const snapshot = exportBackupSnapshot(session.username);
      const filename = `sparta-backup-${snapshot.exportedAt.replace(/[:.]/g, "-")}.json`;
      recordAudit("backup_export", {
        request,
        username: session.username,
        detail: {
          appCount: String(snapshot.apps.length),
          auditCount: String(snapshot.audits.length),
        },
      });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...securityHeaders,
      });
      response.end(JSON.stringify(snapshot, null, 2));
      return true;
    }

    sendJson(response, 404, { error: "接口不存在" });
    return true;
  }

  if (url.pathname.startsWith("/api/site-requests")) {
    const session = requireAdminSession(request, response);
    if (!session) {
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/site-requests") {
      sendJson(response, 200, { requests: getSiteRequests() });
      return true;
    }

    if (request.method === "PATCH" && /^\/api\/site-requests\/\d+$/.test(url.pathname)) {
      if (!requireCsrfToken(request, response, session)) {
        return true;
      }
      try {
        const id = Number(url.pathname.split("/").pop());
        const body = JSON.parse(await readBody(request));
        const updated = updateSiteRequestStatus(id, body.status);
        if (!updated) {
          sendJson(response, 404, { error: "留言不存在" });
          return true;
        }
        recordAudit("site_request_update", {
          request,
          username: session.username,
          targetId: String(id),
          detail: { status: updated.status, name: updated.name },
        });
        sendJson(response, 200, { ok: true, request: updated });
      } catch (error) {
        sendJson(response, 400, { error: error.message || "更新失败" });
      }
      return true;
    }

    if (request.method === "DELETE" && /^\/api\/site-requests\/\d+$/.test(url.pathname)) {
      if (!requireCsrfToken(request, response, session)) {
        return true;
      }
      const id = Number(url.pathname.split("/").pop());
      const existing = db.prepare("SELECT * FROM site_requests WHERE id = ?").get(id);
      if (!existing) {
        sendJson(response, 404, { error: "留言不存在" });
        return true;
      }
      deleteSiteRequest(id);
      recordAudit("site_request_delete", {
        request,
        username: session.username,
        targetId: String(id),
        detail: { name: existing.name },
      });
      sendJson(response, 200, { ok: true });
      return true;
    }

    sendJson(response, 404, { error: "接口不存在" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = cleanQuery(url.searchParams.get("q"));
    if (!query) {
      sendJson(response, 400, { error: "请输入需要查询的APP名称" });
      return true;
    }
    if (containsSensitive(query)) {
      sendJson(response, 200, { blocked: true, results: [] });
      return true;
    }
    sendJson(response, 200, { results: findResults(query) });
    return true;
  }

  if (!url.pathname.startsWith("/api/apps")) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "接口不存在" });
      return true;
    }
    return false;
  }

  const session = requireAdminSession(request, response);
  if (!session) {
    return true;
  }

  if (["POST", "PUT", "DELETE"].includes(request.method || "")) {
    if (!requireCsrfToken(request, response, session)) {
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/apps") {
    sendJson(response, 200, { apps: getAllApps() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/apps/export") {
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="app-addresses.csv"',
    });
    response.end(toCsv(getAllApps()));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/apps") {
    try {
      const body = JSON.parse(await readBody(request));
      const apps = getAllApps();
      const next = normalizeAppInput(body, null, session.username);
      assertAppValid(next, apps);
      insertApp(next);
      recordAudit("app_create", {
        request,
        username: session.username,
        targetId: next.id,
        detail: {
          name: next.name,
          reviewStatus: next.reviewStatus,
        },
      });
      sendJson(response, 201, { app: next });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "新增失败" });
    }
    return true;
  }

  const appMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (appMatch && request.method === "PUT") {
    const id = decodeURIComponent(appMatch[1]);
    const existing = getAppById(id);
    if (!existing) {
      sendJson(response, 404, { error: "未找到该APP" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const apps = getAllApps();
      const next = normalizeAppInput(body, existing, session.username);
      assertAppValid(next, apps, existing.id);
      updateApp(next);
      recordAudit("app_update", {
        request,
        username: session.username,
        targetId: next.id,
        detail: {
          name: next.name,
          reviewStatus: next.reviewStatus,
        },
      });
      sendJson(response, 200, { app: next });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "编辑失败" });
    }
    return true;
  }

  if (appMatch && request.method === "DELETE") {
    const id = decodeURIComponent(appMatch[1]);
    const result = deleteApp(id);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "未找到该APP" });
      return true;
    }
    recordAudit("app_delete", {
      request,
      username: session.username,
      targetId: id,
    });
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/apps/import") {
    try {
      const raw = await readBody(request);
      const contentType = request.headers["content-type"] || "";
      const { rows, rowOffset } = parseImportRows(raw, contentType);

      const skipped = [];
      const imported = [];
      const updated = getAllApps();
      const pendingInsertions = [];

      rows.forEach((row, index) => {
        try {
          const app = normalizeAppInput(row, null, session.username);
          assertAppValid(app, updated);
          updated.push(app);
          imported.push(app);
          pendingInsertions.push(app);
        } catch (error) {
          skipped.push({ row: Number(row.importRowNumber || index + rowOffset), error: error.message || "数据无效" });
        }
      });
      db.exec("BEGIN");
      try {
        pendingInsertions.forEach((app) => insertApp(app));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      recordAudit("app_import", {
        request,
        username: session.username,
        detail: {
          imported: String(imported.length),
          skipped: String(skipped.length),
        },
      });
      sendJson(response, 200, { imported, skipped });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "导入失败" });
    }
    return true;
  }

  sendJson(response, 404, { error: "接口不存在" });
  return true;
}

function fileForUrl(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "/index.html") {
    return join(root, "index.html");
  }
  if (pathname === "/admin" || pathname === "/admin/") {
    return join(root, "admin.html");
  }
  if (pathname.startsWith("/assets/")) {
    const assetName = pathname.slice("/assets/".length);
    const sourceCandidates = [
      join(root, "src", assetName),
      join(root, "dist", "assets", assetName),
    ];
    for (const candidate of sourceCandidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const requested = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const filePath = resolve(join(root, requested));
  return filePath.startsWith(root) ? filePath : join(root, "index.html");
}

function serveStatic(response, url) {
  const filePath = fileForUrl(url);
  const fallbackPath = join(root, "index.html");
  if (!filePath && url.pathname.startsWith("/assets/")) {
    sendText(response, 404, "Not Found");
    return;
  }
  const target = filePath && existsSync(filePath) && statSync(filePath).isFile() ? filePath : fallbackPath;
  const ext = extname(target);
  response.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    ...securityHeaders,
  });
  createReadStream(target).pipe(response);
}

function createAppServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${host}`);
    try {
      const handled = await handleApi(request, response, url);
      if (!handled) {
        serveStatic(response, url);
      }
    } catch (error) {
      console.error("[server-error]", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: error.message || "服务异常" });
        return;
      }
      response.end();
    }
  });
}

function listen(port) {
  const server = createAppServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`Prototype running at http://${host}:${port}`);
    console.log(`Admin running at http://${host}:${port}/admin`);
  });
}

listen(preferredPort);
