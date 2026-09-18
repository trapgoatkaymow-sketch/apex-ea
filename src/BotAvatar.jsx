import { useEffect, useState } from "react";
import { mediaUrl, resolveBotPhotoSrc } from "./apiOrigin.js";

function botPhotoApiSrc(botId) {
  const id = String(botId || "").trim();
  if (!id) return "";
  return mediaUrl(
    `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=hq`
  );
}

/**
 * Robot / hero avatar — one stable mentor photo on Interface 1 and Interface 2.
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

  const preferred = (() => {
    if (photo.startsWith("data:image/") || photo.startsWith("blob:")) return photo;
    if (photo.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(photo)) {
      return mediaUrl(photo);
    }
    if (apiSrc) return apiSrc;
    const resolved = resolveBotPhotoSrc(bot, safeFallback);
    if (resolved && resolved !== safeFallback) return resolved;
    return apiSrc || safeFallback;
  })();

  const [src, setSrc] = useState(preferred || safeFallback);

  useEffect(() => {
    setSrc(preferred || safeFallback);
  }, [id, preferred, safeFallback]);

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
        if (apiSrc && src !== apiSrc) {
          setSrc(apiSrc);
          return;
        }
        if (src !== safeFallback) setSrc(safeFallback);
      }}
    />
  );
}
