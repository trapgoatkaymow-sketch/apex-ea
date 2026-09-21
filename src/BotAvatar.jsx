import { useEffect, useState } from "react";
import { eaPhotoCandidates, resolveBotPhotoSrc } from "./apiOrigin.js";
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
 * Robot / hero avatar. Paints a local asset first, then swaps to the real EA
 * photo only after it decodes — never a broken image icon.
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
    if (isLocalInstantSrc(remote) && remote !== safeFallback) return remote;
    return safeFallback;
  });

  useEffect(() => {
    let cancelled = false;
    let probe = null;

    const cached = getCachedBotPhotoSync(id);
    if (cached) setSrc(cached);

    const candidates = [];
    const push = (value) => {
      const next = String(value || "").trim();
      if (!next || candidates.includes(next) || /logo\.png(\?|$)/i.test(next)) return;
      candidates.push(next);
    };
    push(cached);
    for (const url of eaPhotoCandidates(bot)) push(url);
    push(remote);

    const tryAt = (index) => {
      if (cancelled) return;
      if (index >= candidates.length) {
        setSrc(safeFallback);
        return;
      }
      const url = candidates[index];
      if (url.startsWith("data:image/") || url.startsWith("blob:") || isLocalInstantSrc(url)) {
        setSrc(url);
        return;
      }
      probe = new Image();
      probe.decoding = "async";
      probe.onload = () => {
        if (!cancelled) setSrc(url);
      };
      probe.onerror = () => tryAt(index + 1);
      probe.src = url;
    };

    tryAt(0);

    warmBotPhotoCache()
      .then(() => {
        if (cancelled) return;
        const hit = getCachedBotPhotoSync(id);
        if (hit) setSrc(hit);
      })
      .catch(() => {});

    if (id) {
      resolveCachedBotPhoto(bot, safeFallback)
        .then((url) => {
          if (cancelled || !url) return;
          if (url === safeFallback || /logo\.png(\?|$)/i.test(url)) return;
          setSrc(url);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      if (probe) {
        probe.onload = null;
        probe.onerror = null;
      }
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
        if (!node || node.dataset.fallbackApplied === "1") return;
        node.dataset.fallbackApplied = "1";
        setSrc(safeFallback);
        node.src = safeFallback;
      }}
    />
  );
}
