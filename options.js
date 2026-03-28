(() => {
  const SETTINGS_KEY = "cursorUsageTrackerSettings";
  const DEFAULT_SETTINGS = {
    targetUrlPattern: "https://cursor.com/dashboard/usage*",
    planTokenLimit: null,
    pricingPer1M: {}
  };

  const targetUrlInput = document.getElementById("targetUrl");
  const planLimitInput = document.getElementById("planLimit");
  const pricingInput = document.getElementById("pricing");
  const statusEl = document.getElementById("status");

  document.getElementById("save").addEventListener("click", save);
  document.getElementById("reset").addEventListener("click", resetDefaults);

  load();

  async function load() {
    const settings = applySettings(await storageGet(SETTINGS_KEY));
    targetUrlInput.value = settings.targetUrlPattern || "";
    planLimitInput.value = settings.planTokenLimit || "";
    pricingInput.value = JSON.stringify(settings.pricingPer1M || {}, null, 2);
  }

  async function save() {
    statusEl.textContent = "";
    statusEl.classList.remove("error");

    const targetUrlPattern = targetUrlInput.value.trim() || DEFAULT_SETTINGS.targetUrlPattern;
    const planTokenLimit = Number(planLimitInput.value);
    let pricingPer1M = {};

    if (pricingInput.value.trim()) {
      try {
        const parsed = JSON.parse(pricingInput.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Pricing must be an object.");
        }
        pricingPer1M = sanitizePricing(parsed);
      } catch (error) {
        statusEl.textContent = "Invalid pricing JSON. Please fix and try again.";
        statusEl.classList.add("error");
        return;
      }
    }

    const settings = {
      targetUrlPattern,
      planTokenLimit: Number.isFinite(planTokenLimit) && planTokenLimit > 0 ? planTokenLimit : null,
      pricingPer1M
    };

    await storageSet(SETTINGS_KEY, settings);
    statusEl.textContent = "Settings saved.";
  }

  async function resetDefaults() {
    await storageSet(SETTINGS_KEY, DEFAULT_SETTINGS);
    await load();
    statusEl.textContent = "Defaults restored.";
  }

  function applySettings(value) {
    const merged = { ...DEFAULT_SETTINGS, ...(value || {}) };
    merged.pricingPer1M =
      merged.pricingPer1M && typeof merged.pricingPer1M === "object"
        ? merged.pricingPer1M
        : {};
    return merged;
  }

  function sanitizePricing(value) {
    const cleaned = {};
    Object.entries(value).forEach(([model, price]) => {
      const numeric = Number(price);
      if (model && Number.isFinite(numeric) && numeric >= 0) {
        cleaned[model] = numeric;
      }
    });
    return cleaned;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key]));
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }
})();
