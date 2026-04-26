import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.resolve("docs/catalog-ui-before-after/assets");
const baseUrls = {
  before: "http://127.0.0.1:5175/catalog?start=2026-04-18&end=2026-04-24",
  after: "http://127.0.0.1:5173/catalog?start=2026-04-18&end=2026-04-24",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chrome may still be starting.
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    const handlers = events.get(message.method) || [];
    for (const handler of handlers) handler(message.params || {});
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      const send = (method, params = {}) => {
        const messageId = ++id;
        socket.send(JSON.stringify({ id: messageId, method, params }));
        return new Promise((innerResolve, innerReject) => {
          pending.set(messageId, { resolve: innerResolve, reject: innerReject });
        });
      };
      const once = (method) =>
        new Promise((innerResolve) => {
          const handler = (params) => {
            events.set(
              method,
              (events.get(method) || []).filter((item) => item !== handler),
            );
            innerResolve(params);
          };
          events.set(method, [...(events.get(method) || []), handler]);
        });
      resolve({ send, once, close: () => socket.close() });
    });
    socket.addEventListener("error", reject);
  });
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`Could not create Chrome target: ${response.status}`);
  const target = await response.json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
  return client;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function waitForPageReady(client) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const ready = await evaluate(
      client,
      `Boolean(document.body && document.body.innerText.includes("Каталог") && document.body.innerText.length > 2000)`,
    );
    if (ready) break;
    await sleep(250);
  }
  await sleep(1200);
}

async function screenshot(client, name) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(path.join(outDir, name), Buffer.from(result.data, "base64"));
}

async function scrollTo(client, expression) {
  await evaluate(
    client,
    `(() => {
      const element = ${expression};
      if (element) {
        const rect = element.getBoundingClientRect();
        window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - 120), behavior: "instant" });
      }
    })()`,
  );
  await sleep(450);
}

async function captureSet(label, url) {
  const client = await createTarget(chromePort, url);
  await waitForPageReady(client);

  await evaluate(client, `window.scrollTo({ top: 0, behavior: "instant" })`);
  await sleep(300);
  await screenshot(client, `${label}-top.png`);

  await scrollTo(
    client,
    `[...document.querySelectorAll("h1,h2,h3,button,summary,div")].find((el) => /Ошибки|Проблемы|сбор/i.test(el.textContent || ""))`,
  );
  await screenshot(client, `${label}-issues.png`);

  await scrollTo(
    client,
    `[...document.querySelectorAll("table,[role='table'],.catalog-table-shell,.catalog-products-table")][0] || [...document.querySelectorAll("h1,h2,h3,div")].find((el) => /Товар|Остаток|CTR|CR/.test(el.textContent || ""))`,
  );
  await screenshot(client, `${label}-table.png`);

  client.close();
}

await fs.mkdir(outDir, { recursive: true });

const chromePort = Number(process.env.CAPTURE_CHROME_PORT || 9243);
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "xway-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${chromePort}`,
  "about:blank",
], { stdio: "ignore" });

const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1] || null;

try {
  await waitForJson(`http://127.0.0.1:${chromePort}/json/version`);
  if (!only || only === "before") await captureSet("before", baseUrls.before);
  if (!only || only === "after") await captureSet("after", baseUrls.after);
} finally {
  chrome.kill("SIGTERM");
  await fs.rm(userDataDir, { recursive: true, force: true });
}

console.log(`Screenshots written to ${outDir}`);
