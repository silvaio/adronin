const AD_NODES = [
  "ytd-ad-slot-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-banner-promo-renderer",
  "ytd-statement-banner-renderer",
  "ytd-action-companion-ad-renderer",
  "ytd-promoted-sparkles-web-renderer",
  ".ytp-ad-module",
  "#player-ads",
  "#masthead-ad",
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
].join(",");

const SKIP_BUTTONS = [
  ".ytp-skip-ad-button",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-overlay-close-button",
].join(",");

function sitePaused(hostname, pausedSites) {
  return pausedSites.some((site) => hostname === site || hostname.endsWith(`.${site}`));
}

function cutPlayerAd() {
  if (!enabled) return;
  document.querySelectorAll(AD_NODES).forEach((node) => node.remove());
  const player = document.querySelector(".html5-video-player");
  if (!player) return;
  const video = player.querySelector("video");
  const showing = player.classList.contains("ad-showing");
  if (!video) return;
  if (showing) {
    video.dataset.adroninRate = "1";
    if (video.playbackRate < 16) video.playbackRate = 16;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.max(video.duration - 0.05, 0);
    }
    document.querySelectorAll(SKIP_BUTTONS).forEach((button) => {
      if (button instanceof HTMLElement) button.click();
    });
    return;
  }
  if (video.dataset.adroninRate) {
    video.playbackRate = 1;
    delete video.dataset.adroninRate;
  }
}

let enabled = true;

chrome.storage.local.get({ enabled: true, pausedSites: [] }, (stored) => {
  enabled = stored.enabled !== false && !sitePaused(location.hostname, stored.pausedSites || []);
  if (!enabled) return;
  cutPlayerAd();
  const observer = new MutationObserver(() => cutPlayerAd());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  setInterval(cutPlayerAd, 800);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.enabled && !changes.pausedSites) return;
  chrome.storage.local.get({ enabled: true, pausedSites: [] }, (stored) => {
    enabled = stored.enabled !== false && !sitePaused(location.hostname, stored.pausedSites || []);
  });
});
