# Excalidraw Local File Sync

Chrome extension that mirrors the current `https://excalidraw.com` canvas into a local `.excalidraw` file using the File System Access API.

## What it does

- reads the active Excalidraw scene from browser storage on `excalidraw.com`
- reconstructs a standard `.excalidraw` JSON document
- writes that document to a local file you choose
- supports both opening an existing `.excalidraw` file and creating a new one

## Important limits

- This is an unsupported integration against Excalidraw browser storage, so it is inherently brittle.
- It targets the current local browser canvas state, not Excalidraw share links or server-side persistence.
- Embedded image files may not fully round-trip because Excalidraw stores more than plain scene JSON in browser storage.
- Automatic background sync can fail when Chrome drops file-write permission back to `prompt`. Re-granting permission requires a user action.
- If Excalidraw changes its storage keys or storage shape, the extraction heuristics may need adjustment.

## Requirements

- Chromium-based browser with extension support

## Install

1. Open your Chromium browser extension page.
2. Enable developer mode.
3. Choose `Load unpacked`.
4. Select `/home/luim/personal/excalidraw-local-file-sync/browser-extension`.
5. Open the extension popup.

## Usage

1. Open `https://excalidraw.com`.
2. In the extension popup, choose one of:
   - `Open existing file`
   - `Create new file`
3. Grant read/write permission for the selected file if Chrome prompts.
4. Click `Save` if you changed the sync interval or enabled state.
5. Click `Sync now` to force a sync, or let the polling loop sync automatically.

## Notes

- The extension stores the selected file handle in extension IndexedDB.
- If the active tab is not `https://excalidraw.com`, `Sync now` fails by design.
- Extension popups are ephemeral. If Chrome downgrades file access permission to `prompt`, automatic sync cannot silently re-authorize it.
