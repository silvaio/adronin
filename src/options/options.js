const enabled = document.querySelector("#enabled");
const trackers = document.querySelector("#trackers");
const autoUpdate = document.querySelector("#auto-update");
const updateNow = document.querySelector("#update-now");
const updateStatus = document.querySelector("#update-status");
const paused = document.querySelector("#paused");
const empty = document.querySelector("#empty");
const clear = document.querySelector("#clear");
const build = document.querySelector("#build");

function formatWhen(stamp) {
  if (!stamp) return "never";
  return new Date(stamp).toLocaleString();
}

function render(sites) {
  paused.replaceChildren();
  empty.hidden = sites.length > 0;
  for (const hostname of sites) {
    const item = document.createElement("li");
    item.className = "site";
    const name = document.createElement("span");
    name.textContent = hostname;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Resume";
    button.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "setPaused", hostname, paused: false });
      await refresh();
    });
    item.append(name, button);
    paused.append(item);
  }
}

function renderUpdate(status) {
  const parts = [];
  if (status.liveNetworkActive) parts.push("Live EasyList rules are active.");
  else parts.push("Using the packaged filter set.");
  parts.push(`Last check: ${formatWhen(status.lastFilterCheck)}.`);
  parts.push(`Last update: ${formatWhen(status.lastFilterUpdate)}.`);
  if (status.liveStats) {
    parts.push(
      `Live compile: ${status.liveStats.ads} ad rules, ${status.liveStats.trackers} tracker rules.`,
    );
  }
  if (status.lastFilterError) parts.push(`Last error: ${status.lastFilterError}`);
  updateStatus.textContent = parts.join(" ");
}

async function refresh() {
  const stored = await chrome.storage.local.get({
    enabled: true,
    blockTrackers: true,
    autoUpdate: true,
    pausedSites: [],
  });
  enabled.checked = stored.enabled !== false;
  trackers.checked = stored.blockTrackers !== false;
  autoUpdate.checked = stored.autoUpdate !== false;
  render(stored.pausedSites || []);
  const status = await chrome.runtime.sendMessage({ type: "getFilterStatus" });
  if (status?.ok) renderUpdate(status);
}

enabled.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "setEnabled", enabled: enabled.checked });
});

trackers.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "setTrackers", blockTrackers: trackers.checked });
});

autoUpdate.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "setAutoUpdate", autoUpdate: autoUpdate.checked });
});

updateNow.addEventListener("click", async () => {
  updateNow.disabled = true;
  updateStatus.textContent = "Updating filters…";
  const result = await chrome.runtime.sendMessage({ type: "checkFilters", force: true });
  updateNow.disabled = false;
  if (!result?.ok) {
    updateStatus.textContent = `Update failed: ${result?.error || "unknown error"}`;
    return;
  }
  if (result.updated) {
    updateStatus.textContent = `Updated. ${result.stats.ads} ad rules, ${result.stats.trackers} tracker rules.`;
  } else {
    updateStatus.textContent = `Already up to date (${result.reason || "fresh"}).`;
  }
  await refresh();
});

clear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearPaused" });
  await refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});

fetch(chrome.runtime.getURL("rules/build-info.json"))
  .then((response) => (response.ok ? response.json() : null))
  .then((info) => {
    if (!info) return;
    build.textContent = `Packaged set: ${info.ads} ad rules, ${info.trackers} tracker rules, ${info.generic_selectors} cosmetic selectors.`;
  })
  .catch(() => {});

refresh();
