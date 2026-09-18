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
  return mediaUrl(
    `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=full`
  );
}

function githubRawSrc(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  return `https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/data/ea-photos/${encodeURIComponent(id)}.jpg`;
}

/**
 * Robot / hero avatar.
 * Prefer a durable photo URL in the <img> itself (same as Mentor Portal) so
 * Home never depends on IndexedDB/fetch races that left the default logo stuck.
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
    // Prefer durable URL on first paint (API / data) — do not start on /logo.png
    // or a failed hydrate can look like "still the default robot".
    return preferred || safeFallback;
  });

  useEffect(() => {
    let cancelled = false;

    const paint = (next) => {
      if (cancelled || !next) return;
      setSrc(next);
    };

    // Always prefer the durable URL first.
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

    // Warm blob cache in background (robot list / next open).
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
      onError={(event) => {
        const node = event.currentTarget;
        if (!node) return;
        const current = String(node.src || "");
        // Step through durable sources before giving up on the default robot.
        if (apiSrc && !current.includes("/api/licenses/photo") && !current.includes("raw.githubusercontent.com")) {
          setSrc(apiSrc);
          return;
        }
        const gh = githubRawSrc(id);
        if (gh && !current.includes("raw.githubusercontent.com")) {
          setSrc(gh);
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
