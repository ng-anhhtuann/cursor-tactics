(() => {
  const SETTINGS_KEY = "cursorUsageTrackerSettings";
  const DATA_KEY = "cursorUsageTrackerData";
  const UI_KEY = "cursorUsageTrackerUiState";

  const DEFAULT_SETTINGS = {
    targetUrlPattern: "https://cursor.com/dashboard/usage*",
    planTokenLimit: null,
    pricingPer1M: {}
  };

  const DEFAULT_DATA = {
    records: [],
    recordIds: {},
    lastUpdated: 0,
    rangeText: ""
  };

  let settings = { ...DEFAULT_SETTINGS };
  let data = { ...DEFAULT_DATA };
  let overlay = null;
  let ui = null;
  let observer = null;
  let refreshTimer = null;
  let pollTimer = null;
  let currentUrl = location.href;
  const sessionRecordIds = new Set();
  const sessionStartedAt = Date.now();

  init().catch((error) => {
    console.error("[Cursor Usage Tracker] init failed:", error);
  });

  async function init() {
    settings = applySettings(await storageGet(SETTINGS_KEY));
    data = applyData(await storageGet(DATA_KEY));
    bindStorageListener();
    bindRouteListener();
    await handleActivation();
  }

  function bindStorageListener() {
    if (!chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[SETTINGS_KEY]) {
        settings = applySettings(changes[SETTINGS_KEY].newValue);
        handleActivation();
      }
      if (changes[DATA_KEY]) {
        data = applyData(changes[DATA_KEY].newValue);
        if (overlay) render();
      }
      if (changes[UI_KEY] && overlay) {
        applyUiState(changes[UI_KEY].newValue);
      }
    });
  }

  function bindRouteListener() {
    const check = () => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        handleActivation();
      }
    };

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      check();
      return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      check();
      return result;
    };

    window.addEventListener("popstate", check);
  }

  async function handleActivation() {
    if (!matchesPattern(location.href, settings.targetUrlPattern)) {
      teardownOverlay();
      disconnectObserver();
      stopPolling();
      return;
    }

    ensureOverlay();
    await refreshData();
    connectObserver();
    startPolling();
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("section");
    overlay.id = "cursor-usage-tracker";
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML = `
      <div class="cut-header">
        <div class="cut-title-wrap">
          <div class="cut-title">Usage Tracker</div>
          <div class="cut-subtitle" data-cut-range></div>
        </div>
        <div class="cut-header-actions">
          <!-- <button class="cut-button cut-button-ghost" data-action="options" type="button">Options</button> -->
          <button class="cut-button cut-button-ghost" data-action="toggle" type="button">Minimize</button>
        </div>
      </div>
      <div class="cut-body">
        <div class="cut-status" data-cut-status></div>
        <div class="cut-metrics">
          <div class="cut-metric">
            <div class="cut-label">Total tokens</div>
            <div class="cut-value" data-cut-total-tokens>0</div>
          </div>
          <div class="cut-metric">
            <div class="cut-label">Total cost</div>
            <div class="cut-value" data-cut-total-cost>$0.00</div>
          </div>
          <div class="cut-metric">
            <div class="cut-label">Requests</div>
            <div class="cut-value" data-cut-total-requests>0</div>
          </div>
          <div class="cut-metric">
            <div class="cut-label">Avg tokens</div>
            <div class="cut-value" data-cut-avg-tokens>0</div>
          </div>
          <div class="cut-metric">
            <div class="cut-label">Error rate</div>
            <div class="cut-value" data-cut-error-rate>0%</div>
          </div>
        </div>
        <div class="cut-section">
          <div class="cut-section-title">Plan usage</div>
          <div class="cut-plan" data-cut-plan></div>
        </div>
        <div class="cut-section">
          <div class="cut-section-title">Session usage</div>
          <div class="cut-session" data-cut-session></div>
        </div>
        <div class="cut-section">
          <div class="cut-section-title">Per model</div>
          <div class="cut-table" data-cut-models></div>
        </div>
        <div class="cut-section">
          <div class="cut-section-title">Timeline (last 7 days)</div>
          <div class="cut-timeline" data-cut-timeline></div>
        </div>
        <div class="cut-section cut-actions-row">
          <button class="cut-button" data-action="refresh" type="button">Refresh</button>
          <button class="cut-button" data-action="export-json" type="button">Export JSON</button>
          <button class="cut-button" data-action="export-csv" type="button">Export CSV</button>
          <button class="cut-button cut-button-danger" data-action="reset" type="button">Reset</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", onOverlayClick);
    ui = {
      range: overlay.querySelector("[data-cut-range]"),
      status: overlay.querySelector("[data-cut-status]"),
      totalTokens: overlay.querySelector("[data-cut-total-tokens]"),
      totalCost: overlay.querySelector("[data-cut-total-cost]"),
      totalRequests: overlay.querySelector("[data-cut-total-requests]"),
      avgTokens: overlay.querySelector("[data-cut-avg-tokens]"),
      errorRate: overlay.querySelector("[data-cut-error-rate]"),
      plan: overlay.querySelector("[data-cut-plan]"),
      session: overlay.querySelector("[data-cut-session]"),
      models: overlay.querySelector("[data-cut-models]"),
      timeline: overlay.querySelector("[data-cut-timeline]"),
      toggleButton: overlay.querySelector('[data-action="toggle"]')
    };
    applyUiStateFromStorage();
  }

  function teardownOverlay() {
    if (!overlay) return;
    overlay.removeEventListener("click", onOverlayClick);
    overlay.remove();
    overlay = null;
    ui = null;
  }

  function onOverlayClick(event) {
    const action = event.target?.dataset?.action;
    if (!action) return;

    if (action === "toggle") {
      const isCollapsed = overlay.classList.contains("cut-collapsed");
      setCollapsedState(!isCollapsed);
      saveUiState();
      return;
    }

    if (action === "options") {
      if (chrome?.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
      return;
    }

    if (action === "refresh") {
      refreshData();
      return;
    }

    if (action === "export-json") {
      exportJson();
      return;
    }

    if (action === "export-csv") {
      exportCsv();
      return;
    }

    if (action === "reset") {
      resetData();
    }
  }

  async function refreshData() {
    if (!overlay) return;
    const parsed = parseUsageTable();
    if (!parsed.tableFound) {
      showStatus("Usage table not found. Open the usage page and try again.");
      return;
    }

    data.rangeText = parsed.rangeText || "";
    const didUpdate = mergeRecords(parsed.records);
    data.lastUpdated = Date.now();
    if (didUpdate) {
      await storageSet(DATA_KEY, data);
    }
    render();
  }

  function connectObserver() {
    disconnectObserver();
    const table = findUsageTable();
    const rowGroup = table?.querySelector('[role="rowgroup"]');
    if (!rowGroup) return;

    observer = new MutationObserver(() => {
      scheduleRefresh();
    });
    observer.observe(rowGroup, { childList: true, subtree: true });
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function scheduleRefresh(delay = 400) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshData();
    }, delay);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      refreshData();
    }, 15000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function render() {
    if (!ui) return;
    const stats = computeStats(data.records, settings);
    const sessionStats = computeStats(
      data.records.filter((record) => sessionRecordIds.has(record.id)),
      settings
    );

    const rangeText = data.rangeText ? data.rangeText.trim() : "";
    ui.range.textContent = rangeText || "Current range";

    ui.totalTokens.textContent = formatCompactNumber(stats.totals.tokens);
    ui.totalCost.textContent = formatCost(stats.totals.cost);
    ui.totalRequests.textContent = formatNumber(stats.totals.requests);
    ui.avgTokens.textContent = formatNumber(Math.round(stats.avgTokens || 0));
    ui.errorRate.textContent = `${Math.round((stats.errorRate || 0) * 100)}%`;

    renderPlan(stats.plan);
    renderSession(sessionStats);
    renderModels(stats.modelStats);
    renderTimeline(stats.timeline);
    showStatus(
      stats.totals.requests
        ? `Tracking ${stats.totals.requests} requests.`
        : "No usage rows found yet."
    );
  }

  function renderPlan(plan) {
    if (!ui) return;
    ui.plan.innerHTML = "";

    if (!plan) {
      const note = document.createElement("div");
      note.className = "cut-muted";
      note.textContent = "Set a plan token limit in Options to track quota.";
      ui.plan.appendChild(note);
      return;
    }

    const percent = Math.min(Math.max(plan.percent || 0, 0), 1);
    const row = document.createElement("div");
    row.className = "cut-plan-row";
    row.innerHTML = `
      <div class="cut-plan-bar">
        <div class="cut-plan-fill" style="width:${Math.round(percent * 100)}%"></div>
      </div>
      <div class="cut-plan-meta">
        <span>${formatCompactNumber(plan.used)} used</span>
        <span>${formatCompactNumber(plan.remainingTokens)} remaining</span>
      </div>
      <div class="cut-plan-meta">
        <span>${Math.round(percent * 100)}% of ${formatCompactNumber(plan.limit)}</span>
        <span>${formatRemainingRequests(plan.remainingRequests)}</span>
      </div>
    `;
    ui.plan.appendChild(row);
  }

  function renderSession(sessionStats) {
    if (!ui) return;
    ui.session.innerHTML = "";

    const row = document.createElement("div");
    row.className = "cut-session-row";
    row.innerHTML = `
      <div class="cut-session-meta">
        <span>${formatCompactNumber(sessionStats.totals.tokens)} tokens</span>
        <span>${formatNumber(sessionStats.totals.requests)} requests</span>
        <span>${formatCost(sessionStats.totals.cost)}</span>
      </div>
      <div class="cut-muted">Session started ${formatRelativeTime(sessionStartedAt)}.</div>
    `;
    ui.session.appendChild(row);
  }

  function renderModels(modelStats) {
    if (!ui) return;
    ui.models.innerHTML = "";

    const entries = Object.entries(modelStats).sort(
      (a, b) => (b[1].tokens || 0) - (a[1].tokens || 0)
    );

    if (!entries.length) {
      ui.models.textContent = "No model data yet.";
      return;
    }

    const header = document.createElement("div");
    header.className = "cut-table-row cut-table-head";
    header.innerHTML = `
      <div>Model</div>
      <div>Tokens</div>
      <div>Req</div>
      <div>Avg</div>
      <div>Cost</div>
    `;
    ui.models.appendChild(header);

    entries.forEach(([model, stat]) => {
      const avgTokens = stat.requests ? stat.tokens / stat.requests : 0;
      const costLabel = stat.cost > 0
        ? formatCost(stat.cost)
        : stat.estimatedCost != null
          ? `~${formatCost(stat.estimatedCost)}`
          : "Included";
      const row = document.createElement("div");
      row.className = "cut-table-row";
      row.innerHTML = `
        <div class="cut-truncate" title="${escapeHtml(model)}">${escapeHtml(model)}</div>
        <div>${formatCompactNumber(stat.tokens)}</div>
        <div>${formatNumber(stat.requests)}</div>
        <div>${formatNumber(Math.round(avgTokens))}</div>
        <div>${costLabel}</div>
      `;
      ui.models.appendChild(row);
    });
  }

  function renderTimeline(timeline) {
    if (!ui) return;
    ui.timeline.innerHTML = "";

    const entries = Object.entries(timeline).sort(([a], [b]) => a.localeCompare(b));
    const recent = entries.slice(-7);
    if (!recent.length) {
      ui.timeline.textContent = "No timeline data yet.";
      return;
    }

    recent.forEach(([day, tokens]) => {
      const row = document.createElement("div");
      row.className = "cut-timeline-row";
      row.innerHTML = `
        <span>${formatDayLabel(day)}</span>
        <span>${formatCompactNumber(tokens)}</span>
      `;
      ui.timeline.appendChild(row);
    });
  }

  function showStatus(message) {
    if (ui?.status) {
      ui.status.textContent = message || "";
    }
  }

  function parseUsageTable() {
    const table = findUsageTable();
    if (!table) {
      return { tableFound: false, records: [], rangeText: "" };
    }

    const rowGroup = table.querySelector('[role="rowgroup"]');
    const rows = rowGroup
      ? Array.from(rowGroup.querySelectorAll('[role="row"]'))
      : [];
    const records = [];

    rows.forEach((row) => {
      const record = parseRow(row);
      if (record) records.push(record);
    });

    const rangeText = table.querySelector("#table-description")?.textContent || "";
    return { tableFound: true, records, rangeText };
  }

  function findUsageTable() {
    const tables = Array.from(document.querySelectorAll('[role="table"]'));
    if (!tables.length) return null;
    return (
      tables.find((table) => {
        const label = table.getAttribute("aria-label") || "";
        return /usage events/i.test(label) || table.querySelector("#table-description");
      }) || null
    );
  }

  function parseRow(row) {
    const cells = Array.from(row.querySelectorAll('[role="cell"]'));
    if (cells.length < 4) return null;

    const dateCell = cells[0];
    const typeCell = cells[1];
    const modelCell = cells[2];
    const tokensCell = cells[3];
    const costCell = cells[4];

    const dateTitle = getTitleOrText(dateCell);
    const dateLabel = getText(dateCell);
    const typeTitle = getTitleOrText(typeCell);
    const typeLabel = getText(typeCell);
    const model = getTitleOrText(modelCell);
    const tokensText = getText(tokensCell);
    const costText = costCell ? getText(costCell) : "";

    const tokens = parseCompactNumber(tokensText);
    const cost = parseCost(costText);
    const timestampMs = Date.parse(dateTitle);

    const isIncluded = /included/i.test(typeTitle || typeLabel || "");
    const isError = /error|failed|cancel/i.test(typeTitle || typeLabel || "");

    const id = [
      dateTitle || dateLabel,
      typeTitle || typeLabel,
      model,
      tokensText,
      costText
    ].join("|");

    return {
      id,
      timestamp: dateTitle || dateLabel,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      dateLabel,
      type: typeLabel,
      typeDetail: typeTitle || typeLabel,
      model: model || "unknown",
      tokens,
      tokensText,
      cost,
      costText,
      isIncluded,
      isError
    };
  }

  function mergeRecords(records) {
    let updated = false;
    records.forEach((record) => {
      if (!record || !record.id) return;
      if (data.recordIds[record.id]) return;
      data.recordIds[record.id] = true;
      data.records.push(record);
      sessionRecordIds.add(record.id);
      updated = true;
    });
    if (updated) {
      data.records = data.records.slice(-5000);
    }
    return updated;
  }

  function computeStats(records, activeSettings) {
    const totals = { tokens: 0, cost: 0, requests: 0 };
    const modelStats = {};
    const timeline = {};
    let errorCount = 0;
    let includedTokens = 0;

    records.forEach((record) => {
      if (!record || !Number.isFinite(record.tokens)) return;
      totals.tokens += record.tokens;
      totals.cost += record.cost || 0;
      totals.requests += 1;

      if (record.isError) errorCount += 1;
      if (record.isIncluded) includedTokens += record.tokens;

      const model = record.model || "unknown";
      if (!modelStats[model]) {
        modelStats[model] = {
          tokens: 0,
          cost: 0,
          requests: 0,
          estimatedCost: null
        };
      }

      modelStats[model].tokens += record.tokens;
      modelStats[model].cost += record.cost || 0;
      modelStats[model].requests += 1;

      const dayKey = record.timestampMs
        ? new Date(record.timestampMs).toISOString().slice(0, 10)
        : null;
      if (dayKey) {
        timeline[dayKey] = (timeline[dayKey] || 0) + record.tokens;
      }
    });

    Object.entries(modelStats).forEach(([model, stats]) => {
      const price = Number(activeSettings?.pricingPer1M?.[model]);
      if (Number.isFinite(price)) {
        stats.estimatedCost = (stats.tokens / 1000000) * price;
      }
    });

    const avgTokens = totals.requests ? totals.tokens / totals.requests : 0;
    const errorRate = totals.requests ? errorCount / totals.requests : 0;
    const planLimit = Number(activeSettings?.planTokenLimit);
    const plan = Number.isFinite(planLimit) && planLimit > 0
      ? {
          limit: planLimit,
          used: includedTokens,
          remainingTokens: Math.max(planLimit - includedTokens, 0),
          percent: planLimit ? includedTokens / planLimit : 0,
          remainingRequests: avgTokens
            ? Math.max(planLimit - includedTokens, 0) / avgTokens
            : null
        }
      : null;

    return {
      totals,
      modelStats,
      timeline,
      avgTokens,
      errorRate,
      plan
    };
  }

  async function resetData() {
    data = { ...DEFAULT_DATA };
    sessionRecordIds.clear();
    await storageSet(DATA_KEY, data);
    render();
  }

  async function exportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      records: data.records
    };
    downloadFile(
      "cursor-usage.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  }

  async function exportCsv() {
    const header = [
      "timestamp",
      "type",
      "model",
      "tokens",
      "cost",
      "rawTokens",
      "rawCost",
      "isIncluded",
      "isError"
    ];
    const rows = data.records.map((record) => [
      record.timestamp,
      record.typeDetail || record.type,
      record.model,
      record.tokens,
      record.cost ?? "",
      record.tokensText,
      record.costText,
      record.isIncluded ? "true" : "false",
      record.isError ? "true" : "false"
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    downloadFile("cursor-usage.csv", csv, "text/csv");
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function applySettings(value) {
    const merged = { ...DEFAULT_SETTINGS, ...(value || {}) };
    const planLimit = Number(merged.planTokenLimit);
    merged.planTokenLimit = Number.isFinite(planLimit) && planLimit > 0 ? planLimit : null;
    merged.pricingPer1M = isPlainObject(merged.pricingPer1M)
      ? merged.pricingPer1M
      : {};
    return merged;
  }

  function applyData(value) {
    const merged = { ...DEFAULT_DATA, ...(value || {}) };
    merged.records = Array.isArray(merged.records) ? merged.records : [];
    merged.recordIds = isPlainObject(merged.recordIds) ? merged.recordIds : {};
    return merged;
  }

  async function applyUiStateFromStorage() {
    const state = await storageGet(UI_KEY);
    applyUiState(state);
  }

  function applyUiState(state) {
    if (!overlay) return;
    setCollapsedState(Boolean(state?.collapsed));
  }

  function saveUiState() {
    if (!overlay) return;
    storageSet(UI_KEY, { collapsed: overlay.classList.contains("cut-collapsed") });
  }

  function updateToggleButtonLabel() {
    if (!ui?.toggleButton || !overlay) return;
    const isCollapsed = overlay.classList.contains("cut-collapsed");
    ui.toggleButton.textContent = isCollapsed ? "Maximize" : "Minimize";
    ui.toggleButton.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  }

  function setCollapsedState(collapsed) {
    if (!overlay) return;
    overlay.classList.toggle("cut-collapsed", collapsed);
    updateToggleButtonLabel();
  }

  function matchesPattern(url, pattern) {
    if (!pattern || pattern === "*") return true;
    try {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`, "i");
      return regex.test(url);
    } catch (error) {
      return url.includes(pattern);
    }
  }

  function parseCompactNumber(value) {
    if (!value) return 0;
    const cleaned = value.replace(/,/g, "").trim();
    const match = cleaned.match(/^(-?[\d.]+)\s*([kmb])?$/i);
    if (!match) {
      const fallback = Number(cleaned);
      return Number.isFinite(fallback) ? fallback : 0;
    }
    const amount = Number(match[1]);
    const suffix = match[2]?.toLowerCase();
    if (!Number.isFinite(amount)) return 0;
    if (suffix === "k") return amount * 1000;
    if (suffix === "m") return amount * 1000000;
    if (suffix === "b") return amount * 1000000000;
    return amount;
  }

  function parseCost(value) {
    if (!value) return 0;
    const cleaned = value.replace(/,/g, "").trim();
    if (/included|free/i.test(cleaned)) return 0;
    const match = cleaned.match(/-?\$?([\d.]+)/);
    if (!match) return 0;
    const amount = Number(match[1]);
    return Number.isFinite(amount) ? amount : 0;
  }

  function formatCompactNumber(value) {
    if (!Number.isFinite(value)) return "0";
    if (value >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return formatNumber(value);
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "0";
    return new Intl.NumberFormat().format(value);
  }

  function formatCost(value) {
    if (!Number.isFinite(value)) return "$0.00";
    return `$${value.toFixed(2)}`;
  }

  function formatRemainingRequests(value) {
    if (!Number.isFinite(value)) return "Remaining requests: n/a";
    return `~${formatNumber(Math.floor(value))} requests left`;
  }

  function formatDayLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatRelativeTime(timestamp) {
    const diffMs = Date.now() - timestamp;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function getText(node) {
    return node?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function getTitleOrText(node) {
    if (!node) return "";
    const titleEl = node.querySelector("[title]");
    if (titleEl) {
      return titleEl.getAttribute("title") || getText(titleEl);
    }
    return getText(node);
  }

  function csvEscape(value) {
    const stringValue = value == null ? "" : String(value);
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get([key], (result) => resolve(result[key]));
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }
})();
