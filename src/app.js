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
  routes: [...document.querySelectorAll(".app-screen")],
};

const hasBackend = location.protocol !== "file:";

let lastQuery = "";
let toastTimer = 0;
let searchTimer = 0;

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

function setRoute(routeName) {
  elements.routes.forEach((route) => {
    route.hidden = route.dataset.route !== routeName;
  });
  if (routeName === "home") {
    elements.input.focus({ preventScroll: true });
  }
}

function renderInitial() {
  elements.state.innerHTML = `
    <div class="empty-state">
      <div>
        <div class="empty-mark">查</div>
        <h3>输入APP名称，一键查询官方地址</h3>
        <p>仅展示人工核验的官网与官方下载地址。</p>
      </div>
    </div>
  `;
  track("home_view");
}

function renderLoading() {
  elements.state.innerHTML = `
    <div class="notice-state">
      <div>
        <div class="loader" aria-hidden="true"></div>
        <h3>正在检索官方地址中...</h3>
        <p>正在过滤广告、第三方平台和失效链接。</p>
      </div>
    </div>
  `;
}

function renderNotice({ type = "empty", mark = "查", title, body, retry = false }) {
  const className = type === "sensitive" ? "is-sensitive" : type === "error" ? "is-error" : "";
  elements.state.innerHTML = `
    <div class="notice-state ${className}">
      <div>
        <div class="notice-mark">${mark}</div>
        <h3>${title}</h3>
        <p>${body}</p>
        ${retry ? '<button class="retry-button" type="button" id="retryButton">刷新</button>' : ""}
      </div>
    </div>
  `;

  const retryButton = document.querySelector("#retryButton");
  if (retryButton) {
    retryButton.addEventListener("click", () => {
      elements.input.value = "微信";
      updateClearButton();
      runSearch("微信");
    });
  }
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

  elements.state.innerHTML = `
    <div class="summary-row">
      <span>找到 ${results.length} 条官方结果</span>
      <span>最多展示 Top5</span>
    </div>
    <div class="results">
      ${results.map(renderResultCard).join("")}
    </div>
  `;

  bindResultActions();
  track("search_success", { query, count: results.length });
}

function renderResultCard(item) {
  const linkRows = linkRowsFor(item)
    .map((row) => {
      const invalid = !item.valid;
      const buttonLabel = invalid ? "失效" : row.type === "android_download" ? "复制" : "打开";
      return `
        <div class="link-row ${invalid ? "is-invalid" : ""}" data-url="${row.url}" data-type="${row.type}" data-valid="${item.valid}">
          <div>
            <p class="link-title">${row.label}</p>
            <p class="link-url">${invalid ? "链接已失效，等待更新" : row.url}</p>
          </div>
          <button class="link-action" type="button" ${invalid ? "disabled" : ""}>${buttonLabel}</button>
        </div>
      `;
    })
    .join("");

  return `
    <article class="result-card ${item.valid ? "" : "is-invalid"}">
      <div class="app-head">
        <div class="app-icon">${item.icon || item.name.slice(0, 1) || "官"}</div>
        <div>
          <p class="app-name">${item.name}</p>
          <span class="badge">官方</span>
        </div>
        <span class="status-badge ${item.valid ? "" : "is-invalid"}">${item.valid ? "有效" : "失效"}</span>
      </div>
      <div class="link-panel">${linkRows}</div>
      <div class="meta-line">
        <span>每日凌晨自动校验</span>
        <span>${item.valid ? "人工核验 + 自动更新" : "已自动下架"}</span>
      </div>
    </article>
  `;
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

function bindResultActions() {
  document.querySelectorAll(".link-row").forEach((row) => {
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

    if (query.includes("断网") || query.toLowerCase().includes("network")) {
      renderNotice({
        type: "error",
        mark: "网",
        title: "网络异常，请检查网络",
        body: "弱网或无网络时不会崩溃，可刷新后重试。",
        retry: true,
      });
      track("network_error", { query });
      return;
    }

    try {
      const results = await fetchResults(query);
      if (results.length === 0) {
        renderNotice({
          type: "empty",
          mark: "空",
          title: "未查询到该APP官方正规地址，请更换关键词重试",
          body: "后台会统计空结果，用于补充缺失 APP 数据。",
        });
        track("empty_result", { query });
        return;
      }
      renderResults(results, query);
    } catch {
      renderNotice({
        type: "error",
        mark: "网",
        title: "网络异常，请检查网络",
        body: "无法连接本地信息库服务，请确认后端已启动。",
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

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  debouncedSearch();
});

elements.input.addEventListener("input", () => {
  const cleaned = cleanQuery(elements.input.value);
  if (elements.input.value !== cleaned) {
    elements.input.value = cleaned;
  }
  updateClearButton();
});

elements.clear.addEventListener("click", () => {
  elements.input.value = "";
  updateClearButton();
  renderInitial();
  elements.input.focus();
});

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
