import { mediaUrl, resolveBotPhotoSrc } from "./apiOrigin.js";

const DB_NAME = "apexea-bot-photos-v1";
const STORE = "photos";
const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/data/ea-photos";
const memoryUrls = new Map(); // botId -> object URL or data URL
const inflight = new Map();
let dbPromise = null;
let warmed = false;
let warmPromise = null;

function rawPhotoCandidates(botId) {
  const id = String(botId || "").trim();
  if (!id) return [];
  const enc = encodeURIComponent(id);
  return ["jpg", "jpeg", "png", "webp"].map(
    (ext) => `${GITHUB_RAW_BASE}/${enc}.${ext}`
  );
}

function openDb() {
  if (typeof indexedDB === "undefined") return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb open failed"));
    } catch (error) {
      reject(error);
    }
  }).catch(() => null);
  return dbPromise;
}

function revokeIfBlob(url) {
  if (url && String(url).startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

/** Sync hit for first paint (after warm). */
export function getCachedBotPhotoSync(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  return memoryUrls.get(id) || "";
}

async function idbGet(id) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(row) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function blobToObjectUrl(blob) {
  if (!blob) return "";
  try {
    return URL.createObjectURL(blob);
  } catch {
    return "";
  }
}

async function cacheBlob(id, blob, mime = "image/jpeg") {
  if (!id || !blob) return "";
  const url = blobToObjectUrl(blob);
  if (!url) return "";
  const prev = memoryUrls.get(id);
  if (prev && prev !== url) revokeIfBlob(prev);
  memoryUrls.set(id, url);
  await idbPut({
    id,
    mime: mime || blob.type || "image/jpeg",
    blob,
    updatedAt: Date.now(),
  });
  return url;
}

async function cacheDataUrl(id, dataUrl) {
  if (!id || !String(dataUrl || "").startsWith("data:image/")) return "";
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return cacheBlob(id, blob, blob.type || "image/jpeg");
  } catch {
    memoryUrls.set(id, dataUrl);
    return dataUrl;
  }
}

/** Hydrate memory map from IndexedDB so robot rows paint instantly next frame. */
export async function warmBotPhotoCache() {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    if (warmed) return;
    warmed = true;
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          for (const row of rows) {
            const id = String(row?.id || "").trim();
            if (!id || !row?.blob || memoryUrls.has(id)) continue;
            const url = blobToObjectUrl(row.blob);
            if (url) memoryUrls.set(id, url);
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  })();
  return warmPromise;
}

/**
 * Resolve a displayable photo URL ASAP:
 * 1) memory / IndexedDB cache
 * 2) local data URL / packaged asset on the bot
 * 3) network fetch (then cache) — only for real remote photos
 */
export async function resolveCachedBotPhoto(bot, fallback = "/logo.png") {
  const id = String(bot?.id || "").trim();
  const photo = String(bot?.photo || "").trim();
  const remote = resolveBotPhotoSrc(bot, fallback);
  const fb = fallback || "/logo.png";

  if (id) {
    const mem = memoryUrls.get(id);
    if (mem) return mem;
    const row = await idbGet(id);
    if (row?.blob) {
      const url = blobToObjectUrl(row.blob);
      if (url) {
        memoryUrls.set(id, url);
        return url;
      }
    }
  }

  if (photo.startsWith("data:image/")) {
    if (id) {
      cacheDataUrl(id, photo).catch(() => {});
    }
    return photo;
  }

  // Packaged logo / static asset — no network.
  if (
    !photo ||
    photo === "/logo.png" ||
    (remote === fb && !photo.startsWith("/api/") && !/^https?:\/\//i.test(photo))
  ) {
    return remote && remote !== fb ? remote : fb;
  }

  if (id && inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    // Race GitHub raw CDN + durable API path — first successful image blob wins.
    const candidates = [
      ...rawPhotoCandidates(id),
      remote && remote !== fb ? mediaUrl(remote) : "",
    ].filter(Boolean);

    const tryUrl = async (url) => {
      const response = await fetch(url, {
        method: "GET",
        cache: "force-cache",
        credentials: "omit",
      });
      if (!response.ok) {
        const err = new Error("photo miss");
        err.status = response.status;
        throw err;
      }
      const contentType = String(response.headers.get("content-type") || "");
      if (contentType && !contentType.startsWith("image/")) {
        const err = new Error("not an image");
        err.status = 404;
        throw err;
      }
      const blob = await response.blob();
      // Ignore empty / 1×1 placeholder / JSON-error bodies.
      if (!blob || blob.size < 256) {
        const err = new Error("empty photo");
        err.status = 404;
        throw err;
      }
      if (id) return (await cacheBlob(id, blob, blob.type)) || fb;
      return blobToObjectUrl(blob) || fb;
    };

    try {
      if (!candidates.length) return fb;
      return await Promise.any(candidates.map((url) => tryUrl(url)));
    } catch {
      return fb;
    } finally {
      if (id) inflight.delete(id);
    }
  })();

  if (id) inflight.set(id, task);
  return task;
}

/** Fire-and-forget warm for a list of bots (robot list / active bot). */
export function prefetchBotPhotos(bots = []) {
  const list = Array.isArray(bots) ? bots : [];
  for (const bot of list) {
    const id = String(bot?.id || "").trim();
    if (!id) continue;
    if (memoryUrls.has(id) || inflight.has(id)) continue;
    const photo = String(bot?.photo || "").trim();
    // Skip network for logo-only bots — Home must stay instant.
    if (!photo || photo === "/logo.png") continue;
    resolveCachedBotPhoto(bot, "/logo.png").catch(() => {});
  }
}

/** Drop IndexedDB + memory photo cache to free Safari / Android WebView quota. */
export function clearBotPhotoCache() {
  for (const url of memoryUrls.values()) revokeIfBlob(url);
  memoryUrls.clear();
  inflight.clear();
  warmed = false;
  warmPromise = null;
  if (typeof indexedDB === "undefined") return;
  try {
    indexedDB.deleteDatabase(DB_NAME);
  } catch {
    // ignore
  }
  dbPromise = null;
}
