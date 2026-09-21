import { LIST_BASE, LIST_SOURCES, compileFilters } from "./filter-compile.js";
import { putFilterBlob } from "./filter-store.js";

export const LIVE_ADS_BASE = 100_000;
export const LIVE_TRACKERS_BASE = 500_000;
export const LIVE_ADS_SPAN = 400_000;
export const LIVE_TRACKERS_SPAN = 400_000;
export const UPDATE_ALARM = "adronin-filter-update";
export const CHECK_INTERVAL_MINUTES = 60 * 12;
export const STARTUP_DELAY_MS = 8_000;

const BATCH = 4_000;

function liveIdRange(base, span) {
  return Array.from({ length: span }, (_, index) => base + index);
}

async function getMeta() {
  const stored = await chrome.storage.local.get({
    autoUpdate: true,
    filterRevision: "",
    lastFilterCheck: 0,
    lastFilterUpdate: 0,
    liveNetworkActive: false,
    lastFilterError: "",
    liveStats: null,
  });
  return {
    autoUpdate: stored.autoUpdate !== false,
    filterRevision: stored.filterRevision || "",
    lastFilterCheck: Number(stored.lastFilterCheck) || 0,
    lastFilterUpdate: Number(stored.lastFilterUpdate) || 0,
    liveNetworkActive: Boolean(stored.liveNetworkActive),
    lastFilterError: stored.lastFilterError || "",
    liveStats: stored.liveStats || null,
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    cache: "no-cache",
    headers: { "User-Agent": "adronin-filter-update" },
  });
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  const etag = response.headers.get("etag") || "";
  const modified = response.headers.get("last-modified") || "";
  const text = await response.text();
  return { text, stamp: etag || modified || String(text.length) };
}

async function fetchLists(paths) {
  const texts = [];
  const stamps = [];
  for (const path of paths) {
    const result = await fetchText(`${LIST_BASE}${path}`);
    texts.push(result.text);
    stamps.push(`${path}:${result.stamp}`);
  }
  return { texts, fingerprint: stamps.join("|") };
}

async function clearLiveRules(kind) {
  const base = kind === "ads" ? LIVE_ADS_BASE : LIVE_TRACKERS_BASE;
  const span = kind === "ads" ? LIVE_ADS_SPAN : LIVE_TRACKERS_SPAN;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= base && id < base + span);
  for (let offset = 0; offset < removeRuleIds.length; offset += BATCH) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeRuleIds.slice(offset, offset + BATCH),
      addRules: [],
    });
  }
}

export { clearLiveRules };

async function writeLiveRules(kind, rules) {
  const base = kind === "ads" ? LIVE_ADS_BASE : LIVE_TRACKERS_BASE;
  const span = kind === "ads" ? LIVE_ADS_SPAN : LIVE_TRACKERS_SPAN;
  if (rules.length > span) {
    throw new Error(`${kind} update has ${rules.length} rules; max ${span}`);
  }
  await clearLiveRules(kind);
  for (let offset = 0; offset < rules.length; offset += BATCH) {
    const chunk = rules.slice(offset, offset + BATCH).map((rule, index) => ({
      ...rule,
      id: base + offset + index,
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [],
      addRules: chunk,
    });
  }
}

export async function scheduleFilterUpdates() {
  await chrome.alarms.create(UPDATE_ALARM, {
    periodInMinutes: CHECK_INTERVAL_MINUTES,
    delayInMinutes: 1,
  });
}

export async function filterUpdateStatus() {
  return getMeta();
}

/**
 * @param {{ force?: boolean, syncRulesets: Function }} options
 */
export async function checkFilterUpdates({ force = false, syncRulesets }) {
  const meta = await getMeta();
  if (!meta.autoUpdate && !force) {
    return { ok: true, updated: false, reason: "disabled" };
  }

  let compiled;
  let fingerprint;
  try {
    const ads = await fetchLists(LIST_SOURCES.adNetwork);
    const cosmetic = await fetchLists(LIST_SOURCES.adCosmetic);
    const trackers = await fetchLists(LIST_SOURCES.trackerNetwork);
    fingerprint = [ads.fingerprint, cosmetic.fingerprint, trackers.fingerprint].join("||");

    await chrome.storage.local.set({ lastFilterCheck: Date.now(), lastFilterError: "" });

    if (!force && fingerprint === meta.filterRevision && meta.liveNetworkActive) {
      return { ok: true, updated: false, reason: "fresh" };
    }

    const extraResponse = await fetch(chrome.runtime.getURL("filters/extra.txt"));
    const extra = extraResponse.ok ? await extraResponse.text() : "";

    compiled = compileFilters({
      adNetwork: ads.texts,
      adCosmetic: cosmetic.texts,
      trackerNetwork: trackers.texts,
      extra,
    });
  } catch (error) {
    const message = String(error?.message || error);
    await chrome.storage.local.set({ lastFilterError: message, lastFilterCheck: Date.now() });
    return { ok: false, updated: false, error: message };
  }

  try {
    const stored = await chrome.storage.local.get({ enabled: true, blockTrackers: true });
    const enabled = stored.enabled !== false;
    const blockTrackers = stored.blockTrackers !== false;

    if (!enabled) {
      await clearLiveRules("ads");
      await clearLiveRules("trackers");
    } else {
      await writeLiveRules("ads", compiled.ads);
      if (blockTrackers) await writeLiveRules("trackers", compiled.trackers);
      else await clearLiveRules("trackers");
    }

    await putFilterBlob("cosmeticCss", compiled.css);
    await putFilterBlob("sitesMap", compiled.sites);
    await chrome.storage.local.set({
      liveNetworkActive: true,
      filterRevision: fingerprint,
      lastFilterUpdate: Date.now(),
      lastFilterError: "",
      liveStats: compiled.stats,
      filtersEpoch: Date.now(),
    });
    await syncRulesets();
    return {
      ok: true,
      updated: true,
      stats: compiled.stats,
      revision: fingerprint.slice(0, 80),
    };
  } catch (error) {
    const message = String(error?.message || error);
    await chrome.storage.local.set({ lastFilterError: message });
    return { ok: false, updated: false, error: message };
  }
}

export { liveIdRange, getMeta };
