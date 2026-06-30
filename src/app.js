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

const elements = {
  input: document.querySelector("#searchInput"),
  form: document.querySelector("#searchForm"),
  clear: document.querySelector("#clearButton"),
  state: document.querySelector("#stateRegion"),
  toast: document.querySelector("#toast"),
  siteRequestForm: document.querySelector("#siteRequestForm"),
  siteRequestName: document.querySelector("#siteRequestName"),
  siteRequestWebsite: document.querySelector("#siteRequestWebsite"),
  siteRequestContact: document.querySelector("#siteRequestContact"),
  siteRequestNote: document.querySelector("#siteRequestNote"),
  siteRequestMessage: document.querySelector("#siteRequestMessage"),
  siteRequestToggle: document.querySelector("#siteRequestToggle"),
  siteRequestClose: document.querySelector("#siteRequestClose"),
  siteRequestPanel: document.querySelector("#siteRequestPanel"),
  routes: [...document.querySelectorAll(".app-screen")],
};

const hasBackend = location.protocol !== "file:";

let lastQuery = "";
let toastTimer = 0;
let searchTimer = 0;
let isComposing = false;

function track(eventName, payload = {}) {
  console.info("[prototype-track]", eventName, payload);
}

function cleanQuery(value) {
  return String(value || "")
    .trim()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function containsSensitive(query) {
  return sensitiveWords.some((word) => query.includes(word));
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 1800);
}

function setRequestMessage(message, type = "ok") {
  if (!elements.siteRequestMessage) return;
  elements.siteRequestMessage.textContent = message;
  elements.siteRequestMessage.dataset.type = type;
}

function setRequestPanelOpen(open) {
  if (!elements.siteRequestPanel || !elements.siteRequestToggle) return;
  elements.siteRequestPanel.hidden = !open;
  elements.siteRequestToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    elements.siteRequestName?.focus({ preventScroll: true });
  }
}

function setRoute(routeName) {
  elements.routes.forEach((route) => {
    route.hidden = route.dataset.route !== routeName;
  });
  if (routeName === "home") {
    elements.input.focus({ preventScroll: true });
  }
}

function clearNode(node) {
  node.replaceChildren();
}

function createElement(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.disabled) node.disabled = true;
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      node.dataset[key] = value;
    });
  }
  return node;
}

function renderInitial() {
  clearNode(elements.state);
  const wrapper = createElement("div", { className: "empty-state" });
  const inner = document.createElement("div");
  inner.append(
    createElement("div", { className: "empty-mark", text: "查" }),
    createElement("h3", { text: "输入APP名称，查询已审核官方地址" }),
    createElement("p", { text: "仅展示通过后台审核的官网与官方下载地址。" }),
    createElement("p", { className: "promise-line", text: "这里有你想要的" }),
  );
  wrapper.appendChild(inner);
  elements.state.appendChild(wrapper);
  track("home_view");
}

function renderLoading() {
  clearNode(elements.state);
  const wrapper = createElement("div", { className: "notice-state" });
  const inner = document.createElement("div");
  inner.append(
    createElement("div", { className: "loader" }),
    createElement("h3", { text: "正在检索官方地址..." }),
    createElement("p", { text: "仅返回已审核通过的官方链接。" }),
  );
  wrapper.appendChild(inner);
  elements.state.appendChild(wrapper);
}

function renderNotice({ type = "empty", mark = "查", title, body, retry = false }) {
  const className = type === "sensitive" ? "is-sensitive" : type === "error" ? "is-error" : "";
  clearNode(elements.state);
  const wrapper = createElement("div", { className: `notice-state ${className}`.trim() });
  const inner = document.createElement("div");
  inner.append(
    createElement("div", { className: "notice-mark", text: mark }),
    createElement("h3", { text: title }),
    createElement("p", { text: body }),
  );
  if (retry) {
    const retryButton = createElement("button", {
      className: "retry-button",
      type: "button",
      text: "重试",
    });
    retryButton.addEventListener("click", () => {
      runSearch(lastQuery || elements.input.value || "微信");
    });
    inner.appendChild(retryButton);
  }
  wrapper.appendChild(inner);
  elements.state.appendChild(wrapper);
}

function linkRowsFor(item) {
  const rows = [];
  if (item.officialSite) {
    rows.push({ label: "官方官网地址", url: item.officialSite, type: "official_site" });
  }
  if (item.android) {
    rows.push({ label: "安卓官方下载地址", url: item.android, type: "android_download" });
  }
  if (item.ios) {
    rows.push({ label: "iOS官方下载地址", url: item.ios, type: "ios_download" });
  }
  return rows;
}

function renderResults(results, query) {
  const hasValidLink = results.some((item) => item.valid);
  if (!hasValidLink) {
    renderNotice({
      type: "empty",
      mark: "失",
      title: "该APP暂无有效官方地址",
      body: "链接已失效，等待后台重新核验后展示。",
    });
    return;
  }

  clearNode(elements.state);
  const summary = createElement("div", { className: "summary-row" });
  summary.append(
    createElement("span", { text: `找到 ${results.length} 条官方结果` }),
    createElement("span", { text: "仅展示已审核通过项" }),
  );
  const resultsNode = createElement("div", { className: "results" });
  results.forEach((item) => {
    resultsNode.appendChild(renderResultCard(item));
  });
  elements.state.append(summary, resultsNode);
  track("search_success", { query, count: results.length });
}

function renderResultCard(item) {
  const article = createElement("article", {
    className: `result-card ${item.valid ? "" : "is-invalid"}`.trim(),
  });

  const head = createElement("div", { className: "app-head" });
  const icon = createElement("div", {
    className: "app-icon",
    text: item.icon || item.name.slice(0, 1) || "官",
  });
  const nameWrap = document.createElement("div");
  nameWrap.append(
    createElement("p", { className: "app-name", text: item.name }),
    createElement("span", { className: "badge", text: "官方" }),
  );
  const status = createElement("span", {
    className: `status-badge ${item.valid ? "" : "is-invalid"}`.trim(),
    text: item.valid ? "有效" : "失效",
  });
  head.append(icon, nameWrap, status);

  const panel = createElement("div", { className: "link-panel" });
  linkRowsFor(item).forEach((row) => {
    const invalid = !item.valid;
    const rowNode = createElement("div", {
      className: `link-row ${invalid ? "is-invalid" : ""}`.trim(),
      dataset: {
        url: row.url,
        type: row.type,
        valid: String(item.valid),
      },
    });
    const textWrap = document.createElement("div");
    textWrap.append(
      createElement("p", { className: "link-title", text: row.label }),
      createElement("p", {
        className: "link-url",
        text: invalid ? "链接已失效，等待重新审核" : row.url,
      }),
    );
    const button = createElement("button", {
      className: "link-action",
      type: "button",
      text: invalid ? "失效" : row.type === "android_download" ? "复制" : "打开",
      disabled: invalid,
    });
    rowNode.append(textWrap, button);
    panel.appendChild(rowNode);
  });

  const meta = createElement("div", { className: "meta-line" });
  meta.append(
    createElement("span", { text: `审核状态：${item.reviewStatus === "approved" ? "已通过" : "未通过"}` }),
    createElement("span", { text: item.reviewNote || "由后台人工审核后发布" }),
  );

  article.append(head, panel, meta);
  bindResultActions(article);
  return article;
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = url;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast("官方链接已复制");
  track("copy_link", { url });
}

function openLink(url, type) {
  showToast("正在打开系统浏览器");
  track("link_click", { url, type });
  window.open(url, "_blank", "noopener,noreferrer");
}

function bindResultActions(scope = document) {
  scope.querySelectorAll(".link-row").forEach((row) => {
    const url = row.dataset.url;
    const type = row.dataset.type;
    const valid = row.dataset.valid === "true";
    const button = row.querySelector(".link-action");

    button.addEventListener("click", () => {
      if (!valid) return;
      if (type === "android_download") {
        copyLink(url);
      } else {
        openLink(url, type);
      }
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!valid) return;
      copyLink(url);
    });
  });
}

async function fetchResults(query) {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "搜索失败");
  }
  return payload.results || [];
}

async function runSearch(rawQuery) {
  const query = cleanQuery(rawQuery);
  elements.input.value = query;
  updateClearButton();

  if (!query) {
    showToast("请输入需要查询的APP名称");
    return;
  }

  lastQuery = query;
  renderLoading();
  track("search_submit", { query });

  window.setTimeout(async () => {
    if (!hasBackend) {
      renderNotice({
        type: "error",
        mark: "库",
        title: "请通过本地服务使用信息库功能",
        body: "当前是 file:// 打开方式，无法连接后台。请运行本地服务后访问 http://127.0.0.1:4173。",
      });
      return;
    }

    if (containsSensitive(query)) {
      renderNotice({
        type: "sensitive",
        mark: "禁",
        title: "暂不支持查询该类软件，合规保护中",
        body: "系统已拦截该关键词，不返回任何结果。",
      });
      track("sensitive_block", { query });
      return;
    }

    try {
      const results = await fetchResults(query);
      if (results.length === 0) {
        renderNotice({
          type: "empty",
          mark: "空",
          title: "未查询到该APP的已审核官方地址",
          body: "请更换关键词，或等待后台补充审核后再试。",
        });
        track("empty_result", { query });
        return;
      }
      renderResults(results, query);
    } catch {
      renderNotice({
        type: "error",
        mark: "网",
        title: "服务暂时不可用",
        body: "当前无法连接地址信息库，请稍后重试。",
        retry: true,
      });
      track("network_error", { query });
    }
  }, 520);
}

function debouncedSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runSearch(elements.input.value), 300);
}

function updateClearButton() {
  elements.clear.classList.toggle("is-visible", elements.input.value.length > 0);
}

async function submitSiteRequest(event) {
  event.preventDefault();
  const name = elements.siteRequestName.value.trim();
  const website = elements.siteRequestWebsite.value.trim();
  const contact = elements.siteRequestContact.value.trim();
  const note = elements.siteRequestNote.value.trim();

  if (!name) {
    setRequestMessage("先填一个网站名称吧", "error");
    return;
  }
  if (!website && !note) {
    setRequestMessage("至少写网站地址或留言内容中的一项", "error");
    return;
  }

  if (!hasBackend) {
    setRequestMessage("当前是本地文件方式，无法提交留言，请通过本地服务打开", "error");
    return;
  }

  try {
    const response = await fetch("/api/site-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, website, contact, note }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "提交失败");
    }
    elements.siteRequestForm.reset();
    setRequestMessage("已收到，我会在后台查看", "ok");
    window.setTimeout(() => setRequestPanelOpen(false), 900);
  } catch (error) {
    setRequestMessage(error.message, "error");
  }
}

function cleanInputValue() {
  const cleaned = cleanQuery(elements.input.value);
  if (elements.input.value !== cleaned) {
    elements.input.value = cleaned;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  debouncedSearch();
});

elements.input.addEventListener("input", () => {
  if (!isComposing) {
    cleanInputValue();
  }
  updateClearButton();
});

elements.input.addEventListener("compositionstart", () => {
  isComposing = true;
});

elements.input.addEventListener("compositionend", () => {
  isComposing = false;
  cleanInputValue();
  updateClearButton();
});

elements.clear.addEventListener("click", () => {
  elements.input.value = "";
  updateClearButton();
  renderInitial();
  elements.input.focus();
});

if (elements.siteRequestForm) {
  elements.siteRequestForm.addEventListener("submit", submitSiteRequest);
}

if (elements.siteRequestToggle) {
  elements.siteRequestToggle.addEventListener("click", () => {
    const isOpen = elements.siteRequestToggle.getAttribute("aria-expanded") === "true";
    setRequestPanelOpen(!isOpen);
  });
}

if (elements.siteRequestClose) {
  elements.siteRequestClose.addEventListener("click", () => setRequestPanelOpen(false));
}

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => setRoute(button.dataset.page));
});

document.querySelectorAll(".back-button, .brand-button").forEach((button) => {
  button.addEventListener("click", () => setRoute("home"));
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setRoute("home");
  }
});

renderInitial();
updateClearButton();

window.prototypeSearch = {
  search: runSearch,
  lastQuery: () => lastQuery,
};
