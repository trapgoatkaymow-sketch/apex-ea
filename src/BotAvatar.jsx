import { useEffect, useRef, useState } from "react";
import { mediaUrl, resolveBotPhotoSrc } from "./apiOrigin.js";

function botPhotoApiSrc(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  return mediaUrl(
    `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=hq`
  );
}

function isPackagedHeroFallback(fallback) {
  const value = String(fallback || "").trim();
  if (!value || value === "/logo.png") return false;
  if (
    value.startsWith("/api/") ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    /^https?:\/\//i.test(value)
  ) {
    return false;
  }
  return value.startsWith("/");
}

function probeImageSize(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve({ ok: false, w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.decoding = "async";
    img.onload = () =>
      resolve({
        ok: true,
        w: Number(img.naturalWidth || 0),
        h: Number(img.naturalHeight || 0),
      });
    img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
    img.src = url;
  });
}

/**
 * Robot / hero avatar — one stable <img> src (no flicker).
 * Interface 2 passes a packaged hero fallback: show that first, then upgrade
 * only when the mentor photo is actually sharp enough for full-bleed.
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
  const heroFallback = isPackagedHeroFallback(safeFallback) ? safeFallback : "";

  const remotePhoto = (() => {
    if (photo.startsWith("data:image/") || photo.startsWith("blob:")) return photo;
    if (photo.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(photo)) {
      return mediaUrl(photo);
    }
    if (apiSrc) return apiSrc;
    const resolved = resolveBotPhotoSrc(bot, safeFallback);
    if (resolved && resolved !== safeFallback) return resolved;
    return "";
  })();

  // Full-bleed Interface 2: start on sharp packaged hero to avoid thumb flicker.
  // Interface 1 / list rows: start on remote or logo.
  const initialSrc = heroFallback || remotePhoto || safeFallback;
  const [src, setSrc] = useState(initialSrc);
  const lockedHeroRef = useRef(false);
  const settledIdRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    lockedHeroRef.current = false;

    // Bot changed — reset lock.
    if (settledIdRef.current !== id) {
      settledIdRef.current = id;
    }

    if (photo.startsWith("data:image/") || photo.startsWith("blob:")) {
      setSrc(photo);
      return () => {
        cancelled = true;
      };
    }

    if (heroFallback) {
      // Stable base: sharp packaged art. Only upgrade if remote is truly HQ.
      setSrc(heroFallback);
      lockedHeroRef.current = true;

      const candidate = remotePhoto || apiSrc;
      if (!candidate || candidate === heroFallback) {
        return () => {
          cancelled = true;
        };
      }

      void probeImageSize(candidate).then(({ ok, w, h }) => {
        if (cancelled) return;
        const minEdge = Math.min(w, h);
        // Only swap away from the sharp hero when the mentor photo is crisp.
        if (ok && minEdge >= 640) {
          lockedHeroRef.current = false;
          setSrc(candidate);
        }
      });

      return () => {
        cancelled = true;
      };
    }

    // No packaged hero (Interface 1 / list): use remote API, logo on failure.
    const candidate = remotePhoto || apiSrc || safeFallback;
    setSrc(candidate);
    if (candidate && candidate !== safeFallback && !candidate.startsWith("data:")) {
      void probeImageSize(candidate).then(({ ok }) => {
        if (cancelled) return;
        if (!ok) setSrc(safeFallback);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [id, photo, remotePhoto, apiSrc, heroFallback, safeFallback]);

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
      onError={() => {
        if (lockedHeroRef.current && heroFallback) {
          setSrc(heroFallback);
          return;
        }
        if (heroFallback && src !== heroFallback) {
          lockedHeroRef.current = true;
          setSrc(heroFallback);
          return;
        }
        if (src !== safeFallback) setSrc(safeFallback);
      }}
    />
  );
}
