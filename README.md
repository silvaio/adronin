# adronin

Chromium extension that blocks ad and tracker requests, then removes leftover ad slots from the page.

The toolbar icon is a katana cutting a banner.

## Install

1. Build the filter lists (this also refreshes `rules/`):

   ```bash
   python3 scripts/compile_filters.py
   ```

2. Open `chrome://extensions` or `chromium://extensions`.
3. Turn on Developer mode.
4. Choose Load unpacked and select this directory.

The popup shows how many requests were blocked on the current tab. You can pause filtering for that site. On the options page you can turn ads or trackers off, resume paused sites, and force a filter update.

Reload a tab after you pause it. New requests are blocked right away. A reload is what brings ads back on a paused page.

## What it blocks

- Ads from [EasyList](https://easylist.to/): ad-server domains, URL patterns, and cosmetic rules that hide slots, iframes, and common ad containers.
- Trackers from [EasyPrivacy](https://easylist.to/). On by default. Turn them off in settings if a site breaks.
- YouTube in-player ads and known ad modules around the player. YouTube changes this often, so this part can lag.

Paused sites get a higher-priority `allowAllRequests` rule. EasyList `$generichide` exceptions still turn off generic cosmetic filtering on those sites, without opening them to ad requests.

## Update the lists

EasyList changes often. After the browser starts, and about every 12 hours, adronin checks the remote lists. If they changed, it recompiles and installs live rules. Until that finishes, the packaged files in `rules/` are what runs. Use the options page to toggle auto-update or run an update now.

To rebuild the packaged baseline:

```bash
python3 scripts/compile_filters.py
```

Then click Reload on the extension card. The script caches downloads in `build/lists/`. Delete that directory first for a forced re-download.

Checks:

```bash
python3 -m unittest scripts/test_compile_filters.py
node --check src/background.js src/lib/filter-compile.js src/lib/filter-update.js src/content/cosmetic.js src/popup/popup.js src/options/options.js
python3 scripts/smoke_test.py
```

The smoke test loads the extension in headless Chromium. It expects the ad slot hidden, the `adsbygoogle` element gone, `gpt.js` and Google Analytics blocked, and the fixture heading left alone.

## Filter license

EasyList and EasyPrivacy are © their contributors and licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The compiled files in `rules/` and `src/content/sites.js` are derived from those lists. Sources: [github.com/easylist/easylist](https://github.com/easylist/easylist).

The compiler skips rules it does not understand (redirects, CSP injections, scriptlets, procedural cosmetics) instead of guessing.

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | Manifest V3 extension |
| `src/background.js` | Rule toggles, per-site pause, blocked-request count, filter updates |
| `src/lib/filter-compile.js` | Runtime EasyList to DNR / cosmetic compiler |
| `src/lib/filter-update.js` | Background fetch, apply, and scheduling |
| `src/content/cosmetic.js` | Hides and removes ad elements |
| `src/content/youtube.js` | In-player YouTube ads |
| `src/popup/` | Toolbar popup |
| `src/options/` | Settings |
| `rules/` | Compiled network and cosmetic filters |
| `scripts/compile_filters.py` | EasyList / EasyPrivacy compiler |
| `icons/` | Extension icons |
