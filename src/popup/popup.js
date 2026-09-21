const power = document.querySelector("#power");
const pause = document.querySelector("#pause");
const count = document.querySelector("#count");
const countLabel = document.querySelector("#count-label");
const hint = document.querySelector("#hint");
const options = document.querySelector("#options");

let current = null;

function show(state) {
  current = state;
  const on = Boolean(state?.enabled);
  power.setAttribute("aria-checked", on ? "true" : "false");
  count.textContent = state?.page ? String(state.count || 0) : "-";
  countLabel.textContent = on ? "blocked on this page" : "blocking is off";
  if (!state?.page) {
    pause.disabled = true;
    pause.textContent = "This page can't be filtered";
    pause.setAttribute("aria-pressed", "false");
    hint.textContent = "Open a normal website to cut its ads.";
    return;
  }
  pause.disabled = !on;
  const paused = Boolean(state.paused);
  pause.setAttribute("aria-pressed", paused ? "true" : "false");
  pause.textContent = paused ? `Paused on ${state.hostname}` : `Pause on ${state.hostname}`;
  hint.textContent = paused
    ? "Reload the page to see it with ads."
    : "Reload a page after you pause it.";
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  if (state?.ok) show(state);
}

power.addEventListener("click", async () => {
  if (!current) return;
  await chrome.runtime.sendMessage({ type: "setEnabled", enabled: !current.enabled });
  await refresh();
});

pause.addEventListener("click", async () => {
  if (!current?.page) return;
  await chrome.runtime.sendMessage({
    type: "setPaused",
    hostname: current.hostname,
    paused: !current.paused,
  });
  await refresh();
});

options.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
