const fields = {
  id: document.querySelector("#appId"),
  name: document.querySelector("#name"),
  aliases: document.querySelector("#aliases"),
  icon: document.querySelector("#icon"),
  officialSite: document.querySelector("#officialSite"),
  android: document.querySelector("#android"),
  ios: document.querySelector("#ios"),
  officialDomain: document.querySelector("#officialDomain"),
  valid: document.querySelector("#valid"),
  weight: document.querySelector("#weight"),
  reviewStatus: document.querySelector("#reviewStatus"),
  reviewNote: document.querySelector("#reviewNote"),
};

const authShell = document.querySelector("#authShell");
const adminContent = document.querySelector("#adminContent");
const loginForm = document.querySelector("#loginForm");
const loginUsername = document.querySelector("#loginUsername");
const loginPassword = document.querySelector("#loginPassword");
const loginMessage = document.querySelector("#loginMessage");
const sessionText = document.querySelector("#sessionText");
const logoutButton = document.querySelector("#logoutButton");
const appForm = document.querySelector("#appForm");
const appList = document.querySelector("#appList");
const adminSearch = document.querySelector("#adminSearch");
const formTitle = document.querySelector("#formTitle");
const resetButton = document.querySelector("#resetButton");
const formMessage = document.querySelector("#formMessage");
const importMessage = document.querySelector("#importMessage");
const importButton = document.querySelector("#importButton");
const csvText = document.querySelector("#csvText");
const csvFile = document.querySelector("#csvFile");
const listSummary = document.querySelector("#listSummary");
const exportButton = document.querySelector("#exportButton");
const refreshOpsButton = document.querySelector("#refreshOpsButton");
const backupButton = document.querySelector("#backupButton");
const opsCards = document.querySelector("#opsCards");
const opsMessage = document.querySelector("#opsMessage");
const requestsMessage = document.querySelector("#requestsMessage");
const requestList = document.querySelector("#requestList");
const refreshRequestsButton = document.querySelector("#refreshRequestsButton");
const backupMessage = document.querySelector("#backupMessage");
const auditLog = document.querySelector("#auditLog");

const hasBackend = location.protocol !== "file:";
const pipeImportFields = [
  "name",
  "aliases",
  "icon",
  "weight",
  "officialDomain",
  "officialSite",
  "android",
  "ios",
  "reviewStatus",
  "valid",
  "reviewNote",
];
const blockImportLabels = new Map([
  ["名称", "name"],
  ["app", "name"],
  ["APP", "name"],
  ["别名", "aliases"],
  ["图标", "icon"],
  ["权重", "weight"],
  ["官方主域名", "officialDomain"],
  ["主域名", "officialDomain"],
  ["域名", "officialDomain"],
  ["官网", "officialSite"],
  ["官方网站", "officialSite"],
  ["安卓下载", "android"],
  ["安卓", "android"],
  ["android", "android"],
  ["Android", "android"],
  ["iOS下载", "ios"],
  ["ios下载", "ios"],
  ["iOS", "ios"],
  ["ios", "ios"],
  ["审核状态", "reviewStatus"],
  ["有效", "valid"],
  ["审核备注", "reviewNote"],
  ["备注", "reviewNote"],
]);
let apps = [];
let siteRequests = [];
let currentSession = null;
let csrfToken = "";

function setMessage(node, message, type = "ok") {
  node.textContent = message;
  node.dataset.type = type;
}

function aliasesToText(value) {
  return Array.isArray(value) ? value.join(";") : "";
}

function getPayload() {
  return {
    name: fields.name.value.trim(),
    aliases: fields.aliases.value,
    icon: fields.icon.value.trim(),
    officialSite: fields.officialSite.value.trim(),
    android: fields.android.value.trim(),
    ios: fields.ios.value.trim(),
    officialDomain: fields.officialDomain.value.trim(),
    valid: fields.valid.checked,
    weight: Number(fields.weight.value || 50),
    reviewStatus: fields.reviewStatus.value,
    reviewNote: fields.reviewNote.value.trim(),
  };
}

function clearNode(node) {
  node.replaceChildren();
}

function createElement(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      node.dataset[key] = value;
    });
  }
  return node;
}

function withImportDefaults(row) {
  return {
    ...row,
    valid: row.valid || "true",
    reviewStatus: row.reviewStatus || "approved",
    reviewNote: row.reviewNote || "批量导入，已按官方域名核验",
  };
}

function parsePipeImport(text) {
  return text
    .split(/\r?\n/g)
    .map((line, index) => ({ line: line.trim(), rowNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, rowNumber }) => {
      const values = line.split("|").map((value) => value.trim());
      const row = Object.fromEntries(pipeImportFields.map((field, index) => [field, values[index] || ""]));
      return withImportDefaults({ ...row, importRowNumber: rowNumber });
    });
}

function splitImportBlocks(text) {
  const blocks = [];
  let current = [];
  let startLine = 1;

  text.split(/\r?\n/g).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      if (current.length) {
        blocks.push({ lines: current, startLine });
        current = [];
      }
      startLine = index + 2;
      return;
    }
    if (!current.length) startLine = index + 1;
    current.push(line);
  });

  if (current.length) {
    blocks.push({ lines: current, startLine });
  }
  return blocks;
}

function parseBlockLine(line) {
  const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
  if (!match) return null;
  const field = blockImportLabels.get(match[1].trim());
  if (!field) return null;
  return { field, value: match[2].trim() };
}

function isUrlLike(value) {
  return /^https?:\/\//i.test(value);
}

function isDomainLike(value) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);
}

function assignImportValue(row, value, lineIndex) {
  if (!value) return;

  if (isUrlLike(value)) {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "apps.apple.com") {
      row.ios ||= value;
      return;
    }
    if (/android|apk|download|mobile/i.test(value)) {
      row.android ||= value;
      return;
    }
    row.officialSite ||= value;
    return;
  }

  if (isDomainLike(value)) {
    row.officialDomain ||= value;
    return;
  }

  if (!row.name) {
    row.name = value;
    return;
  }

  if (lineIndex === 1 && value.length <= 2 && !row.icon) {
    row.icon = value;
    return;
  }

  row.aliases = row.aliases ? `${row.aliases};${value}` : value;
}

function parseBlockImport(text) {
  return splitImportBlocks(text).map((block, index) => {
    const row = {};
    block.lines.forEach((line, lineIndex) => {
      const parsed = parseBlockLine(line);
      if (parsed) {
        row[parsed.field] = parsed.value;
        return;
      }

      assignImportValue(row, line, lineIndex);
    });
    return withImportDefaults({
      ...row,
      importRowNumber: block.startLine,
      importGroupNumber: index + 1,
    });
  });
}

function parseTextImport(text) {
  return text.includes("|") ? parsePipeImport(text) : parseBlockImport(text);
}

function getPipeImportHint(row) {
  const missing = [];
  if (!row.name) missing.push("名称");
  if (!row.officialSite && !row.android) missing.push("官网/安卓地址至少一个");

  if (!missing.length) return "";
  const target = row.importGroupNumber ? `第 ${row.importGroupNumber} 组` : `第 ${row.importRowNumber} 行`;
  return `${target}缺少：${missing.join("、")}。最少这样写两行：APP名称、官网或安卓下载地址。`;
}

function getSkippedImportSummary(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return "";
  const details = skipped
    .slice(0, 3)
    .map((item) => `第 ${item.row} 行：${item.error || "数据无效"}`)
    .join("；");
  const suffix = skipped.length > 3 ? `；另有 ${skipped.length - 3} 条未显示` : "";
  return `。${details}${suffix}`;
}

function looksLikeCsv(text) {
  const firstLine = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean);
  return Boolean(firstLine && firstLine.toLowerCase().startsWith("name,"));
}

function getReviewLabel(status) {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已驳回";
  return "待审核";
}

function getReviewClass(status) {
  if (status === "approved") return "admin-review-approved";
  if (status === "rejected") return "admin-review-rejected";
  return "admin-review-pending";
}

function showAuthScreen() {
  authShell.hidden = false;
  adminContent.hidden = true;
  currentSession = null;
  csrfToken = "";
}

function showAdminContent(session) {
  authShell.hidden = true;
  adminContent.hidden = false;
  currentSession = session;
  csrfToken = session?.csrfToken || "";
  sessionText.textContent = session?.username ? `当前账号：${session.username}` : "";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isDuplicateDraft(payload, ignoreId = "") {
  const name = normalizeText(payload.name);
  const aliases = String(payload.aliases || "")
    .split(/[;,；，]/g)
    .map(normalizeText)
    .filter(Boolean);
  const links = [payload.officialSite, payload.android, payload.ios].map(normalizeText).filter(Boolean);

  return apps.find((item) => {
    if (item.id === ignoreId) return false;
    const itemName = normalizeText(item.name);
    const itemAliases = (Array.isArray(item.aliases) ? item.aliases : []).map(normalizeText);
    const itemLinks = [item.officialSite, item.android, item.ios].map(normalizeText).filter(Boolean);

    return (
      (name && (itemName === name || itemAliases.includes(name))) ||
      aliases.some((alias) => alias === itemName || itemAliases.includes(alias)) ||
      links.some((link) => itemLinks.includes(link))
    );
  });
}

function validatePayload(payload, ignoreId = "") {
  if (!payload.name) {
    return "APP标准名称不能为空";
  }

  if (!payload.officialDomain) {
    return "请填写官方主域名";
  }

  if (!payload.officialSite && !payload.android && !payload.ios) {
    return "至少填写一个官网或下载地址";
  }

  if (payload.reviewStatus === "approved") {
    if (!payload.valid) {
      return "审核通过的记录必须标记为可对外展示";
    }
    if (!payload.reviewNote) {
      return "审核通过时必须填写审核备注";
    }
    if (!payload.officialSite && !payload.android) {
      return "审核通过的记录至少需要官网或安卓官方地址之一";
    }
  }

  if (payload.reviewStatus === "rejected") {
    if (payload.valid) {
      return "已驳回记录不能标记为可对外展示";
    }
    if (!payload.reviewNote) {
      return "驳回记录必须填写驳回原因";
    }
  }

  if (payload.reviewStatus === "pending" && payload.valid) {
    return "待审核记录不能标记为可对外展示";
  }

  const duplicate = isDuplicateDraft(payload, ignoreId);
  if (duplicate) {
    return `检测到重复记录：${duplicate.name}`;
  }

  return "";
}

function resetForm() {
  appForm.reset();
  fields.id.value = "";
  fields.weight.value = "50";
  fields.reviewStatus.value = "pending";
  syncReviewControls();
  formTitle.textContent = "新增 APP 地址";
  setMessage(formMessage, "");
}

function syncReviewControls() {
  const status = fields.reviewStatus.value;

  if (status === "approved") {
    fields.valid.disabled = false;
    fields.valid.checked = true;
    fields.reviewNote.placeholder = "记录核验依据、域名归属、发布时间等审核说明";
    return;
  }

  fields.valid.checked = false;
  fields.valid.disabled = true;
  fields.reviewNote.placeholder =
    status === "rejected"
      ? "请写明驳回原因，例如域名不一致、链接失效、来源不可信"
      : "可选：记录待补充的信息或人工核验计划";
}

function bindDraftValidation() {
  const payload = getPayload();
  const message = validatePayload(payload, fields.id.value);
  if (!message) {
    if (formMessage.dataset.type === "error" && formMessage.textContent) {
      setMessage(formMessage, "");
    }
    return;
  }
  setMessage(formMessage, message, "error");
}

async function api(path, options = {}) {
  if (!hasBackend) {
    throw new Error("请通过本地服务打开后台：运行 server.mjs 后访问 http://127.0.0.1:4173/admin.html");
  }

  const method = (options.method || "GET").toUpperCase();
  const response = await fetch(path, {
    headers: {
      ...(method !== "GET" && method !== "HEAD" ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken && method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": csrfToken } : {}),
      ...(options.headers || {}),
    },
    credentials: "same-origin",
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showAuthScreen();
    throw new Error(payload.error || "登录状态已失效，请重新登录");
  }
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

async function ensureSession() {
  try {
    const payload = await api("/api/admin/session", {
      headers: {},
    });
    if (!payload.authenticated) {
      showAuthScreen();
      return false;
    }
    showAdminContent(payload);
    return true;
  } catch (error) {
    showAuthScreen();
    setMessage(loginMessage, error.message, "error");
    return false;
  }
}

async function loadApps() {
  try {
    const payload = await api("/api/apps");
    apps = payload.apps || [];
    renderList();
  } catch (error) {
    clearNode(appList);
    const empty = createElement("div", { className: "admin-empty", text: error.message });
    appList.appendChild(empty);
    listSummary.textContent = "信息库未连接";
  }
}

function renderList() {
  const keyword = adminSearch.value.trim().toLowerCase();
  const filtered = apps.filter((item) => {
    const text = [
      item.name,
      aliasesToText(item.aliases),
      item.officialSite,
      item.android,
      item.ios,
      item.officialDomain,
      item.reviewNote,
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(keyword);
  });

  listSummary.textContent = `共 ${apps.length} 条，当前显示 ${filtered.length} 条`;

  clearNode(appList);
  if (filtered.length === 0) {
    appList.appendChild(createElement("div", { className: "admin-empty", text: "暂无匹配数据" }));
    return;
  }

  filtered.forEach((item) => {
    const article = createElement("article", {
      className: "admin-app-row",
      dataset: { id: item.id },
    });
    article.dataset.id = item.id;

    const icon = createElement("div", {
      className: "admin-app-icon",
      text: item.icon || item.name.slice(0, 1) || "官",
    });

    const main = createElement("div", { className: "admin-app-main" });
    const head = createElement("div", { className: "admin-app-head" });

    const title = createElement("strong", { text: item.name });
    const validity = createElement("span", {
      className: item.valid ? "admin-valid" : "admin-invalid",
      text: item.valid ? "有效" : "失效",
    });
    const review = createElement("span", {
      className: getReviewClass(item.reviewStatus),
      text: getReviewLabel(item.reviewStatus),
    });
    const weight = createElement("span", { text: `权重 ${item.weight ?? 50}` });

    head.append(title, validity, review, weight);

    const aliasLine = createElement("p", { text: aliasesToText(item.aliases) || "暂无别名" });
    const domainLine = createElement("p", { text: `官方域名：${item.officialDomain || "未填写"}` });
    const siteLine = createElement("p", { text: item.officialSite || "暂无官网" });
    const noteLine = createElement("p", { text: item.reviewNote || "暂无审核备注" });

    main.append(head, aliasLine, domainLine, siteLine, noteLine);

    const actions = createElement("div", { className: "row-actions" });
    const editButton = createElement("button", {
      type: "button",
      text: "编辑",
      dataset: { action: "edit" },
    });
    const deleteButton = createElement("button", {
      type: "button",
      text: "删除",
      dataset: { action: "delete" },
    });
    actions.append(editButton, deleteButton);

    article.append(icon, main, actions);
    appList.appendChild(article);
  });
}

function createMetricCard(label, value, helper = "") {
  const article = createElement("article", { className: "ops-card" });
  article.append(
    createElement("span", { className: "ops-card-label", text: label }),
    createElement("strong", { className: "ops-card-value", text: value }),
  );
  if (helper) {
    article.appendChild(createElement("p", { className: "ops-card-helper", text: helper }));
  }
  return article;
}

function renderAuditLog(records = []) {
  clearNode(auditLog);
  if (!records.length) {
    auditLog.appendChild(createElement("div", { className: "admin-empty", text: "暂无审计记录" }));
    return;
  }

  records.forEach((item) => {
    const row = createElement("article", { className: "audit-item" });
    const head = createElement("div", { className: "audit-item-head" });
    head.append(
      createElement("strong", { text: item.action || "unknown" }),
      createElement("span", { text: item.createdAt || "" }),
    );

    const meta = [
      item.username ? `账号：${item.username}` : "",
      item.targetId ? `目标：${item.targetId}` : "",
      item.status ? `状态：${item.status}` : "",
      item.ip ? `来源：${item.ip}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    row.append(
      head,
      createElement("p", { className: "audit-item-meta", text: meta || "无附加信息" }),
      createElement("p", {
        className: "audit-item-detail",
        text:
          item.detail && Object.keys(item.detail).length
            ? Object.entries(item.detail)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : "无详细字段",
      }),
    );
    auditLog.appendChild(row);
  });
}

function formatRequestStatus(status) {
  if (status === "reviewed") return "已查看";
  if (status === "archived") return "已归档";
  return "新留言";
}

function renderRequestList(records = []) {
  clearNode(requestList);
  if (!records.length) {
    requestList.appendChild(createElement("div", { className: "admin-empty", text: "暂无网站建议" }));
    return;
  }

  records.forEach((item) => {
    const row = createElement("article", {
      className: "audit-item request-item",
      dataset: { id: String(item.id) },
    });
    const head = createElement("div", { className: "audit-item-head" });
    head.append(
      createElement("strong", { text: item.name || "未命名" }),
      createElement("span", { text: item.createdAt || "" }),
    );

    const meta = [
      item.status ? `状态：${formatRequestStatus(item.status)}` : "",
      item.website ? `网站：${item.website}` : "",
      item.contact ? `联系：${item.contact}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const actions = createElement("div", { className: "row-actions" });
    actions.append(
      createElement("button", { type: "button", text: "标记已看", dataset: { action: "review-request" } }),
      createElement("button", { type: "button", text: "归档", dataset: { action: "archive-request" } }),
      createElement("button", { type: "button", text: "删除", dataset: { action: "delete-request" } }),
    );

    row.append(
      head,
      createElement("p", { className: "audit-item-meta", text: meta || "无附加信息" }),
      createElement("p", {
        className: "audit-item-detail",
        text: item.note || "无留言内容",
      }),
      actions,
    );
    requestList.appendChild(row);
  });
}

function renderOpsStatus(payload) {
  clearNode(opsCards);
  [
    createMetricCard("运行环境", payload.environment === "production" ? "生产" : "开发"),
    createMetricCard("总记录数", String(payload.counts?.total ?? 0)),
    createMetricCard("已通过", String(payload.counts?.approved ?? 0)),
    createMetricCard("待审核", String(payload.counts?.pending ?? 0)),
    createMetricCard("已驳回", String(payload.counts?.rejected ?? 0)),
    createMetricCard("活跃会话", String(payload.counts?.activeSessions ?? 0)),
    createMetricCard("审计条数", String(payload.counts?.auditCount ?? 0)),
    createMetricCard(
      "最近备份",
      payload.lastBackupAt || "尚未导出",
      payload.lastBackupAt ? "建议同步保存到云盘或本地磁盘" : "上线前至少先导出一份",
    ),
  ].forEach((card) => opsCards.appendChild(card));

  renderAuditLog(payload.recentAudits || []);
}

async function loadSiteRequests() {
  try {
    const payload = await api("/api/site-requests", {
      headers: {},
    });
    siteRequests = payload.requests || [];
    renderRequestList(siteRequests);
    setMessage(requestsMessage, "留言已刷新");
  } catch (error) {
    clearNode(requestList);
    requestList.appendChild(createElement("div", { className: "admin-empty", text: error.message }));
    setMessage(requestsMessage, error.message, "error");
  }
}

async function loadOpsStatus() {
  try {
    const payload = await api("/api/admin/ops/status", {
      headers: {},
    });
    renderOpsStatus(payload);
    setMessage(opsMessage, "运行状态已刷新");
  } catch (error) {
    clearNode(opsCards);
    opsCards.appendChild(createElement("div", { className: "admin-empty", text: error.message }));
    setMessage(opsMessage, error.message, "error");
  }
}

function editApp(id) {
  const item = apps.find((app) => app.id === id);
  if (!item) return;
  fields.id.value = item.id;
  fields.name.value = item.name || "";
  fields.aliases.value = aliasesToText(item.aliases);
  fields.icon.value = item.icon || "";
  fields.officialSite.value = item.officialSite || "";
  fields.android.value = item.android || "";
  fields.ios.value = item.ios || "";
  fields.officialDomain.value = item.officialDomain || "";
  fields.valid.checked = Boolean(item.valid);
  fields.weight.value = item.weight ?? 50;
  fields.reviewStatus.value = item.reviewStatus || "pending";
  fields.reviewNote.value = item.reviewNote || "";
  syncReviewControls();
  formTitle.textContent = `编辑：${item.name}`;
  setMessage(formMessage, "正在编辑现有地址，保存后会覆盖并更新审核信息。", "info");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function findRequestById(id) {
  return siteRequests.find((item) => String(item.id) === String(id));
}

async function updateRequestStatus(id, status) {
  try {
    await api(`/api/site-requests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await loadSiteRequests();
  } catch (error) {
    setMessage(requestsMessage, error.message, "error");
  }
}

async function deleteRequest(id) {
  const item = findRequestById(id);
  if (!item) return;
  const confirmed = window.confirm(`确认删除留言“${item.name}”？`);
  if (!confirmed) return;

  try {
    await api(`/api/site-requests/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await loadSiteRequests();
  } catch (error) {
    setMessage(requestsMessage, error.message, "error");
  }
}

async function deleteApp(id) {
  const item = apps.find((app) => app.id === id);
  if (!item) return;
  const confirmed = window.confirm(`确认删除“${item.name}”？`);
  if (!confirmed) return;

  try {
    await api(`/api/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
    setMessage(formMessage, `已删除：${item.name}`);
    if (fields.id.value === id) resetForm();
    await loadApps();
    await loadOpsStatus();
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
}

appForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = getPayload();
    const id = fields.id.value;
    const validationError = validatePayload(payload, id);
    if (validationError) {
      setMessage(formMessage, validationError, "error");
      return;
    }
    const path = id ? `/api/apps/${encodeURIComponent(id)}` : "/api/apps";
    const method = id ? "PUT" : "POST";
    await api(path, {
      method,
      body: JSON.stringify(payload),
    });
    setMessage(formMessage, id ? "已保存修改" : "已添加到信息库");
    resetForm();
    await loadApps();
    await loadOpsStatus();
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
});

resetButton.addEventListener("click", resetForm);

Object.values(fields).forEach((field) => {
  field.addEventListener("input", bindDraftValidation);
  field.addEventListener("change", bindDraftValidation);
});

fields.reviewStatus.addEventListener("change", () => {
  syncReviewControls();
  bindDraftValidation();
});

adminSearch.addEventListener("input", renderList);

exportButton.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/apps/export", {
      credentials: "same-origin",
    });
    const text = await response.text();
    if (response.status === 401) {
      showAuthScreen();
      throw new Error("登录状态已失效，请重新登录");
    }
    if (!response.ok) {
      throw new Error(text || "导出失败");
    }

    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `app-addresses-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    setMessage(importMessage, "已导出当前信息库 CSV");
  } catch (error) {
    setMessage(importMessage, error.message, "error");
  }
});

appList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const row = event.target.closest(".admin-app-row");
  if (!button || !row) return;

  if (button.dataset.action === "edit") {
    editApp(row.dataset.id);
  }
  if (button.dataset.action === "delete") {
    deleteApp(row.dataset.id);
  }
});

requestList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const row = event.target.closest(".request-item");
  if (!button || !row) return;

  const id = row.dataset.id;
  if (!id) return;

  if (button.dataset.action === "review-request") {
    updateRequestStatus(id, "reviewed");
  }
  if (button.dataset.action === "archive-request") {
    updateRequestStatus(id, "archived");
  }
  if (button.dataset.action === "delete-request") {
    deleteRequest(id);
  }
});

csvFile.addEventListener("change", async () => {
  const file = csvFile.files?.[0];
  if (!file) return;
  csvText.value = await file.text();
  setMessage(importMessage, `已读取文件：${file.name}`, "info");
});

importButton.addEventListener("click", async () => {
  try {
    const text = csvText.value.trim();
    if (!text) {
      setMessage(importMessage, "请先粘贴批量内容或选择CSV文件", "error");
      return;
    }

    const isCsv = looksLikeCsv(text);
    const pipeRows = isCsv ? [] : parseTextImport(text);
    const pipeHint = pipeRows.map(getPipeImportHint).find(Boolean);
    if (pipeHint) {
      setMessage(importMessage, pipeHint, "error");
      return;
    }

    const body = isCsv ? text : JSON.stringify({ apps: pipeRows });
    const response = await fetch("/api/apps/import", {
      method: "POST",
      headers: {
        "Content-Type": isCsv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      credentials: "same-origin",
      body,
    });
    const payload = await response.json();
    if (response.status === 401) {
      showAuthScreen();
      throw new Error(payload.error || "登录状态已失效，请重新登录");
    }
    if (!response.ok) {
      throw new Error(payload.error || "导入失败");
    }
    setMessage(
      importMessage,
      `导入成功 ${payload.imported.length} 条，跳过 ${payload.skipped.length} 条${getSkippedImportSummary(payload.skipped)}`,
      payload.skipped.length ? "error" : "ok",
    );
    await loadApps();
    await loadOpsStatus();
  } catch (error) {
    setMessage(importMessage, error.message, "error");
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(loginMessage, "正在登录...", "info");
  try {
    const payload = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: loginUsername.value.trim(),
        password: loginPassword.value.trim(),
      }),
    });
    loginPassword.value = "";
    showAdminContent(payload);
    setMessage(loginMessage, "登录成功");
    await loadApps();
    await loadOpsStatus();
  } catch (error) {
    setMessage(loginMessage, error.message, "error");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", {
      method: "POST",
    });
  } catch {
    // no-op
  }
  showAuthScreen();
  setMessage(loginMessage, "已退出登录", "info");
});

refreshOpsButton.addEventListener("click", async () => {
  setMessage(opsMessage, "正在刷新运行状态...", "info");
  await loadOpsStatus();
});

refreshRequestsButton.addEventListener("click", async () => {
  setMessage(requestsMessage, "正在刷新留言...", "info");
  await loadSiteRequests();
});

backupButton.addEventListener("click", async () => {
  try {
    setMessage(backupMessage, "正在生成备份文件...", "info");
    const response = await fetch("/api/admin/ops/backup", {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfToken,
      },
      credentials: "same-origin",
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }

    if (response.status === 401) {
      showAuthScreen();
      throw new Error(payload.error || "登录状态已失效，请重新登录");
    }
    if (!response.ok) {
      throw new Error(payload.error || "备份导出失败");
    }

    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `sparta-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    setMessage(backupMessage, "备份文件已导出");
    await loadOpsStatus();
  } catch (error) {
    setMessage(backupMessage, error.message, "error");
  }
});

async function initAdmin() {
  syncReviewControls();
  const hasSession = await ensureSession();
  if (hasSession) {
    await loadApps();
    await loadOpsStatus();
    await loadSiteRequests();
  }
}

initAdmin().catch((error) => {
  showAuthScreen();
  setMessage(loginMessage, error.message || "后台初始化失败", "error");
  console.error("[admin-init-error]", error);
});
