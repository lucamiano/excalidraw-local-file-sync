import { loadFileHandle, saveFileHandle } from "./file-handle-store.js";

const DEFAULT_CONFIG = {
  syncIntervalMs: 2000,
  autosyncEnabled: false,
};

const syncIntervalInput = document.getElementById("syncIntervalMs");
const autosyncEnabledInput = document.getElementById("autosyncEnabled");
const openFileButton = document.getElementById("openFile");
const createFileButton = document.getElementById("createFile");
const restoreAccessButton = document.getElementById("restoreAccess");
const saveButton = document.getElementById("save");
const syncNowButton = document.getElementById("syncNow");
const statusNode = document.getElementById("status");

function setStatus(message) {
  statusNode.textContent = message;
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "unknown";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString();
}

async function loadConfig() {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  syncIntervalInput.value = String(config.syncIntervalMs);
  autosyncEnabledInput.checked = Boolean(config.autosyncEnabled);
}

async function saveConfig() {
  const config = {
    syncIntervalMs: Math.max(1000, Number(syncIntervalInput.value) || DEFAULT_CONFIG.syncIntervalMs),
    autosyncEnabled: autosyncEnabledInput.checked,
  };

  await chrome.storage.local.set(config);
  return config;
}

function getPickerTypes() {
  return [
    {
      description: "Excalidraw scene",
      accept: {
        "application/json": [".excalidraw"],
      },
    },
  ];
}

async function createLocalFile() {
  if (!("showSaveFilePicker" in window)) {
    throw new Error("This browser does not expose the File System Access API in the extension popup.");
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: "diagram.excalidraw",
    types: getPickerTypes(),
  });

  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Write permission was not granted for the selected file.");
  }

  await saveFileHandle(handle);
  return handle;
}

async function openExistingLocalFile() {
  if (!("showOpenFilePicker" in window)) {
    throw new Error("This browser does not expose the File System Access API in the extension popup.");
  }

  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: getPickerTypes(),
  });

  if (!handle) {
    throw new Error("No file was selected.");
  }

  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Write permission was not granted for the selected file.");
  }

  await saveFileHandle(handle);
  return handle;
}

async function ensureLocalFilePermission() {
  const handle = await loadFileHandle();
  if (!handle) {
    throw new Error("No local file selected. Use Open existing file or Create new file first.");
  }

  return ensureHandlePermission(handle);
}

async function ensureHandlePermission(handle) {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    permission = await handle.requestPermission({ mode: "readwrite" });
  }

  if (permission !== "granted") {
    throw new Error("Write permission was not granted for the selected local file.");
  }

  return handle;
}

async function restoreAccess() {
  const handle = await loadFileHandle();
  if (!handle) {
    throw new Error("No local file selected. Use Open existing file or Create new file first.");
  }

  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Access was not restored for the selected local file.");
  }

  return handle;
}

async function describeLocalFile() {
  const response = await chrome.runtime.sendMessage({ type: "probe-local-file" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unable to inspect local file selection.");
  }

  if (!response.result.selected) {
    return "No local file selected.";
  }

  const permissionLine = `Permission: ${response.result.permission}`;
  if (response.result.permission === "prompt") {
    return `Local file: ${response.result.fileName}\n${permissionLine}\nAccess lost. Click Restore access before syncing.`;
  }

  return `Local file: ${response.result.fileName}\n${permissionLine}`;
}

async function describeLastSync() {
  const { lastSyncStatus } = await chrome.storage.local.get("lastSyncStatus");
  if (!lastSyncStatus) {
    return "Last sync: none";
  }

  const base = `Last sync: ${lastSyncStatus.ok ? "ok" : "failed"} at ${formatTimestamp(lastSyncStatus.timestamp)}`;
  const stage = lastSyncStatus.stage ? `\nStage: ${lastSyncStatus.stage}` : "";
  const message = lastSyncStatus.message ? `\nMessage: ${lastSyncStatus.message}` : "";

  return `${base}${stage}${message}`;
}

async function pingHelper() {
  const localFileDescription = await describeLocalFile();
  const lastSyncDescription = await describeLastSync();
  const { permissionLostMessage } = await chrome.storage.local.get("permissionLostMessage");
  const permissionAlert = permissionLostMessage ? `\nAlert: ${permissionLostMessage}` : "";
  setStatus(`${localFileDescription}${permissionAlert}\n${lastSyncDescription}`);
}

async function syncActiveTab() {
  await ensureLocalFilePermission();

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id || !tab.url?.startsWith("https://excalidraw.com/")) {
    throw new Error("Open an excalidraw.com tab first.");
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "force-sync" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Sync failed.");
  }

  const extra = response.message ?? "Sync completed.";
  setStatus(`Sync result: ok\n${extra}`);
}

openFileButton.addEventListener("click", () => {
  openExistingLocalFile()
    .then((handle) => {
      setStatus(`Existing local file selected.\nFile: ${handle.name}`);
      return pingHelper().catch(() => {});
    })
    .catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
});

createFileButton.addEventListener("click", () => {
  createLocalFile()
    .then((handle) => {
      setStatus(`New local file selected.\nFile: ${handle.name}`);
      return pingHelper().catch(() => {});
    })
    .catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
});

restoreAccessButton.addEventListener("click", () => {
  restoreAccess()
    .then((handle) => {
      setStatus(`Access restored for ${handle.name}.`);
      return chrome.storage.local.remove(["permissionLost", "permissionLostMessage"]);
    })
    .then(() => {
      return pingHelper().catch(() => {});
    })
    .catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
});

saveButton.addEventListener("click", () => {
  saveConfig()
    .then((config) => {
      setStatus(
        `Saved.\nAutosync: ${config.autosyncEnabled ? "on" : "off"}\nInterval: ${config.syncIntervalMs} ms`,
      );
      return pingHelper().catch(() => {});
    })
    .catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
});

syncNowButton.addEventListener("click", () => {
  syncActiveTab().catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error));
  });
});

loadConfig()
  .then(() => pingHelper())
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error));
  });
