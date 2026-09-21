#!/usr/bin/env node
/**
 * Load adronin in Chromium, open the Obfusgated ad-block test, and require 100%.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("/tmp/node_modules/ws");

const ROOT = path.resolve(__dirname, "..");
const TEST_URL = "https://obfusgated.com/tools/ad-block-test";
const DOMAINS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "filters/obfusgated-domains.json"), "utf8"),
);
const PORT = 9333 + Math.floor(Math.random() * 200);

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDevtools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      await get(`http://127.0.0.1:${PORT}/json/version`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("devtools not ready");
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  const send = (method, params = {}) => {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
  };
  return { ws, send };
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "adronin-obf-"));
  const chromium = spawn(
    "chromium",
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForDevtools();
    // Give the extension service worker a moment to register DNR rules.
    await sleep(2500);
    const tabs = await get(`http://127.0.0.1:${PORT}/json`);
    const blank = tabs.find((t) => t.type === "page");
    if (!blank) throw new Error("no page target");
    const { ws, send } = await connect(blank);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: TEST_URL });
    for (let i = 0; i < 60; i += 1) {
      const state = await send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (state.result?.value === "complete") break;
      await sleep(500);
    }
    // Run the same probe algorithm the site uses, against every domain.
    const expression = `
      (async () => {
        const byTop = ${JSON.stringify(DOMAINS.byTop)};
        const x = async (e) => {
          const t = new AbortController();
          const o = setTimeout(() => t.abort(), 600);
          try {
            const a = await fetch("https://dns.google/resolve?name=" + e + "&type=A", {
              signal: t.signal,
              cache: "force-cache",
            });
            clearTimeout(o);
            if (!a.ok) return null;
            const r = await a.json();
            if (r.Answer && Array.isArray(r.Answer)) {
              return r.Answer.some((ans) => {
                const data = ans.data;
                return data !== "0.0.0.0" && data !== "127.0.0.1" && data !== "::1";
              });
            }
            return false;
          } catch (err) {
            clearTimeout(o);
            return null;
          }
        };
        const v = async (e) => {
          const t = new AbortController();
          const o = setTimeout(() => t.abort(), 800);
          try {
            await fetch("https://" + e + "/favicon.ico?cb=" + Date.now(), {
              method: "HEAD",
              mode: "no-cors",
              credentials: "omit",
              signal: t.signal,
            });
            clearTimeout(o);
            return true;
          } catch (err) {
            clearTimeout(o);
            return false;
          }
        };
        const w = async (e) => {
          const t = new AbortController();
          const o = setTimeout(() => t.abort(), 800);
          try {
            await fetch("https://" + e + "/robots.txt?cb=" + Date.now(), {
              method: "HEAD",
              mode: "no-cors",
              credentials: "omit",
              signal: t.signal,
            });
            clearTimeout(o);
            return false;
          } catch (err) {
            clearTimeout(o);
            return true;
          }
        };
        const j = async (e) => {
          const t = new AbortController();
          const o = setTimeout(() => t.abort(), 800);
          try {
            await fetch("https://" + e + "/?cb=" + Date.now(), {
              method: "HEAD",
              mode: "no-cors",
              credentials: "omit",
              signal: t.signal,
            });
            clearTimeout(o);
            return false;
          } catch (err) {
            clearTimeout(o);
            return true;
          }
        };
        const A = async (e) => {
          if (String(e).includes("localhost")) return false;
          try {
            const timeout = new Promise((_, reject) =>
              setTimeout(() => reject(Error("Overall timeout for " + e)), 2500),
            );
            const work = (async () => {
              const [img, head] = await Promise.all([
                new Promise((resolve) => {
                  const image = new Image();
                  const timer = setTimeout(() => {
                    image.onload = image.onerror = null;
                    image.src = "";
                    resolve(false);
                  }, 1000);
                  image.onload = () => {
                    clearTimeout(timer);
                    resolve(true);
                  };
                  image.onerror = () => {
                    clearTimeout(timer);
                    resolve(false);
                  };
                  image.src = "https://" + e + "/favicon.ico?cb=" + Date.now();
                }),
                v(e),
              ]);
              if (img || head) return false;
              const [robots, root] = await Promise.all([w(e), j(e)]);
              if (!robots || !root) return false;
              const dns = await x(e);
              return dns !== false || null;
            })();
            return await Promise.race([work, timeout]);
          } catch (err) {
            return true;
          }
        };

        const results = {};
        const domains = Object.values(byTop).flat();
        for (let i = 0; i < domains.length; i += 20) {
          const slice = domains.slice(i, i + 20);
          await Promise.all(
            slice.map(async (domain) => {
              results[domain] = await A(domain);
            }),
          );
        }
        const categories = {};
        for (const [name, list] of Object.entries(byTop)) {
          const blocked = list.filter((d) => results[d] === true).length;
          categories[name] = {
            blocked,
            total: list.length,
            percent: list.length ? Math.round((blocked / list.length) * 100) : 0,
            failed: list.filter((d) => results[d] !== true),
          };
        }
        const total = domains.length;
        const blocked = domains.filter((d) => results[d] === true).length;
        return {
          overall: total ? Math.round((blocked / total) * 100) : 0,
          blocked,
          total,
          categories,
        };
      })()
    `;
    const evaluated = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(JSON.stringify(evaluated.exceptionDetails));
    }
    const result = evaluated.result.value;
    console.log(JSON.stringify(result, null, 2));
    ws.close();
    const bad = Object.entries(result.categories || {}).filter(([, info]) => info.percent !== 100);
    if (result.overall !== 100 || bad.length) {
      process.exitCode = 1;
    }
  } finally {
    chromium.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
