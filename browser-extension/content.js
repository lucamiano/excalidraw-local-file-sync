const DEFAULT_CONFIG = {
  syncIntervalMs: 2000,
  autosyncEnabled: false,
};

let syncTimer = null;
let lastSceneHash = null;
let permissionBannerNode = null;

function ensurePermissionBannerNode() {
  if (permissionBannerNode?.isConnected) {
    return permissionBannerNode;
  }

  const banner = document.createElement("div");
  banner.id = "excalidraw-local-file-sync-alert";
  banner.style.position = "fixed";
  banner.style.top = "16px";
  banner.style.right = "16px";
  banner.style.zIndex = "2147483647";
  banner.style.maxWidth = "360px";
  banner.style.padding = "14px 16px";
  banner.style.borderRadius = "14px";
  banner.style.background = "#b4472c";
  banner.style.color = "#fff7f3";
  banner.style.boxShadow = "0 18px 40px rgba(70, 43, 20, 0.24)";
  banner.style.fontFamily = "\"Segoe UI\", sans-serif";
  banner.style.fontSize = "13px";
  banner.style.lineHeight = "1.45";
  banner.style.display = "none";
  banner.style.whiteSpace = "pre-wrap";
  document.documentElement.appendChild(banner);

  permissionBannerNode = banner;
  return banner;
}

function setPermissionBanner(message) {
  const banner = ensurePermissionBannerNode();
  if (!message) {
    banner.style.display = "none";
    banner.textContent = "";
    return;
  }

  banner.textContent = `Excalidraw Local File Sync\n${message}`;
  banner.style.display = "block";
}

async function refreshPermissionBanner() {
  try {
    const { permissionLost, permissionLostMessage } = await chrome.storage.local.get([
      "permissionLost",
      "permissionLostMessage",
    ]);

    if (permissionLost && permissionLostMessage) {
      setPermissionBanner(permissionLostMessage);
      return;
    }

    setPermissionBanner("");
  } catch (error) {
    console.warn("[excalidraw-sync] unable to refresh permission banner", error);
  }
}

async function persistSyncStatus(status) {
  try {
    await chrome.storage.local.set({
      lastSyncStatus: {
        ...status,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.warn("[excalidraw-sync] unable to persist sync status", error);
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isElement(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      typeof entry.type === "string" &&
      typeof entry.version === "number",
  );
}

function isElementsCandidate(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isElement);
}

function isAppStateCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return [
    "viewBackgroundColor",
    "currentItemStrokeColor",
    "theme",
    "zoom",
    "scrollX",
    "scrollY",
  ].some((key) => key in value);
}

function isFilesCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const entries = Object.values(value);
  if (entries.length === 0) {
    return false;
  }

  return entries.every((entry) => {
    return Boolean(
      entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.mimeType === "string",
    );
  });
}

function rankKey(key, expectedToken) {
  const lower = key.toLowerCase();
  let score = 0;
  if (lower.includes("excalidraw")) {
    score += 10;
  }
  if (lower.includes(expectedToken)) {
    score += 10;
  }
  if (lower.includes("local")) {
    score += 1;
  }
  return score;
}

function pickBestCandidate(candidates, expectedToken) {
  return candidates
    .sort((left, right) => rankKey(right.key, expectedToken) - rankKey(left.key, expectedToken))
    .at(0);
}

function extractSceneFromLocalStorage() {
  const elementCandidates = [];
  const appStateCandidates = [];
  const fileCandidates = [];
  const rawSnapshot = {};

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key) {
      continue;
    }

    const rawValue = window.localStorage.getItem(key);
    if (rawValue == null) {
      continue;
    }

    rawSnapshot[key] = rawValue;
    const parsed = parseJson(rawValue);
    if (!parsed) {
      continue;
    }

    if (isElementsCandidate(parsed)) {
      elementCandidates.push({ key, value: parsed });
      continue;
    }

    if (isAppStateCandidate(parsed)) {
      appStateCandidates.push({ key, value: parsed });
      continue;
    }

    if (isFilesCandidate(parsed)) {
      fileCandidates.push({ key, value: parsed });
    }
  }

  const bestElements = pickBestCandidate(elementCandidates, "elements");
  const bestAppState = pickBestCandidate(appStateCandidates, "app");
  const bestFiles = pickBestCandidate(fileCandidates, "files");

  if (!bestElements || !bestAppState) {
    return {
      ok: false,
      error: "Could not find Excalidraw scene data in localStorage.",
      debug: {
        availableKeys: Object.keys(rawSnapshot),
      },
    };
  }

  return {
    ok: true,
    scene: {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: bestElements.value,
      appState: bestAppState.value,
      files: bestFiles?.value ?? {},
    },
    debug: {
      elementKey: bestElements.key,
      appStateKey: bestAppState.key,
      filesKey: bestFiles?.key ?? null,
      localStorageKeys: Object.keys(rawSnapshot),
    },
  };
}

function hashScene(scene) {
  return JSON.stringify({
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files,
  });
}

async function syncOnce(reason) {
  const extraction = extractSceneFromLocalStorage();
  if (!extraction.ok) {
    await persistSyncStatus({
      ok: false,
      reason,
      stage: "extract",
      message: extraction.error,
      debug: extraction.debug,
    });
    console.debug("[excalidraw-sync]", extraction.error, extraction.debug);
    if (reason === "force") {
      throw new Error(extraction.error);
    }
    return {
      ok: false,
      stage: "extract",
      message: extraction.error,
      debug: extraction.debug,
    };
  }

  const sceneHash = hashScene(extraction.scene);
  if (sceneHash === lastSceneHash && reason !== "force") {
    const result = {
      ok: true,
      skipped: true,
      stage: "dedupe",
      message: "Scene unchanged since last sync.",
    };
    await persistSyncStatus({
      ...result,
      reason,
    });
    return result;
  }

  const response = await chrome.runtime.sendMessage({
    type: "sync-scene",
    mode: reason === "interval" || reason === "startup" || reason === "focus" || reason === "beforeunload" ? "autosync" : "manual",
    scene: extraction.scene,
    reason,
    debug: extraction.debug,
  });

  if (response?.ok) {
    lastSceneHash = sceneHash;
    const result = {
      ok: true,
      stage: "write",
      message: `Synced to ${response.result.fileName}`,
      result: response.result,
      debug: extraction.debug,
    };
    await persistSyncStatus({
      ...result,
      reason,
    });
    console.debug("[excalidraw-sync] synced", response.result);
    return result;
  }

  if (response?.skipped) {
    const result = {
      ok: false,
      skipped: true,
      stage: "config",
      message: response.error ?? "Sync skipped.",
    };
    await persistSyncStatus({
      ...result,
      reason,
    });
    return result;
  }

  const message = response?.error ?? "Unknown sync failure.";
  await persistSyncStatus({
    ok: false,
    reason,
    stage: "write",
    message,
    response,
    debug: extraction.debug,
  });
  console.warn("[excalidraw-sync] sync failed", response);
  if (reason === "force") {
    throw new Error(message);
  }
  return {
    ok: false,
    stage: "write",
    message,
    response,
  };
}

async function restartSyncLoop() {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  window.clearInterval(syncTimer);
  syncTimer = null;

  if (!config.autosyncEnabled) {
    return;
  }

  syncTimer = window.setInterval(() => {
    syncOnce("interval").catch((error) => {
      console.warn("[excalidraw-sync] interval error", error);
    });
  }, Math.max(1000, Number(config.syncIntervalMs) || DEFAULT_CONFIG.syncIntervalMs));

  syncOnce("startup").catch((error) => {
    console.warn("[excalidraw-sync] startup error", error);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "force-sync") {
    return false;
  }

  syncOnce("force")
    .then((result) => {
      sendResponse(result ?? { ok: true });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  refreshPermissionBanner().catch((error) => {
    console.warn("[excalidraw-sync] permission banner update error", error);
  });

  restartSyncLoop().catch((error) => {
    console.warn("[excalidraw-sync] config reload error", error);
  });
});

window.addEventListener(
  "keydown",
  (event) => {
    const isSaveShortcut =
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "s";

    if (!isSaveShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    syncOnce("force")
      .then((result) => {
        console.debug("[excalidraw-sync] keyboard shortcut result", result);
      })
      .catch((error) => {
        console.warn("[excalidraw-sync] keyboard shortcut error", error);
      });
  },
  true,
);

window.addEventListener("focus", () => {
  syncOnce("focus").catch((error) => {
    console.warn("[excalidraw-sync] focus error", error);
  });
});

window.addEventListener("beforeunload", () => {
  syncOnce("beforeunload").catch(() => {});
});

restartSyncLoop().catch((error) => {
  console.warn("[excalidraw-sync] init error", error);
});

refreshPermissionBanner().catch((error) => {
  console.warn("[excalidraw-sync] initial permission banner error", error);
});
