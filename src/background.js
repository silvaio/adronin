import {
  UPDATE_ALARM,
  STARTUP_DELAY_MS,
  checkFilterUpdates,
  clearLiveRules,
  filterUpdateStatus,
  scheduleFilterUpdates,
} from "./lib/filter-update.js";

const DEFAULTS = {
  enabled: true,
  blockTrackers: true,
  pausedSites: [],
  autoUpdate: true,
};

const DYNAMIC_BASE = 2_000_000;
const MAX_PAUSED = 200;
const PAUSE_IDS = Array.from({ length: MAX_PAUSED }, (_, index) => DYNAMIC_BASE + index);

const counts = new Map();
let flushTimer = null;
const pendingCounts = new Map();
let rulesetGroups = { ads: ["ads"], trackers: ["trackers"], hardening: ["hardening"] };
let queue = Promise.resolve();

function badgeText(count) {
  if (!count) return "";
  if (count > 9999) return "∞";
  return String(count);
}

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    enabled: stored.enabled !== false,
    blockTrackers: stored.blockTrackers !== false,
    pausedSites: Array.isArray(stored.pausedSites) ? stored.pausedSites : [],
    autoUpdate: stored.autoUpdate !== false,
    liveNetworkActive: Boolean(stored.liveNetworkActive),
  };
}

function validHost(host) {
  return (
    typeof host === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)
  );
}

async function syncPauseRules(sites) {
  const rules = sites.filter(validHost).slice(0, MAX_PAUSED).map((host, index) => ({
    id: DYNAMIC_BASE + index,
    priority: 10000,
    action: { type: "allowAllRequests" },
    condition: {
      requestDomains: [host],
      resourceTypes: ["main_frame"],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: PAUSE_IDS,
    addRules: rules,
  });
}

async function syncRulesetsNow() {
  const current = await settings();
  const owned = new Set([
    ...rulesetGroups.ads,
    ...rulesetGroups.trackers,
    ...(rulesetGroups.hardening || []),
  ]);
  const want = new Set();
  // Packaged static rulesets cover the first run. After a live EasyList
  // compile is installed, keep those static sets off so rules are not doubled.
  if (current.enabled && !current.liveNetworkActive) {
    rulesetGroups.ads.forEach((id) => want.add(id));
  }
  if (current.enabled && current.blockTrackers && !current.liveNetworkActive) {
    rulesetGroups.trackers.forEach((id) => want.add(id));
  }
  if (current.enabled) {
    (rulesetGroups.hardening || []).forEach((id) => want.add(id));
  }
  const enabled = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = [...want].filter((id) => !enabled.has(id));
  const disableRulesetIds = [...enabled].filter((id) => owned.has(id) && !want.has(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    });
  }
  if (!current.enabled && current.liveNetworkActive) {
    await clearLiveRules("ads");
    await clearLiveRules("trackers");
  } else if (current.liveNetworkActive && !current.blockTrackers) {
    await clearLiveRules("trackers");
  }
  await syncPauseRules(current.enabled ? current.pausedSites : []);
}

function syncRulesets() {
  queue = queue.then(syncRulesetsNow, syncRulesetsNow);
  return queue;
}

function rememberCount(tabId) {
  const next = (counts.get(tabId) || 0) + 1;
  counts.set(tabId, next);
  pendingCounts.set(tabId, next);
  chrome.action.setBadgeText({ tabId, text: badgeText(next) });
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const payload = {};
      for (const [id, count] of pendingCounts) payload[`count:${id}`] = count;
      pendingCounts.clear();
      if (Object.keys(payload).length) chrome.storage.session.set(payload);
    }, 400);
  }
}

async function restoreCounts() {
  const stored = await chrome.storage.session.get(null);
  for (const [key, count] of Object.entries(stored)) {
    if (!key.startsWith("count:") || typeof count !== "number") continue;
    const tabId = Number(key.slice(6));
    counts.set(tabId, count);
    chrome.action.setBadgeText({ tabId, text: badgeText(count) });
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function stateFor(tabId) {
  const current = await settings();
  const update = await filterUpdateStatus();
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameOf(tab.url || "");
  return {
    ...current,
    hostname,
    paused: hostname ? current.pausedSites.includes(hostname) : false,
    count: counts.get(tabId) || 0,
    page: hostname ? tab.url.startsWith("http") : false,
    lastFilterUpdate: update.lastFilterUpdate,
    lastFilterCheck: update.lastFilterCheck,
    lastFilterError: update.lastFilterError,
    liveNetworkActive: update.liveNetworkActive,
  };
}

function runUpdate(force = false) {
  queue = queue.then(
    () => checkFilterUpdates({ force, syncRulesets }),
    () => checkFilterUpdates({ force, syncRulesets }),
  );
  return queue;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#C53632" });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#F5ECDB" });
  }
  ready.then(() => {
    syncRulesets();
    scheduleFilterUpdates();
    setTimeout(() => runUpdate(false), STARTUP_DELAY_MS);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ready.then(() => {
    syncRulesets();
    scheduleFilterUpdates();
    setTimeout(() => runUpdate(false), STARTUP_DELAY_MS);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) runUpdate(false);
});

const ready = (async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("rules/rulesets.json"));
    if (response.ok) rulesetGroups = await response.json();
  } catch (error) {
    console.error("adronin could not read ruleset index", error);
  }
  await restoreCounts();
  await syncRulesets();
  await scheduleFilterUpdates();
  setTimeout(() => runUpdate(false), STARTUP_DELAY_MS);
})();

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  counts.set(details.tabId, 0);
  chrome.action.setBadgeText({ tabId: details.tabId, text: "" });
  chrome.storage.session.remove(`count:${details.tabId}`);
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request?.tabId;
    if (typeof tabId === "number" && tabId >= 0) rememberCount(tabId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = handle(message, sender);
  if (!reply) return undefined;
  reply.then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });
  return true;
});

async function handle(message, sender) {
  await ready;
  if (!message || typeof message.type !== "string") return null;
  if (message.type === "getState") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") return { ok: false };
    return { ok: true, ...(await stateFor(tabId)) };
  }
  if (message.type === "setEnabled") {
    const turningOn = Boolean(message.enabled);
    await chrome.storage.local.set({ enabled: turningOn });
    await syncRulesets();
    if (turningOn) {
      const status = await filterUpdateStatus();
      if (status.liveNetworkActive || status.filterRevision) runUpdate(true);
    }
    return { ok: true };
  }
  if (message.type === "setTrackers") {
    const blockTrackers = Boolean(message.blockTrackers);
    await chrome.storage.local.set({ blockTrackers });
    await syncRulesets();
    if (blockTrackers) {
      const status = await filterUpdateStatus();
      if (status.liveNetworkActive || status.filterRevision) runUpdate(true);
    }
    return { ok: true };
  }
  if (message.type === "setPaused") {
    const host = String(message.hostname || "");
    if (!validHost(host)) return { ok: false };
    const current = await settings();
    const paused = new Set(current.pausedSites);
    if (message.paused) paused.add(host);
    else paused.delete(host);
    await chrome.storage.local.set({ pausedSites: [...paused].sort() });
    await syncRulesets();
    return { ok: true };
  }
  if (message.type === "clearPaused") {
    await chrome.storage.local.set({ pausedSites: [] });
    await syncRulesets();
    return { ok: true };
  }
  if (message.type === "setAutoUpdate") {
    await chrome.storage.local.set({ autoUpdate: Boolean(message.autoUpdate) });
    return { ok: true };
  }
  if (message.type === "checkFilters") {
    return runUpdate(Boolean(message.force));
  }
  if (message.type === "getFilterStatus") {
    return { ok: true, ...(await filterUpdateStatus()) };
  }
  return null;
}
