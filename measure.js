// Measures scrolling in the repro extension's real action popup vs. the same page in a tab.
//
// Launches the given Chrome / Chromium binary with a throwaway profile and the extension loaded,
// then for each surface reports the idle frame rate and how many times per second the scroll
// position actually advances during a fast scroll gesture. macOS only (it focuses the browser
// with osascript, because chrome.action.openPopup() needs a focused window).
//
//   node measure.js "/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
//
// Requires Node 22+ (built-in WebSocket and fetch).
const { spawn, execSync } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");

const BIN = process.argv[2];
if (!BIN) {
  console.error("usage: node measure.js <path to Chrome binary>");
  process.exit(2);
}
const EXT_DIR = path.join(__dirname, "extension");
const PORT = 9300;
const CDP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    ws.onerror = () => reject(new Error(`could not connect to ${wsUrl}`));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

async function run(c, fn, arg) {
  const r = await c.send("Runtime.evaluate", {
    expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

const targets = async () => (await fetch(`${CDP}/json/list`)).json();

async function measure(c) {
  for (let i = 0; i < 100; i++) {
    if (await run(c, () => !!document.getElementById("spacer")?.children.length).catch(() => false)) break;
    await sleep(100);
  }
  await run(c, () => (document.getElementById("scroller").scrollTop = 0));
  await sleep(500);

  const idleFps = await run(
    c,
    () =>
      new Promise((resolve) => {
        const ts = [];
        const frame = (t) => {
          ts.push(t);
          if (ts.length < 61) return requestAnimationFrame(frame);
          const gaps = ts
            .slice(1)
            .map((t, i) => t - ts[i])
            .sort((a, b) => a - b);
          resolve(1000 / gaps[Math.floor(gaps.length / 2)]);
        };
        requestAnimationFrame(frame);
      }),
  );

  // Record the scroll position every animation frame during the gesture.
  await run(c, () => {
    const scroller = document.getElementById("scroller");
    const samples = (window.__samples = []);
    window.__sampling = true;
    const frame = (t) => {
      if (!window.__sampling) return;
      samples.push({ t, top: scroller.scrollTop });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await c.send("Input.synthesizeScrollGesture", {
    x: 190,
    y: 300,
    yDistance: -15000,
    speed: 12000,
    gestureSourceType: "mouse",
  });
  await sleep(600);
  const samples = await run(c, () => {
    window.__sampling = false;
    return window.__samples;
  });

  const moving = samples.filter((s, i) => i > 0 && s.top !== samples[i - 1].top);
  const seconds = moving.length > 1 ? (moving.at(-1).t - moving[0].t) / 1000 : 0;
  return {
    idleFps: Math.round(idleFps),
    scrollUpdatesPerSec: seconds ? Math.round((moving.length - 1) / seconds) : 0,
    scrolledPx: Math.round(samples.at(-1)?.top ?? 0),
  };
}

(async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "popup-repro-profile-"));
  const browser = spawn(
    BIN,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );
  try {
    let version;
    for (let i = 0; i < 100 && !version; i++) {
      version = await fetch(`${CDP}/json/version`).then((r) => r.json(), () => null);
      if (!version) await sleep(100);
    }
    let sw;
    for (let i = 0; i < 100 && !sw; i++) {
      sw = (await targets()).find(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith("chrome-extension://") &&
          t.url.endsWith("/sw.js"),
      );
      if (!sw) await sleep(100);
    }
    if (!sw) throw new Error("extension did not load");
    const popupUrl = `chrome-extension://${new URL(sw.url).hostname}/popup.html`;

    // The same page in a regular tab, sized like the popup.
    const tab = await (await fetch(`${CDP}/json/new?${popupUrl}`, { method: "PUT" })).json();
    const tc = await connect(tab.webSocketDebuggerUrl);
    await tc.send("Emulation.setDeviceMetricsOverride", {
      width: 380,
      height: 600,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await sleep(1000);
    const tabResult = await measure(tc);
    tc.close();
    await fetch(`${CDP}/json/close/${tab.id}`);

    // The real action popup. openPopup() needs this browser's window focused.
    execSync(
      `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${browser.pid}) to true'`,
    );
    await sleep(800);
    const swc = await connect(sw.webSocketDebuggerUrl);
    const opened = await run(swc, () =>
      chrome.action.openPopup().then(
        () => true,
        (e) => String(e),
      ),
    );
    swc.close();
    let popupResult = { error: `openPopup: ${opened}` };
    if (opened === true) {
      let popup;
      for (let i = 0; i < 50 && !popup; i++) {
        popup = (await targets()).find((t) => t.type === "page" && t.url === popupUrl);
        if (!popup) await sleep(100);
      }
      const pc = await connect(popup.webSocketDebuggerUrl);
      await sleep(1000);
      popupResult = await measure(pc);
      pc.close();
    }

    console.log(JSON.stringify({ browser: version.Browser, tab: tabResult, popup: popupResult }));
  } finally {
    browser.kill("SIGTERM");
    await sleep(1500);
    rmSync(profile, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
