import { loadFileHandle } from "./file-handle-store.js";

const DEFAULT_CONFIG = {
  syncIntervalMs: 2000,
  autosyncEnabled: false,
};

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...stored,
  };
}

async function setPermissionLostUi(message) {
  await chrome.storage.local.set({
    permissionLost: true,
    permissionLostMessage: message,
  });
}

async function clearPermissionLostUi() {
  await chrome.storage.local.remove(["permissionLost", "permissionLostMessage"]);
}

async function ensureWritableHandle() {
  const handle = await loadFileHandle();
  if (!handle) {
    throw new Error("No target file selected. Use the extension popup to choose a local file.");
  }

  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    await setPermissionLostUi("Access to the selected file was lost. Open the extension and click Restore access.");
    throw new Error("Local file permission is no longer granted. Re-select the file from the extension popup.");
  }

  await clearPermissionLostUi();
  return handle;
}

async function writeSceneToFile(handle, scene) {
  const writable = await handle.createWritable();
  await writable.write(`${JSON.stringify(scene, null, 2)}\n`);
  await writable.close();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "sync-scene") {
      if (message.mode === "autosync") {
        const config = await getConfig();
        if (!config.autosyncEnabled) {
          sendResponse({
            ok: false,
            skipped: true,
            error: "Autosync is disabled in extension settings.",
          });
          return;
        }
      }

      const handle = await ensureWritableHandle();
      await writeSceneToFile(handle, message.scene);

      sendResponse({
        ok: true,
        result: {
          fileName: handle.name,
        },
      });
      return;
    }

    if (message?.type === "probe-local-file") {
      const handle = await loadFileHandle();
      if (!handle) {
        sendResponse({
          ok: true,
          result: {
            selected: false,
          },
        });
        return;
      }

      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        await setPermissionLostUi("Access to the selected file was lost. Open the extension and click Restore access.");
      } else {
        await clearPermissionLostUi();
      }
      sendResponse({
        ok: true,
        result: {
          selected: true,
          fileName: handle.name,
          permission,
        },
      });
      return;
    }

    sendResponse({
      ok: false,
      error: "Unknown message type.",
    });
  })().catch((error) => {
    if (
      error instanceof Error &&
      error.message.includes("Local file permission is no longer granted")
    ) {
      void setPermissionLostUi("Access to the selected file was lost. Open the extension and click Restore access.");
    }
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return true;
});
