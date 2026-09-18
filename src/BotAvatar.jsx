import { useEffect, useState } from "react";
import { mediaUrl, resolveBotPhotoSrc } from "./apiOrigin.js";
import {
  getCachedBotPhotoSync,
  resolveCachedBotPhoto,
  warmBotPhotoCache,
} from "./botPhotoCache.js";

function botPhotoApiSrc(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  // Cache-bust so a newly uploaded sharp photo replaces a soft thumb.
  return mediaUrl(
    `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=hq`
  );
}

function githubRawSrc(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  return `https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/store-licenses/data/ea-photos/${encodeURIComponent(id)}.jpg`;
}

function isPackagedHeroFallback(fallback) {
  const value = String(fallback || "").trim();
  if (!value || value === "/logo.png") return false;
  if (value.startsWith("/api/") || value.startsWith("data:") || value.startsWith("blob:")) {
    return false;
  }
  return value.startsWith("/");
}

/**
 * Robot / hero avatar.
 * Prefer a durable photo URL in the <img> itself (same as Mentor Portal) so
 * Home never depends on IndexedDB/fetch races that left the default logo stuck.
 * If the synced photo is a tiny thumb, fall back to a packaged sharp hero when
 * one was provided (Interface 2).
 */
export default function BotAvatar({
  bot,
  className = "",
  alt = "",
  width,
  height,
  fallback = "/logo.png",
  fetchPriority,
  decoding = "async",
}) {
  const id = String(bot?.id || "").trim();
  const photo = String(bot?.photo || "").trim();
  const safeFallback = fallback || "/logo.png";
  const apiSrc = botPhotoApiSrc(id);
  const remote = resolveBotPhotoSrc(bot, safeFallback);
  const heroFallback = isPackagedHeroFallback(safeFallback) ? safeFallback : "";

  // Direct URL the browser can load — API path when mentor uploaded by botId.
  const preferred = (() => {
    if (photo.startsWith("data:image/") || photo.startsWith("blob:")) return photo;
    if (photo.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(photo)) {
      return mediaUrl(photo);
    }
    // Logo / empty / packaged placeholder — still try durable photo by botId.
    if (apiSrc) return apiSrc;
    if (remote && remote !== safeFallback) return remote;
    return safeFallback;
  })();

  const [src, setSrc] = useState(() => {
    const cached = getCachedBotPhotoSync(id);
    if (cached) return cached;
    return preferred || safeFallback;
  });

  useEffect(() => {
    let cancelled = false;

    const paint = (next) => {
      if (cancelled || !next) return;
      setSrc(next);
    };

    paint(preferred || safeFallback);

    const cached = getCachedBotPhotoSync(id);
    if (cached) paint(cached);

    warmBotPhotoCache()
      .then(() => {
        if (cancelled) return;
        const warmed = getCachedBotPhotoSync(id);
        if (warmed) paint(warmed);
      })
      .catch(() => {});

    if (id) {
      resolveCachedBotPhoto(bot, safeFallback)
        .then((url) => {
          if (cancelled || !url) return;
          if (url === safeFallback || url === "/logo.png") return;
          if (String(url).startsWith("blob:") || url.startsWith("data:image/")) {
            paint(url);
          }
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [id, photo, preferred, safeFallback, bot]);

  return (
    <img
      className={className}
      src={src || safeFallback}
      alt={alt}
      width={width}
      height={height}
      decoding={decoding}
      loading={fetchPriority === "high" ? "eager" : "lazy"}
      fetchPriority={fetchPriority}
      onLoad={(event) => {
        const node = event.currentTarget;
        if (!node || !heroFallback) return;
        const w = Number(node.naturalWidth || 0);
        const h = Number(node.naturalHeight || 0);
        const minEdge = Math.min(w, h);
        // Tiny synced thumbs look mushy on full-bleed Interface 2 — use sharp packaged hero.
        if (minEdge > 0 && minEdge < 480) {
          const current = String(node.getAttribute("src") || src || "");
          if (current.includes(heroFallback)) return;
          setSrc(heroFallback);
        }
      }}
      onError={(event) => {
        const node = event.currentTarget;
        if (!node) return;
        const current = String(node.src || "");
        if (apiSrc && !current.includes("/api/licenses/photo") && !current.includes("raw.githubusercontent.com")) {
          setSrc(apiSrc);
          return;
        }
        const gh = githubRawSrc(id);
        if (gh && !current.includes("raw.githubusercontent.com")) {
          setSrc(gh);
          return;
        }
        if (heroFallback && !current.includes(heroFallback)) {
          setSrc(heroFallback);
          return;
        }
        if (node.dataset.fallbackApplied === "1") return;
        node.dataset.fallbackApplied = "1";
        setSrc(safeFallback);
        node.src = safeFallback;
      }}
    />
  );
}
