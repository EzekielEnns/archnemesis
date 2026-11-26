// A technology's logo as an <img>, from whatever the backend serves logos with: a URL for
// the server, SVG text (turned into a data URI) for the static build. Where there's no logo
// it renders nothing (or keeps its space, so a list stays lined up) and says so.
import { useEffect, useRef, useState } from "react";
import { backend } from "../backend";

type Found = { tech: string; src: string | null };

const dataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The logo's source: undefined while it loads, null when there is none. */
function useLogo(tech: string): string | null | undefined {
  const url = backend.icons.url?.(tech);
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (url) return;
    let gone = false;
    backend.icons
      .svg(tech, "brand")
      .catch(() => null)
      .then((svg) => !gone && setFound({ tech, src: svg ? dataUri(svg) : null }));
    return () => {
      gone = true;
    };
  }, [tech, url]);
  if (url) return url;
  return found?.tech === tech ? found.src : undefined;
}

export function TechImg(p: {
  tech: string;
  width?: number;
  height?: number;
  className?: string;
  /** Called when there's no logo for it (the server's 404, or no match locally). */
  onMissing?: () => void;
  /** With no logo: nothing at all (default), or an empty box of the same size. */
  missing?: "hide" | "keep";
}) {
  const src = useLogo(p.tech);
  const latest = useRef(p.onMissing);
  useEffect(() => {
    latest.current = p.onMissing;
  });
  useEffect(() => {
    if (src === null) latest.current?.();
  }, [src]);
  if (src === null && p.missing === "keep")
    return (
      <span style={{ display: "inline-block", width: p.width, height: p.height, flex: "none" }} />
    );
  if (!src) return null;
  return (
    <img
      className={p.className}
      src={src}
      alt=""
      width={p.width}
      height={p.height}
      onError={() => latest.current?.()}
    />
  );
}
