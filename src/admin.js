const fields = {
  id: document.querySelector("#appId"),
  name: document.querySelector("#name"),
  aliases: document.querySelector("#aliases"),
  icon: document.querySelector("#icon"),
  officialSite: document.querySelector("#officialSite"),
  android: document.querySelector("#android"),
  ios: document.querySelector("#ios"),
  valid: document.querySelector("#valid"),
  weight: document.querySelector("#weight"),
};

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

const hasBackend = location.protocol !== "file:";
let apps = [];

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
    valid: fields.valid.checked,
    weight: Number(fields.weight.value || 50),
  };
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

  if (!payload.officialSite && !payload.android && !payload.ios) {
    return "至少填写一个官网或下载地址";
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
  fields.valid.checked = true;
  formTitle.textContent = "新增 APP 地址";
  setMessage(formMessage, "");
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

  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

async function loadApps() {
  try {
    const payload = await api("/api/apps");
    apps = payload.apps || [];
    renderList();
  } catch (error) {
    appList.innerHTML = `<div class="admin-empty">${error.message}</div>`;
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
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(keyword);
  });

  listSummary.textContent = `共 ${apps.length} 条，当前显示 ${filtered.length} 条`;

  if (filtered.length === 0) {
    appList.innerHTML = `<div class="admin-empty">暂无匹配数据</div>`;
    return;
  }

  appList.innerHTML = filtered
    .map(
      (item) => `
        <article class="admin-app-row" data-id="${item.id}">
          <div class="admin-app-icon">${item.icon || item.name.slice(0, 1) || "官"}</div>
          <div class="admin-app-main">
            <div class="admin-app-head">
              <strong>${item.name}</strong>
              <span class="${item.valid ? "admin-valid" : "admin-invalid"}">${item.valid ? "有效" : "失效"}</span>
              <span>权重 ${item.weight ?? 50}</span>
            </div>
            <p>${aliasesToText(item.aliases) || "暂无别名"}</p>
            <p>${item.officialSite || "暂无官网"}</p>
          </div>
          <div class="row-actions">
            <button type="button" data-action="edit">编辑</button>
            <button type="button" data-action="delete">删除</button>
          </div>
        </article>
      `,
    )
    .join("");
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
  fields.valid.checked = Boolean(item.valid);
  fields.weight.value = item.weight ?? 50;
  formTitle.textContent = `编辑：${item.name}`;
  setMessage(formMessage, "正在编辑现有地址，保存后会覆盖该条记录。", "info");
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  } catch (error) {
    setMessage(formMessage, error.message, "error");
  }
});

resetButton.addEventListener("click", resetForm);

Object.values(fields).forEach((field) => {
  field.addEventListener("input", bindDraftValidation);
  field.addEventListener("change", bindDraftValidation);
});

adminSearch.addEventListener("input", renderList);

exportButton.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/apps/export");
    const text = await response.text();
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
      setMessage(importMessage, "请先粘贴CSV内容或选择CSV文件", "error");
      return;
    }

    const response = await fetch("/api/apps/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv; charset=utf-8" },
      body: text,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "导入失败");
    }
    setMessage(
      importMessage,
      `导入成功 ${payload.imported.length} 条，跳过 ${payload.skipped.length} 条`,
      payload.skipped.length ? "info" : "ok",
    );
    await loadApps();
  } catch (error) {
    setMessage(importMessage, error.message, "error");
  }
});

loadApps();
