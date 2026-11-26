// The tab: Archnemesis's mark, tinted with the open design's colour, and the design's name as the
// title, so a row of Archnemesis tabs says which is which.
import { colorFor } from "./presence";

/** Archnemesis's mark (three boxes, connected) in one colour, as an SVG. */
function markSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#11141b"/>
<path d="M10 10 L22 10 M10 10 L16 22 M22 10 L16 22" stroke="${color}" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>
<rect x="5" y="6" width="10" height="8" rx="2" fill="${color}"/>
<rect x="17" y="6" width="10" height="8" rx="2" fill="${color}"/>
<rect x="11" y="18" width="10" height="8" rx="2" fill="${color}"/>
</svg>`;
}

/** Show `design` (and its fork) in the tab. */
export function showInTab(designKey: string, name: string, branch: string | null): void {
  document.title = `${name}${branch ? ` @${branch}` : ""} · Archnemesis`;
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(markSvg(colorFor(designKey)))}`;
}
