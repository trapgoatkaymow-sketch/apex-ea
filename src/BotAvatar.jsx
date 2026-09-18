import { useEffect, useState } from "react";
import { resolveBotPhotoSrc } from "./apiOrigin.js";
import {
  getCachedBotPhotoSync,
  resolveCachedBotPhoto,
  warmBotPhotoCache,
} from "./botPhotoCache.js";

function isLocalInstantSrc(src) {
  const value = String(src || "").trim();
  return (
    value.startsWith("data:image/") ||
    value.startsWith("blob:") ||
    (value.startsWith("/") && !value.startsWith("/api/"))
  );
}

/**
 * Robot / hero avatar that paints a local asset on first frame, then upgrades
 * to a cached/remote photo only after it successfully decodes — never a broken ?.
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
  const remote = resolveBotPhotoSrc(bot, fallback);
  const safeFallback = fallback || "/logo.png";

  const [src, setSrc] = useState(() => {
    const cached = getCachedBotPhotoSync(id);
    if (cached) return cached;
    const photo = String(bot?.photo || "").trim();
    if (photo.startsWith("data:image/") || photo.startsWith("blob:")) return photo;
    // Local packaged assets paint with the rest of the UI (same frame).
    if (isLocalInstantSrc(remote)) return remote || safeFallback;
    // Remote API / CDN: show fallback instantly, swap after decode.
    return safeFallback;
  });

  useEffect(() => {
    let cancelled = false;

    const paintInstant = () => {
      const cached = getCachedBotPhotoSync(id);
      if (cached) {
        setSrc(cached);
        return cached;
      }
      const photo = String(bot?.photo || "").trim();
      if (photo.startsWith("data:image/") || photo.startsWith("blob:")) {
        setSrc(photo);
        return photo;
      }
      if (isLocalInstantSrc(remote)) {
        setSrc(remote || safeFallback);
        return remote || safeFallback;
      }
      setSrc(safeFallback);
      return safeFallback;
    };

    paintInstant();

    warmBotPhotoCache()
      .then(() => {
        if (cancelled) return;
        const cached = getCachedBotPhotoSync(id);
        if (cached) setSrc(cached);
      })
      .catch(() => {});

    // Hit the network whenever we have a botId — even /logo.png may have a
    // mentor-uploaded picture on the photo API / GitHub CDN.
    const photoStr = String(bot?.photo || "").trim();
    const needsNetwork =
      Boolean(id) &&
      (photoStr.startsWith("/api/licenses/photo") ||
        /^https?:\/\//i.test(photoStr) ||
        !photoStr ||
        photoStr === "/logo.png" ||
        (remote && !isLocalInstantSrc(remote) && remote !== safeFallback));

    if (!needsNetwork) {
      return () => {
        cancelled = true;
      };
    }

    resolveCachedBotPhoto(bot, safeFallback)
      .then((url) => {
        if (cancelled || !url) return;
        // Keep showing logo if hydrate found nothing better.
        if (url === safeFallback || url === "/logo.png") return;
        // Avoid swapping to a remote that will flash a broken icon.
        if (isLocalInstantSrc(url) || String(url).startsWith("blob:")) {
          setSrc(url);
          return;
        }
        const probe = new Image();
        probe.decoding = "async";
        probe.onload = () => {
          if (!cancelled) setSrc(url);
        };
        probe.onerror = () => {
          // Stay on whatever we already painted (logo or prior good src).
        };
        probe.src = url;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [id, bot?.photo, remote, safeFallback]);

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
        if (node.dataset.fallbackApplied === "1") return;
        node.dataset.fallbackApplied = "1";
        setSrc(safeFallback);
        node.src = safeFallback;
      }}
    />
  );
}
