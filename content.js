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
    rangeText: "",
    planName: ""
  };

  const PLAN_API_LIMIT_USD = {
    "pro": 20,
    "pro plus": 60,
    "ultra": 400
  };

  const MODEL_DEFINITIONS = [
    {
      id: "claude-opus-4-6",
      displayName: "Claude 4.6 Opus",
      contextTokens: 200000,
      maxTokens: 1000000,
      pool: "api",
      pricing: { input: 5, output: 25 },
      aliases: ["claude-4.6-opus", "claude-opus-4-6"]
    },
    {
      id: "claude-4-6-sonnet",
      displayName: "Claude 4.6 Sonnet",
      contextTokens: 200000,
      maxTokens: 1000000,
      pool: "api",
      pricing: { input: 3, output: 15 },
      aliases: ["claude-4.6-sonnet", "claude-4-6-sonnet"]
    },
    {
      id: "composer-2",
      displayName: "Composer 2",
      contextTokens: 200000,
      maxTokens: null,
      pool: "auto",
      pricing: { input: 0.5, output: 2.5 },
      aliases: ["composer-2"]
    },
    {
      id: "gemini-3-1-pro",
      displayName: "Gemini 3.1 Pro",
      contextTokens: 200000,
      maxTokens: 1000000,
      pool: "api",
      pricing: { input: 2, output: 12 },
      aliases: ["gemini-3.1-pro"]
    },
    {
      id: "gpt-5-3-codex",
      displayName: "GPT-5.3 Codex",
      contextTokens: 272000,
      maxTokens: null,
      pool: "api",
      pricing: { input: 1.75, output: 14 },
      aliases: ["gpt-5.3-codex", "gpt-5-3-codex"]
    },
    {
      id: "gpt-5-4",
      displayName: "GPT-5.4",
      contextTokens: 272000,
      maxTokens: 1000000,
      pool: "api",
      pricing: { input: 2.5, output: 15 },
      aliases: ["gpt-5.4", "gpt-5-4"]
    },
    {
      id: "grok-4-20",
      displayName: "Grok 4.20",
      contextTokens: 200000,
      maxTokens: 2000000,
      pool: "api",
      pricing: { input: 2, output: 6 },
      aliases: ["grok-4-20"]
    },
    {
      id: "auto",
      displayName: "Auto",
      contextTokens: null,
      maxTokens: null,
      pool: "auto",
      pricing: { input: 1.25, output: 6 },
      aliases: ["auto"]
    }
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let data = { ...DEFAULT_DATA };
  let overlay = null;
  let ui = null;
  let observer = null;
  let tableObserver = null;
  let refreshTimer = null;
  let activationToken = 0;
  let currentUrl = location.href;
  const sessionRecordIds = new Set();
  const sessionStartedAt = Date.now();
  const uiState = { expandedWeeks: new Set() };
  let lastStats = null;
  let weeklyTimelineCache = { key: null, data: null };

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
      return;
    }

    const token = ++activationToken;
    ensureOverlay();
    await waitForDomReady();
    if (token !== activationToken) return;

    const tableReady = await waitForUsageTable();
    if (token !== activationToken) return;
    if (tableReady) {
      await refreshData();
    } else {
      showStatus("Waiting for usage table…");
    }
    connectObserver();
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
          <div class="cut-section-title">Timeline (by week)</div>
          <div class="cut-timeline" data-cut-timeline></div>
        </div>
        <div class="cut-section cut-actions-row">
          <button class="cut-button" data-action="export-json" type="button">Export JSON</button>
          <button class="cut-button" data-action="export-csv" type="button">Export CSV</button>
          <button class="cut-button cut-button-danger" data-action="reset" type="button">Reset</button>
        </div>
      </div>
      <div class="cut-resize-handle" data-cut-resize-handle></div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", onOverlayClick);
    ui = {
      range: overlay.querySelector("[data-cut-range]"),
      status: overlay.querySelector("[data-cut-status]"),
      totalTokens: overlay.querySelector("[data-cut-total-tokens]"),
      totalCost: overlay.querySelector("[data-cut-total-cost]"),
      totalRequests: overlay.querySelector("[data-cut-total-requests]"),
      errorRate: overlay.querySelector("[data-cut-error-rate]"),
      plan: overlay.querySelector("[data-cut-plan]"),
      session: overlay.querySelector("[data-cut-session]"),
      models: overlay.querySelector("[data-cut-models]"),
      timeline: overlay.querySelector("[data-cut-timeline]"),
      toggleButton: overlay.querySelector('[data-action="toggle"]'),
      resizeHandle: overlay.querySelector("[data-cut-resize-handle]")
    };
    bindResizeHandle();
    applyUiStateFromStorage();
  }

  function teardownOverlay() {
    if (!overlay) return;
    overlay.removeEventListener("click", onOverlayClick);
    unbindResizeHandle();
    overlay.remove();
    overlay = null;
    ui = null;
  }

  function onOverlayClick(event) {
    const actionTarget = event.target?.closest?.("[data-action]");
    const action = actionTarget?.dataset?.action;
    if (!action) return;

    if (action === "toggle") {
      const isCollapsed = overlay.classList.contains("cut-collapsed");
      setCollapsedState(!isCollapsed);
      saveUiState();
      return;
    }

    if (action === "toggle-week") {
      const weekKey = actionTarget?.dataset?.week;
      if (weekKey) {
        toggleWeek(weekKey);
      }
      return;
    }

    if (action === "options") {
      if (chrome?.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
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

    const nextRangeText = extractRangeText(parsed.rangeText);
    const rangeChanged = nextRangeText !== data.rangeText;
    data.rangeText = nextRangeText;
    const detectedPlanName = detectPlanName(parsed.records);
    if (detectedPlanName) {
      data.planName = detectedPlanName;
    }
    const didUpdate = setRecordsFromPage(parsed.records);
    if (didUpdate || rangeChanged || detectedPlanName) {
      data.lastUpdated = Date.now();
      await storageSet(DATA_KEY, data);
    }
    render();
  }

  function connectObserver() {
    disconnectObserver();
    const table = findUsageTable();
    const rowGroup = table?.querySelector('[role="rowgroup"]');
    if (!table || !rowGroup) {
      watchForTable();
      return;
    }

    observer = new MutationObserver(() => {
      scheduleRefresh();
    });
    observer.observe(rowGroup, { childList: true, subtree: true });

    tableObserver = new MutationObserver(() => {
      const freshTable = findUsageTable();
      const freshRowGroup = freshTable?.querySelector('[role="rowgroup"]');
      if (freshRowGroup && freshRowGroup !== rowGroup) {
        connectObserver();
        scheduleRefresh();
      }
    });
    tableObserver.observe(table, { childList: true, subtree: true });
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (tableObserver) {
      tableObserver.disconnect();
      tableObserver = null;
    }
  }

  function scheduleRefresh(delay = 400) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshData();
    }, delay);
  }

  function waitForDomReady() {
    if (document.readyState === "loading") {
      return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      });
    }
    return Promise.resolve();
  }

  function waitForUsageTable(timeoutMs = 15000) {
    if (findUsageTable()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const target = document.body || document.documentElement;
      if (!target) {
        resolve(false);
        return;
      }
      const tempObserver = new MutationObserver(() => {
        if (findUsageTable()) {
          tempObserver.disconnect();
          resolve(true);
        }
      });
      tempObserver.observe(target, { childList: true, subtree: true });
      if (timeoutMs) {
        setTimeout(() => {
          tempObserver.disconnect();
          resolve(Boolean(findUsageTable()));
        }, timeoutMs);
      }
    });
  }

  function watchForTable() {
    if (tableObserver) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    tableObserver = new MutationObserver(() => {
      if (findUsageTable()) {
        connectObserver();
        scheduleRefresh(0);
      }
    });
    tableObserver.observe(target, { childList: true, subtree: true });
  }

  function render() {
    if (!ui) return;
    const stats = computeStats(
      data.records,
      settings,
      data.planName,
      data.lastUpdated,
      data.rangeText
    );
    lastStats = stats;
    const sessionStats = computeStats(
      data.records.filter((record) => sessionRecordIds.has(record.id)),
      settings,
      data.planName,
      data.lastUpdated,
      data.rangeText
    );

    const rangeText = data.rangeText ? data.rangeText.trim() : "";
    ui.range.textContent = rangeText || "Current range";

    ui.totalTokens.textContent = formatCompactNumber(stats.totals.tokens);
    ui.totalCost.textContent = formatCostLabel(stats.totals);
    ui.totalRequests.textContent = formatNumber(stats.totals.requests);
    ui.errorRate.textContent = `${Math.round((stats.errorRate || 0) * 100)}%`;

    renderPlan(stats.plan);
    renderSession(sessionStats);
    renderModels(stats.modelStats);
    renderTimeline(stats.weeklyTimeline);
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
      note.textContent = "Plan usage limits not detected yet.";
      ui.plan.appendChild(note);
      return;
    }

    const block = document.createElement("div");
    block.className = "cut-plan-row";

    if (plan.mode === "tokens") {
      const percent = Math.min(Math.max(plan.percent || 0, 0), 1);
      block.innerHTML = `
        <div class="cut-plan-title">${plan.planName ? `${plan.planName} token limit` : "Token limit"}</div>
        <div class="cut-plan-bar">
          <div class="cut-plan-fill" style="width:${Math.round(percent * 100)}%"></div>
        </div>
        <div class="cut-plan-meta">
          <span>${formatCompactNumber(plan.usedTokens)} used</span>
          <span>${formatCompactNumber(plan.remainingTokens)} remaining</span>
        </div>
        <div class="cut-plan-meta">
          <span>${Math.round(percent * 100)}% of ${formatCompactNumber(plan.limitTokens)}</span>
          <span>${formatRemainingRequests(plan.remainingRequests)}</span>
        </div>
        <div class="cut-muted">Token limit override enabled.</div>
      `;
    } else if (plan.mode === "usd") {
      const percent = Math.min(Math.max(plan.percent || 0, 0), 1);
      block.innerHTML = `
        <div class="cut-plan-title">${plan.planName ? `${plan.planName} API pool` : "API pool"}</div>
        <div class="cut-plan-bar">
          <div class="cut-plan-fill" style="width:${Math.round(percent * 100)}%"></div>
        </div>
        <div class="cut-plan-meta">
          <span>${formatCostValue(plan.apiUsedUsd, plan.apiHasEstimated)}</span>
          <span>${formatCost(plan.apiRemainingUsd)} remaining</span>
        </div>
        <div class="cut-plan-meta">
          <span>${Math.round(percent * 100)}% of ${formatCost(plan.apiLimitUsd)}</span>
          <span>${formatCompactNumber(plan.apiTokens)} tokens</span>
        </div>
        ${plan.apiHasEstimated ? '<div class="cut-muted">Estimated cost based on model pricing.</div>' : ""}
      `;
    } else {
      block.innerHTML = `
        <div class="cut-plan-title">${plan.planName ? `${plan.planName} API pool` : "API pool"}</div>
        <div class="cut-plan-meta">
          <span>${formatCompactNumber(plan.apiTokens)} tokens</span>
          <span>${formatCostValue(plan.apiUsedUsd, plan.apiHasEstimated)}</span>
        </div>
        <div class="cut-muted">Plan limit not available from the page.</div>
      `;
    }

    ui.plan.appendChild(block);

    if (plan.autoTokens) {
      const autoBlock = document.createElement("div");
      autoBlock.className = "cut-plan-row cut-plan-secondary";
      autoBlock.innerHTML = `
        <div class="cut-plan-title">Auto + Composer pool</div>
        <div class="cut-plan-meta">
          <span>${formatCompactNumber(plan.autoTokens)} tokens</span>
          <span>${formatCostValue(plan.autoEstimatedCost, plan.autoHasEstimated)}</span>
        </div>
        <div class="cut-muted">Included usage limit not specified.</div>
      `;
      ui.plan.appendChild(autoBlock);
    }
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
        <span>${formatCostLabel(sessionStats.totals)}</span>
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
      <div>Max/Limit</div>
    `;
    ui.models.appendChild(header);

    entries.forEach(([model, stat]) => {
      const avgTokens = stat.requests ? stat.tokens / stat.requests : 0;
      const limitText = stat.limitTokens
        ? `${formatCompactNumber(stat.maxRequestTokens)} / ${formatCompactNumber(stat.limitTokens)}`
        : "n/a";
      const rawPercent = stat.limitTokens
        ? stat.maxRequestTokens / stat.limitTokens
        : null;
      const percent = rawPercent != null ? Math.round(rawPercent * 100) : null;
      const barPercent = rawPercent != null ? Math.min(rawPercent, 1) * 100 : 0;
      const remaining = stat.limitTokens
        ? formatCompactNumber(stat.remainingTokens)
        : null;
      const row = document.createElement("div");
      row.className = "cut-table-row";
      row.innerHTML = `
        <div class="cut-truncate" title="${escapeHtml(stat.displayName || model)}">${escapeHtml(stat.displayName || model)}</div>
        <div>${formatCompactNumber(stat.tokens)}</div>
        <div>${formatNumber(stat.requests)}</div>
        <div>${formatNumber(Math.round(avgTokens))}</div>
        <div class="cut-limit-cell">
          <div class="cut-limit-text">${limitText}${percent != null ? ` (${percent}%)` : ""}</div>
          ${stat.limitTokens
            ? `<div class="cut-limit-remaining">Remaining ${remaining}</div>
               <div class="cut-limit-bar"><div class="cut-limit-fill" style="width:${barPercent}%"></div></div>`
            : `<div class="cut-muted">No model limit data.</div>`}
        </div>
      `;
      ui.models.appendChild(row);
    });
  }

  function renderTimeline(weeklyTimeline) {
    if (!ui) return;
    ui.timeline.innerHTML = "";

    if (!weeklyTimeline || !weeklyTimeline.length) {
      ui.timeline.textContent = "No timeline data yet.";
      return;
    }

    weeklyTimeline.forEach((week) => {
      const isOpen = uiState.expandedWeeks.has(week.weekKey);
      const wrapper = document.createElement("div");
      wrapper.className = `cut-week ${isOpen ? "is-open" : ""}`;
      wrapper.innerHTML = `
        <button class="cut-week-toggle" data-action="toggle-week" data-week="${week.weekKey}" aria-expanded="${isOpen}">
          <span>${week.label}</span>
          <span>${formatCompactNumber(week.totalTokens)}</span>
        </button>
        <div class="cut-week-days">
          ${week.days
            .map((day) => {
              return `
                <div class="cut-week-day">
                  <span>${formatDayLabel(day.dateKey)}</span>
                  <span>${formatCompactNumber(day.tokens)}</span>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
      ui.timeline.appendChild(wrapper);
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

    const typeValue = typeTitle || typeLabel || "";
    const isIncluded = /included/i.test(typeValue);
    const isError = /error|failed|cancel/i.test(typeValue);
    const planName = extractPlanName(typeValue);

    const modelInfo = resolveModelDefinition(model);
    const modelKey = modelInfo?.id || model || "unknown";
    const modelDisplay = modelInfo?.displayName || model || "unknown";
    const modelLimitTokens = modelInfo?.maxTokens ?? modelInfo?.contextTokens ?? null;
    const modelPool = modelInfo?.pool || "api";

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
      modelKey,
      modelDisplay,
      modelLimitTokens,
      modelPool,
      tokens,
      tokensText,
      cost,
      costText,
      isIncluded,
      isError,
      planName
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

  function setRecordsFromPage(records) {
    const nextRecords = Array.isArray(records) ? records : [];
    const nextIds = {};
    nextRecords.forEach((record) => {
      if (!record?.id) return;
      nextIds[record.id] = true;
      sessionRecordIds.add(record.id);
    });

    const hasChanged =
      nextRecords.length !== data.records.length ||
      hasRecordSetChanged(nextIds, data.recordIds);

    data.records = nextRecords;
    data.recordIds = nextIds;

    return hasChanged;
  }

  function hasRecordSetChanged(nextIds, prevIds) {
    const nextKeys = Object.keys(nextIds);
    const prevKeys = Object.keys(prevIds || {});
    if (nextKeys.length !== prevKeys.length) return true;
    for (const key of nextKeys) {
      if (!prevIds?.[key]) return true;
    }
    return false;
  }

  function computeStats(records, activeSettings, planName, lastUpdated, rangeText) {
    const totals = {
      tokens: 0,
      cost: 0,
      estimatedCost: 0,
      requests: 0,
      hasEstimatedCost: false
    };
    const modelStats = {};
    const timeline = {};
    const poolTotals = {
      api: { tokens: 0, estimatedCost: 0, hasEstimatedCost: false },
      auto: { tokens: 0, estimatedCost: 0, hasEstimatedCost: false }
    };
    let errorCount = 0;
    let includedTokens = 0;

    records.forEach((record) => {
      if (!record || !Number.isFinite(record.tokens)) return;
      totals.tokens += record.tokens;
      totals.requests += 1;

      if (record.isError) errorCount += 1;
      if (record.isIncluded) includedTokens += record.tokens;

      const modelKey = record.modelKey || record.model || "unknown";
      const modelInfo = resolveModelDefinition(record.model || modelKey);
      if (!modelStats[modelKey]) {
        modelStats[modelKey] = {
          displayName: record.modelDisplay || modelInfo?.displayName || modelKey,
          tokens: 0,
          cost: 0,
          estimatedCost: 0,
          requests: 0,
          maxRequestTokens: 0,
          limitTokens: record.modelLimitTokens ?? modelInfo?.maxTokens ?? modelInfo?.contextTokens ?? null,
          remainingTokens: null,
          limitPercent: null,
          hasEstimatedCost: false,
          pool: record.modelPool || modelInfo?.pool || "api"
        };
      }

      const stats = modelStats[modelKey];
      stats.tokens += record.tokens;
      stats.requests += 1;
      stats.maxRequestTokens = Math.max(stats.maxRequestTokens, record.tokens);

      const actualCost = record.cost || 0;
      totals.cost += actualCost;
      stats.cost += actualCost;

      const estimatedCost = estimateRecordCost(record, activeSettings, modelInfo);
      const effectiveCost = actualCost > 0 ? actualCost : estimatedCost;
      if (Number.isFinite(effectiveCost)) {
        totals.estimatedCost += effectiveCost;
        stats.estimatedCost += effectiveCost;
      }
      if (actualCost <= 0 && Number.isFinite(estimatedCost)) {
        totals.hasEstimatedCost = true;
        stats.hasEstimatedCost = true;
      }

      const pool = stats.pool || "api";
      if (!poolTotals[pool]) {
        poolTotals[pool] = { tokens: 0, estimatedCost: 0, hasEstimatedCost: false };
      }
      poolTotals[pool].tokens += record.tokens;
      if (Number.isFinite(effectiveCost)) {
        poolTotals[pool].estimatedCost += effectiveCost;
      }
      if (actualCost <= 0 && Number.isFinite(estimatedCost)) {
        poolTotals[pool].hasEstimatedCost = true;
      }

      const dayKey = getRecordDateKey(record);
      if (dayKey) {
        timeline[dayKey] = (timeline[dayKey] || 0) + record.tokens;
      }
    });

    Object.values(modelStats).forEach((stats) => {
      stats.avgTokens = stats.requests ? stats.tokens / stats.requests : 0;
      if (stats.limitTokens) {
        stats.remainingTokens = Math.max(stats.limitTokens - stats.maxRequestTokens, 0);
        stats.limitPercent = Math.min(stats.maxRequestTokens / stats.limitTokens, 1);
      }
    });

    const avgTokens = totals.requests ? totals.tokens / totals.requests : 0;
    const errorRate = totals.requests ? errorCount / totals.requests : 0;
    const plan = buildPlanUsage({
      includedTokens,
      avgTokens,
      planName,
      poolTotals,
      activeSettings
    });
    const weeklyTimeline = getWeeklyTimeline(
      timeline,
      records.length,
      lastUpdated,
      parseRangeText(rangeText)
    );

    return {
      totals,
      modelStats,
      timeline,
      weeklyTimeline,
      avgTokens,
      errorRate,
      plan
    };
  }

  async function resetData() {
    data = { ...DEFAULT_DATA };
    sessionRecordIds.clear();
    weeklyTimelineCache = { key: null, data: null };
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
    merged.planName = typeof merged.planName === "string" ? merged.planName : "";
    return merged;
  }

  async function applyUiStateFromStorage() {
    const state = await storageGet(UI_KEY);
    applyUiState(state);
  }

  function applyUiState(state) {
    if (!overlay) return;
    uiState.expandedWeeks = new Set(
      Array.isArray(state?.expandedWeeks) ? state.expandedWeeks : []
    );
    setCollapsedState(Boolean(state?.collapsed));
    if (Number.isFinite(state?.width)) {
      applyOverlayWidth(state.width);
    }
  }

  function saveUiState() {
    if (!overlay) return;
    storageSet(UI_KEY, {
      collapsed: overlay.classList.contains("cut-collapsed"),
      width: getOverlayWidth(),
      expandedWeeks: Array.from(uiState.expandedWeeks)
    });
  }

  function updateToggleButtonLabel() {
    if (!ui?.toggleButton || !overlay) return;
    const isCollapsed = overlay.classList.contains("cut-collapsed");
    ui.toggleButton.textContent = isCollapsed ? "Maximize" : "Minimize";
    ui.toggleButton.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  }

  function extractRangeText(descriptionText) {
    if (!descriptionText) return "";
    const match = descriptionText.match(/from\s+(.+?)\s+to\s+([^.]+)/i);
    if (match) {
      return `${match[1].trim()} to ${match[2].trim()}`;
    }
    return descriptionText.trim();
  }

  function extractPlanName(value) {
    if (!value) return "";
    const match = value.match(/included in\s+([A-Za-z ]+)/i);
    return match ? match[1].trim() : "";
  }

  function detectPlanName(records) {
    const names = records.map((record) => record.planName).filter(Boolean);
    if (!names.length) return "";
    const counts = {};
    names.forEach((name) => {
      const key = normalizePlanName(name);
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return "";
    const normalized = sorted[0][0];
    return names.find((name) => normalizePlanName(name) === normalized) || normalized;
  }

  function normalizePlanName(value) {
    return value ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
  }

  function normalizeModelName(value) {
    return value ? value.toLowerCase().replace(/\s+/g, "").trim() : "";
  }

  function resolveModelDefinition(modelName) {
    const normalized = normalizeModelName(modelName);
    if (!normalized) return null;
    return (
      MODEL_DEFINITIONS.find((definition) =>
        definition.aliases.some((alias) => normalized.includes(normalizeModelName(alias)))
      ) || null
    );
  }

  function buildPlanUsage({ includedTokens, avgTokens, planName, poolTotals, activeSettings }) {
    const planTokenLimit = Number(activeSettings?.planTokenLimit);
    const autoTotals = poolTotals?.auto || { tokens: 0, estimatedCost: 0, hasEstimatedCost: false };
    const apiTotals = poolTotals?.api || { tokens: 0, estimatedCost: 0, hasEstimatedCost: false };

    if (Number.isFinite(planTokenLimit) && planTokenLimit > 0) {
      return {
        mode: "tokens",
        planName,
        limitTokens: planTokenLimit,
        usedTokens: includedTokens,
        remainingTokens: Math.max(planTokenLimit - includedTokens, 0),
        percent: planTokenLimit ? includedTokens / planTokenLimit : 0,
        remainingRequests: avgTokens
          ? Math.max(planTokenLimit - includedTokens, 0) / avgTokens
          : null,
        autoTokens: autoTotals.tokens,
        autoEstimatedCost: autoTotals.estimatedCost,
        autoHasEstimated: autoTotals.hasEstimatedCost
      };
    }

    const apiLimitUsd = getPlanLimitUsd(planName);
    const apiUsedUsd = apiTotals.estimatedCost;
    if (Number.isFinite(apiLimitUsd) && apiLimitUsd > 0) {
      return {
        mode: "usd",
        planName,
        apiLimitUsd,
        apiUsedUsd,
        apiRemainingUsd: Math.max(apiLimitUsd - apiUsedUsd, 0),
        percent: apiLimitUsd ? apiUsedUsd / apiLimitUsd : 0,
        apiTokens: apiTotals.tokens,
        apiHasEstimated: apiTotals.hasEstimatedCost,
        autoTokens: autoTotals.tokens,
        autoEstimatedCost: autoTotals.estimatedCost,
        autoHasEstimated: autoTotals.hasEstimatedCost
      };
    }

    return {
      mode: "unknown",
      planName,
      apiTokens: apiTotals.tokens,
      apiUsedUsd,
      apiHasEstimated: apiTotals.hasEstimatedCost,
      autoTokens: autoTotals.tokens,
      autoEstimatedCost: autoTotals.estimatedCost,
      autoHasEstimated: autoTotals.hasEstimatedCost
    };
  }

  function estimateRecordCost(record, activeSettings, modelInfo) {
    if (!record || !Number.isFinite(record.tokens)) return null;
    const override = findPricingOverride(activeSettings?.pricingPer1M, [
      record.modelKey,
      record.model,
      record.modelDisplay,
      modelInfo?.id
    ]);
    const pricePer1M = Number.isFinite(override)
      ? override
      : getBlendedPricePer1M(modelInfo?.pricing);
    if (!Number.isFinite(pricePer1M)) return null;
    return (record.tokens / 1000000) * pricePer1M;
  }

  function findPricingOverride(map, keys) {
    if (!isPlainObject(map)) return null;
    const lookup = {};
    Object.entries(map).forEach(([key, value]) => {
      lookup[normalizeModelName(key)] = value;
    });
    for (const key of keys) {
      const normalized = normalizeModelName(key);
      if (!normalized) continue;
      if (Object.prototype.hasOwnProperty.call(lookup, normalized)) {
        const numeric = Number(lookup[normalized]);
        if (Number.isFinite(numeric)) return numeric;
      }
    }
    return null;
  }

  function getBlendedPricePer1M(pricing) {
    if (!pricing) return null;
    const input = Number(pricing.input);
    const output = Number(pricing.output);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      return (input + output) / 2;
    }
    if (Number.isFinite(output)) return output;
    if (Number.isFinite(input)) return input;
    return null;
  }

  function getPlanLimitUsd(planName) {
    const key = normalizePlanName(planName);
    return key ? PLAN_API_LIMIT_USD[key] : null;
  }

  function getWeeklyTimeline(timeline, recordCount, lastUpdated, range) {
    const rangeKey = range ? `${range.startKey}:${range.endKey}` : "all";
    const key = `${recordCount}:${lastUpdated || 0}:${rangeKey}`;
    if (weeklyTimelineCache.key === key && weeklyTimelineCache.data) {
      return weeklyTimelineCache.data;
    }
    const grouped = groupTimelineByWeek(timeline, range);
    weeklyTimelineCache = { key, data: grouped };
    return grouped;
  }

  function groupTimelineByWeek(timeline, range) {
    const entries = Object.entries(timeline || {}).filter(([, tokens]) =>
      Number.isFinite(tokens)
    );
    if (!entries.length) return [];

    const rangeFiltered = range
      ? entries.filter(([dateKey]) => isDateWithinRange(dateKey, range))
      : entries;
    if (!rangeFiltered.length) return [];

    const monthKey = range?.endKey?.slice(0, 7) || getLatestMonthKey(rangeFiltered);
    const monthEntries = monthKey
      ? rangeFiltered.filter(([dateKey]) => dateKey.startsWith(monthKey))
      : rangeFiltered;
    if (!monthEntries.length) return [];

    const weeks = {};
    monthEntries.forEach(([dateKey, tokens]) => {
      const weekKey = getWeekStartKey(dateKey);
      if (!weeks[weekKey]) {
        weeks[weekKey] = {
          weekKey,
          totalTokens: 0,
          days: [],
          minDate: null,
          maxDate: null
        };
      }
      weeks[weekKey].totalTokens += tokens;
      weeks[weekKey].days.push({ dateKey, tokens });
      const date = parseDateKey(dateKey);
      if (!weeks[weekKey].minDate || date < weeks[weekKey].minDate) {
        weeks[weekKey].minDate = date;
      }
      if (!weeks[weekKey].maxDate || date > weeks[weekKey].maxDate) {
        weeks[weekKey].maxDate = date;
      }
    });

    return Object.values(weeks)
      .map((week) => {
        week.label = formatWeekLabel(week.minDate, week.maxDate);
        week.days.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
        return week;
      })
      .sort((a, b) => b.weekKey.localeCompare(a.weekKey));
  }

  function getWeekStartKey(dateKey) {
    const date = parseDateKey(dateKey);
    const day = date.getDay();
    const offset = (day + 6) % 7;
    date.setDate(date.getDate() - offset);
    return formatDateKey(date);
  }

  function parseRangeText(rangeText) {
    if (!rangeText) return null;
    const parts = rangeText.split(" to ").map((value) => value.trim());
    if (parts.length !== 2) return null;
    const start = new Date(parts[0]);
    const end = new Date(parts[1]);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const normalizedStart = stripTime(start);
    const normalizedEnd = stripTime(end);
    const [from, to] =
      normalizedStart <= normalizedEnd ? [normalizedStart, normalizedEnd] : [normalizedEnd, normalizedStart];
    return {
      start: from,
      end: to,
      startKey: formatDateKey(from),
      endKey: formatDateKey(to)
    };
  }

  function stripTime(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function isDateWithinRange(dateKey, range) {
    if (!range) return true;
    const date = parseDateKey(dateKey);
    if (Number.isNaN(date.getTime())) return false;
    return date >= range.start && date <= range.end;
  }

  function getLatestMonthKey(entries) {
    if (!entries.length) return "";
    const latest = entries.reduce(
      (current, [dateKey]) => (dateKey > current ? dateKey : current),
      entries[0][0]
    );
    return latest.slice(0, 7);
  }

  function getRecordDateKey(record) {
    if (Number.isFinite(record?.timestampMs)) {
      return formatDateKey(new Date(record.timestampMs));
    }
    const fallback = record?.timestamp || record?.dateLabel || "";
    const parsed = Date.parse(fallback);
    if (Number.isNaN(parsed)) return null;
    return formatDateKey(new Date(parsed));
  }

  function parseDateKey(dateKey) {
    return new Date(`${dateKey}T00:00:00`);
  }

  function formatDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(date, days) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
  }

  function formatWeekLabel(startDate, endDate) {
    const start = formatMonthDay(startDate);
    const end = formatMonthDay(endDate);
    return `${start} - ${end}`;
  }

  function formatMonthDay(date) {
    const month = date.toLocaleDateString(undefined, { month: "short" });
    const day = String(date.getDate()).padStart(2, "0");
    return `${month} ${day}`;
  }

  function setCollapsedState(collapsed) {
    if (!overlay) return;
    overlay.classList.toggle("cut-collapsed", collapsed);
    updateToggleButtonLabel();
  }

  function toggleWeek(weekKey) {
    if (!weekKey) return;
    if (uiState.expandedWeeks.has(weekKey)) {
      uiState.expandedWeeks.delete(weekKey);
    } else {
      uiState.expandedWeeks.add(weekKey);
    }
    saveUiState();
    renderTimeline(lastStats?.weeklyTimeline || []);
  }

  function bindResizeHandle() {
    if (!ui?.resizeHandle) return;
    ui.resizeHandle.addEventListener("mousedown", onResizeMouseDown);
    ui.resizeHandle.addEventListener("touchstart", onResizeTouchStart, { passive: false });
  }

  function unbindResizeHandle() {
    if (!ui?.resizeHandle) return;
    ui.resizeHandle.removeEventListener("mousedown", onResizeMouseDown);
    ui.resizeHandle.removeEventListener("touchstart", onResizeTouchStart);
  }

  function onResizeMouseDown(event) {
    event.preventDefault();
    startResize(event.clientX);
  }

  function onResizeTouchStart(event) {
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    startResize(touch.clientX, true);
  }

  function startResize(startX, isTouch = false) {
    if (!overlay) return;
    const startWidth = getOverlayWidth() || overlay.offsetWidth;
    const onMove = (moveEvent) => {
      const clientX = isTouch ? moveEvent.touches?.[0]?.clientX : moveEvent.clientX;
      if (!Number.isFinite(clientX)) return;
      const delta = startX - clientX;
      const targetWidth = startWidth + delta;
      applyOverlayWidth(targetWidth);
    };
    const onEnd = () => {
      document.removeEventListener(isTouch ? "touchmove" : "mousemove", onMove);
      document.removeEventListener(isTouch ? "touchend" : "mouseup", onEnd);
      document.removeEventListener(isTouch ? "touchcancel" : "mouseup", onEnd);
      document.body.style.userSelect = "";
      saveUiState();
    };
    document.body.style.userSelect = "none";
    document.addEventListener(isTouch ? "touchmove" : "mousemove", onMove, { passive: false });
    document.addEventListener(isTouch ? "touchend" : "mouseup", onEnd, { passive: false });
    document.addEventListener(isTouch ? "touchcancel" : "mouseup", onEnd, { passive: false });
  }

  function applyOverlayWidth(width) {
    if (!overlay || !Number.isFinite(width)) return;
    const minWidth = 300;
    const maxWidth = Math.max(minWidth, window.innerWidth - 32);
    const clamped = Math.min(Math.max(width, minWidth), maxWidth);
    overlay.style.width = `${Math.round(clamped)}px`;
  }

  function getOverlayWidth() {
    if (!overlay) return null;
    const width = Number.parseFloat(overlay.style.width);
    return Number.isFinite(width) ? width : null;
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

  function formatCostLabel(totals) {
    if (!totals) return "$0.00";
    if (totals.hasEstimatedCost && Number.isFinite(totals.estimatedCost)) {
      return `~${formatCost(totals.estimatedCost)}`;
    }
    if (Number.isFinite(totals.cost) && totals.cost > 0) {
      return formatCost(totals.cost);
    }
    return "$0.00";
  }

  function formatCostValue(value, isEstimated) {
    if (!Number.isFinite(value)) return "$0.00";
    const label = formatCost(value);
    return isEstimated ? `~${label}` : label;
  }

  function formatRemainingRequests(value) {
    if (!Number.isFinite(value)) return "Remaining requests: n/a";
    return `~${formatNumber(Math.floor(value))} requests left`;
  }

  function formatDayLabel(value) {
    if (!value) return "";
    const date = parseDateKey(value);
    if (Number.isNaN(date.getTime())) return value;
    return formatMonthDay(date);
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
