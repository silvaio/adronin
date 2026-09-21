const BUNDLED_SITES =
  typeof ADRONIN_SITES === "undefined"
    ? { generichide: [], conditional: [], except: {}, extra: {} }
    : ADRONIN_SITES;

let sites = BUNDLED_SITES;

const FRAME_SRC =
  /doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|taboola\.com|outbrain\.com|amazon-adsystem\.com|criteo\.com|pubmatic\.com|rubiconproject\.com|2mdn\.net|adservice\.google|moatads\.com|scorecardresearch\.com|quantserve\.com|serving-sys\.com/i;

const DB_NAME = "adronin-filters";
const DB_VERSION = 1;
const STORE = "blobs";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function getFilterBlob(key) {
  try {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function hostChain(hostname) {
  const host = hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return [host];
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return labels;
  const chain = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    chain.push(labels.slice(index).join("."));
  }
  return chain;
}

function matchesHost(list, hostname) {
  return hostChain(hostname).some((host) => list.includes(host));
}

function whenRoot(callback) {
  if (document.documentElement) {
    callback(document.documentElement);
    return;
  }
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    callback(document.documentElement);
  });
  observer.observe(document, { childList: true });
}

function isPaused(hostname, pausedSites) {
  const chain = hostChain(hostname);
  return pausedSites.some((site) => chain.includes(site));
}

function selectorsFor(hostname, showGenerics) {
  const broadToSpecific = hostChain(hostname).slice().reverse();
  const active = new Set();
  if (showGenerics) {
    const excepted = new Set();
    for (const host of broadToSpecific) {
      for (const selector of sites.except[host] || []) excepted.add(selector);
    }
    for (const selector of sites.conditional || []) {
      if (!excepted.has(selector)) active.add(selector);
    }
  }
  for (const host of broadToSpecific) {
    for (const selector of sites.except[host] || []) active.delete(selector);
    for (const selector of sites.extra[host] || []) active.add(selector);
  }
  return [...active];
}

function escapeSelector(selector) {
  return selector.replace(/[\\{}]/g, "");
}

function applySpecific(selectors) {
  let style = document.getElementById("adronin-specific");
  if (!selectors.length) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "adronin-specific";
    (document.documentElement || document.head || document).append(style);
  }
  style.textContent = selectors
    .map(escapeSelector)
    .filter(Boolean)
    .map((selector) => `html:not([data-adronin="off"]) ${selector} { display: none !important; }`)
    .join("\n");
}

function injectGenericCss(cssText) {
  let style = document.getElementById("adronin-generic");
  if (!cssText) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "adronin-generic";
    (document.documentElement || document.head || document).prepend(style);
  }
  if (style.textContent !== cssText) style.textContent = cssText;
}

async function loadFilterSurfaces() {
  const liveSites = await getFilterBlob("sitesMap");
  const liveCss = await getFilterBlob("cosmeticCss");
  sites = liveSites && typeof liveSites === "object" ? liveSites : BUNDLED_SITES;

  if (typeof liveCss === "string" && liveCss) {
    injectGenericCss(liveCss);
    return;
  }
  try {
    const response = await fetch(chrome.runtime.getURL("rules/cosmetic-generic.css"));
    if (response.ok) injectGenericCss(await response.text());
  } catch {
    /* Packaged CSS is the fallback when no live compile is stored. */
  }
}

function stripFrames(root) {
  if (root.getAttribute?.("data-adronin") === "off") return;
  root.querySelectorAll?.("iframe, amp-ad, ins.adsbygoogle").forEach((node) => {
    const src = node.getAttribute("src") || "";
    const id = node.id || "";
    if (node.localName === "iframe" && !FRAME_SRC.test(`${src} ${id}`)) return;
    if (node.localName === "iframe" || node.localName === "amp-ad" || node.localName === "ins") {
      node.remove();
    }
  });
}

let frameObserver = null;
let framePass = false;

function watchFrames(root) {
  frameObserver?.disconnect();
  frameObserver = new MutationObserver(() => {
    if (framePass) return;
    framePass = true;
    requestAnimationFrame(() => {
      framePass = false;
      stripFrames(root);
    });
  });
  frameObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
}

async function apply() {
  await loadFilterSurfaces();
  const stored = await chrome.storage.local.get({
    enabled: true,
    pausedSites: [],
  });
  const hostname = location.hostname;
  const paused = !stored.enabled || isPaused(hostname, stored.pausedSites || []);
  const generichide = matchesHost(sites.generichide || [], hostname);
  whenRoot((root) => {
    if (paused) root.setAttribute("data-adronin", "off");
    else root.removeAttribute("data-adronin");
    if (paused || generichide) root.setAttribute("data-adronin-generic", "off");
    else root.removeAttribute("data-adronin-generic");
    if (paused) {
      applySpecific([]);
      frameObserver?.disconnect();
      return;
    }
    applySpecific(selectorsFor(hostname, !generichide));
    stripFrames(root);
    watchFrames(root);
  });
}

apply();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.pausedSites || changes.filtersEpoch) apply();
});
