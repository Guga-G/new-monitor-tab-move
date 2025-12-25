// =====================================================
// New Monitor Tab Move — ULTRA-FAST STABLE BUILD
// MV3 Service Worker
// =====================================================

const DEBUG = false; // set false when fully stable
const DEBOUNCE_MS = 120;

let lastRun = 0;

function log(...a) {
  if (DEBUG) console.log("[NMTM]", ...a);
}

// =====================================================
// COMMAND HANDLER
// =====================================================

chrome.commands.onCommand.addListener(async (cmd) => {
  const now = Date.now();
  if (now - lastRun < DEBOUNCE_MS) {
    log("Debounced:", cmd);
    return;
  }
  lastRun = now;

  try {
    if (cmd === "move-normal") await move(false);
    if (cmd === "move-incog") await move(true);
  } catch (e) {
    console.error("[NMTM] Command error:", e);
  }
});

// =====================================================
// CORE
// =====================================================

async function move(wantIncog) {
  const srcWin = await getCurrentWindow();
  if (!srcWin) return;

  if (!!srcWin.incognito !== !!wantIncog) {
    log("Mode mismatch");
    return;
  }

  const tab = await getActiveTab(srcWin.id);
  if (!tab) return;

  const displays = await getDisplays();
  if (displays.length < 2) return;

  const srcIdx = findDisplayIndex(displays, srcWin);
  const targetIdx = (srcIdx + 1) % displays.length;
  const target = displays[targetIdx];
  const work = target.workArea || target.bounds;

  const fsInfo = await getFullscreenInfo(tab.id);

  // allow Chrome to settle metrics
  await sleep(80);

  const dest = await findDestWindow(work, wantIncog, srcWin.id);

  if (dest) {
    log("Merging into existing window", dest.id);
    await focusAndMaximize(dest.id, work);
    await moveTab(tab.id, dest.id);
    await activateTab(tab.id);
    restoreFullscreen(tab.id, fsInfo);
    return;
  }

  log("Creating new window");
  const newWin = await createWindow(work, wantIncog);
  if (!newWin) return;

  await moveTab(tab.id, newWin.id);
  await cleanupStarterTab(newWin.id, tab.id);
  await focusAndMaximize(newWin.id, work);
  restoreFullscreen(tab.id, fsInfo);
}

// =====================================================
// FULLSCREEN (INCognito-STABLE, RETRY SAFE)
// =====================================================

async function getFullscreenInfo(tabId) {
  try {
    return await exec(tabId, () => ({
      isFs: !!document.fullscreenElement,
      host: location.host || ""
    }));
  } catch {
    return { isFs: false };
  }
}

function restoreFullscreen(tabId, fs) {
  if (!fs?.isFs) return;

  const delays = [180, 420, 820]; // incognito-safe retries

  delays.forEach((delay, attempt) => {
    setTimeout(() => {
      exec(tabId, async (info) => {
        const logFS = (...a) => console.log("[NMTM-FS]", ...a);

        const isTwitch = info.host.includes("twitch.tv");

        const v = document.querySelector("video");
        const yt = document.querySelector(".html5-video-player");
        const el = yt || v || document.documentElement;

        if (!el?.requestFullscreen) {
          logFS("No fullscreen-capable element");
          return;
        }

        try {
          if (!document.fullscreenElement) {
            logFS("Request fullscreen attempt", attempt + 1);
            await el.requestFullscreen();
          }

          if (v) {
            try { await v.play(); } catch {}
          }

          // Twitch safety toggle (only once, mid-attempt)
          if (isTwitch && attempt === 1) {
            logFS("Twitch safety toggle");
            try {
              await document.exitFullscreen();
              await new Promise(r => setTimeout(r, 120));
              await el.requestFullscreen();
            } catch {}
          }
        } catch (e) {
          logFS("Fullscreen error:", e?.name);
        }
      }, fs);
    }, delay);
  });
}

// =====================================================
// WINDOW DETECTION
// =====================================================

async function findDestWindow(area, incog, excludeId) {
  const wins = await promisify(chrome.windows.getAll, {});

  const candidates = wins.filter(w => {
    if (!w || w.type !== "normal") return false;
    if (w.id === excludeId) return false;
    if (!!w.incognito !== !!incog) return false;
    if (typeof w.left !== "number") return false;

    const cx = w.left + w.width / 2;
    const cy = w.top + w.height / 2;

    return (
      cx >= area.left &&
      cx < area.left + area.width &&
      cy >= area.top &&
      cy < area.top + area.height
    );
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.state === "maximized" && b.state !== "maximized") return -1;
    if (b.state === "maximized" && a.state !== "maximized") return 1;
    if (a.focused && !b.focused) return -1;
    if (b.focused && !a.focused) return 1;
    return 0;
  });

  return candidates[0];
}

// =====================================================
// HELPERS
// =====================================================

function exec(tabId, func, arg) {
  return new Promise(resolve =>
    chrome.scripting.executeScript({
      target: { tabId },
      userGesture: true,
      func,
      args: arg ? [arg] : []
    }, res => resolve(res?.[0]?.result))
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const getCurrentWindow = () =>
  promisify(chrome.windows.getCurrent, { populate: false });

const getActiveTab = winId =>
  promisify(chrome.tabs.query, { active: true, windowId: winId })
    .then(t => t?.[0]);

const getDisplays = () =>
  promisify(chrome.system.display.getInfo)
    .then(d => d.sort((a, b) => a.bounds.left - b.bounds.left));

function findDisplayIndex(displays, win) {
  const cx = win.left + win.width / 2;
  const cy = win.top + win.height / 2;
  const idx = displays.findIndex(d =>
    cx >= d.bounds.left &&
    cx < d.bounds.left + d.bounds.width &&
    cy >= d.bounds.top &&
    cy < d.bounds.top + d.bounds.height
  );
  return idx >= 0 ? idx : 0;
}

async function createWindow(area, incog) {
  return promisify(chrome.windows.create, {
    incognito: incog,
    focused: true,
    state: "normal",
    left: area.left,
    top: area.top,
    width: area.width,
    height: area.height
  });
}

const moveTab = (tabId, winId) =>
  promisify(chrome.tabs.move, tabId, { windowId: winId, index: -1 });

const activateTab = tabId =>
  promisify(chrome.tabs.update, tabId, { active: true });

async function cleanupStarterTab(winId, keepId) {
  const tabs = await promisify(chrome.tabs.query, { windowId: winId });
  for (const t of tabs) {
    if (t.id !== keepId) {
      chrome.tabs.remove(t.id);
      break;
    }
  }
}

async function focusAndMaximize(winId, area) {
  await promisify(chrome.windows.update, winId, {
    focused: true,
    state: "normal",
    left: area.left,
    top: area.top,
    width: area.width,
    height: area.height
  });

  setTimeout(() =>
    chrome.windows.update(winId, { state: "maximized", focused: true }),
    80
  );
}

function promisify(fn, ...args) {
  return new Promise(res => fn(...args, r => res(r)));
}

