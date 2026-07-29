const DB_NAME = "excalidraw-local-git-sync";
const STORE_NAME = "handles";
const HANDLE_KEY = "target-file-handle";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
  });
}

function withStore(mode, callback) {
  return openDb().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }),
  );
}

export function saveFileHandle(handle) {
  return withStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
}

export function loadFileHandle() {
  return withStore("readonly", (store) => store.get(HANDLE_KEY));
}

export function clearFileHandle() {
  return withStore("readwrite", (store) => store.delete(HANDLE_KEY));
}
