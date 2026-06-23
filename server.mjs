import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, "data");
const appsFile = join(dataDir, "apps.json");
const preferredPort = Number(process.env.PORT || 4173);

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

function cleanQuery(value) {
  return String(value || "")
    .trim()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function normalizeQuery(query) {
  const lower = query.toLowerCase();
  return correctionMap.get(query) || correctionMap.get(lower) || query;
}

function containsSensitive(query) {
  return sensitiveWords.some((word) => query.includes(word));
}

function ensureDataFile() {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(appsFile)) {
    writeFileSync(appsFile, "[]\n", "utf8");
  }
}

function readApps() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(readFileSync(appsFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeApps(apps) {
  ensureDataFile();
  writeFileSync(appsFile, `${JSON.stringify(apps, null, 2)}\n`, "utf8");
}

function makeId(name) {
  const safe = String(name || "app")
    .trim()
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `app_${safe || "item"}_${Date.now().toString(36)}`;
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[;,；，]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCompare(value) {
  return String(value || "").trim().toLowerCase();
}

function getLinks(app) {
  return [app.officialSite, app.android, app.ios].map(normalizeCompare).filter(Boolean);
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

function assertAppValid(app, apps, ignoreId = "") {
  if (!app.officialSite && !app.android && !app.ios) {
    throw new Error("至少填写一个官网或下载地址");
  }

  const duplicate = findDuplicate(app, apps, ignoreId);
  if (duplicate) {
    throw new Error(`存在重复记录：${duplicate.name}`);
  }
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "true").trim().toLowerCase();
  return !["false", "0", "否", "无效", "invalid"].includes(text);
}

function normalizeApp(input, existing = {}) {
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("APP标准名称不能为空");
  }

  return {
    id: existing.id || input.id || makeId(name),
    name,
    aliases: normalizeAliases(input.aliases),
    icon: String(input.icon || name.slice(0, 1) || "官").trim().slice(0, 1),
    officialSite: String(input.officialSite || "").trim(),
    android: String(input.android || "").trim(),
    ios: String(input.ios || "").trim(),
    valid: normalizeBoolean(input.valid),
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 50,
    updatedAt: new Date().toISOString(),
  };
}

function findResults(query, apps) {
  const normalized = normalizeQuery(query);
  const lower = normalized.toLowerCase();

  return apps
    .filter((item) => {
      if (lower === "app" || normalized === "软件") return item.valid;
      if (item.name.includes(normalized)) return true;
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      return aliases.some((alias) => {
        const normalizedAlias = String(alias).toLowerCase();
        return normalizedAlias.includes(lower) || lower.includes(normalizedAlias);
      });
    })
    .sort((a, b) => Number(b.valid) - Number(a.valid) || Number(b.weight || 0) - Number(a.weight || 0))
    .slice(0, 5);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
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

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function toCsv(apps) {
  const headers = ["name", "aliases", "icon", "officialSite", "android", "ios", "valid", "weight"];
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
        String(Boolean(app.valid)),
        String(app.weight ?? 50),
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

async function handleApi(request, response, url) {
  const apps = readApps();

  if (request.method === "GET" && url.pathname === "/api/apps") {
    sendJson(response, 200, { apps });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/apps/export") {
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="app-addresses.csv"',
    });
    response.end(toCsv(apps));
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
    sendJson(response, 200, { results: findResults(query, apps) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/apps") {
    try {
      const body = JSON.parse(await readBody(request));
      const next = normalizeApp(body);
      assertAppValid(next, apps);
      const updated = [...apps, next];
      writeApps(updated);
      sendJson(response, 201, { app: next });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "新增失败" });
    }
    return true;
  }

  const appMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (appMatch && request.method === "PUT") {
    const id = decodeURIComponent(appMatch[1]);
    const index = apps.findIndex((item) => item.id === id);
    if (index === -1) {
      sendJson(response, 404, { error: "未找到该APP" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const next = normalizeApp(body, apps[index]);
      assertAppValid(next, apps, apps[index].id);
      const updated = [...apps];
      updated[index] = next;
      writeApps(updated);
      sendJson(response, 200, { app: next });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "编辑失败" });
    }
    return true;
  }

  if (appMatch && request.method === "DELETE") {
    const id = decodeURIComponent(appMatch[1]);
    const updated = apps.filter((item) => item.id !== id);
    if (updated.length === apps.length) {
      sendJson(response, 404, { error: "未找到该APP" });
      return true;
    }
    writeApps(updated);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/apps/import") {
    try {
      const raw = await readBody(request);
      const contentType = request.headers["content-type"] || "";
      const rows = contentType.includes("application/json")
        ? JSON.parse(raw).apps || []
        : parseCsv(raw);

      const skipped = [];
      const imported = [];
      const updated = [...apps];

      rows.forEach((row, index) => {
        try {
          const app = normalizeApp(row);
          assertAppValid(app, updated);
          updated.push(app);
          imported.push(app);
        } catch (error) {
          skipped.push({ row: index + 2, error: error.message || "数据无效" });
        }
      });

      writeApps(updated);
      sendJson(response, 200, { imported, skipped });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "导入失败" });
    }
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "接口不存在" });
    return true;
  }

  return false;
}

function fileForUrl(url) {
  const pathname = decodeURIComponent(url.pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const requested = normalized === "/" ? "/index.html" : normalized;
  const filePath = resolve(join(root, requested));
  return filePath.startsWith(root) ? filePath : join(root, "index.html");
}

function serveStatic(response, url) {
  const filePath = fileForUrl(url);
  const fallbackPath = join(root, "index.html");
  const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : fallbackPath;
  const ext = extname(target);
  response.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(target).pipe(response);
}

function createAppServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    try {
      const handled = await handleApi(request, response, url);
      if (!handled) serveStatic(response, url);
    } catch (error) {
      sendJson(response, 500, { error: error.message || "服务异常" });
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
  server.listen(port, "127.0.0.1", () => {
    console.log(`Prototype running at http://127.0.0.1:${port}`);
    console.log(`Admin running at http://127.0.0.1:${port}/admin.html`);
  });
}

ensureDataFile();
listen(preferredPort);
