import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Tags kept from provider HTML (Azure DevOps descriptions and rich-text
 * fields). Structure and inline emphasis only: no scripts, styles, frames,
 * forms or media. Anything else is unwrapped so its text survives.
 */
const ALLOWED_TAGS = new Set([
  "p",
  "div",
  "span",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "ins",
  "sub",
  "sup",
  "mark",
  "small",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "hr",
]);

/** Elements whose content must go too, not just the tag. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
  "textarea",
  "select",
  "button",
  "input",
  "form",
  "video",
  "audio",
  "canvas",
  "link",
  "meta",
  "base",
]);

/** Attributes kept per tag; everything else, including `style`, is dropped. */
const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  ol: ["start"],
};
const NUMERIC_ATTRS = new Set(["colspan", "rowspan", "start"]);

const SAFE_HREF = /^(https?:|mailto:)/i;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Last path segment of an attachment URL, without its query. */
function attachmentName(src: string, alt: string): string {
  if (alt.trim()) return alt.trim();
  try {
    const url = new URL(src);
    const fileName = url.searchParams.get("fileName");
    if (fileName) return fileName;
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "image";
  } catch {
    return "image";
  }
}

/**
 * Rebuilds `from`'s children under `to` with fresh elements, keeping only
 * allowlisted tags and attributes. The source tree comes from an inert
 * `DOMParser` document, so nothing in it ever ran.
 */
function copyChildren(from: Node, to: Node) {
  for (const child of [...from.childNodes]) {
    if (child.nodeType === TEXT_NODE) {
      to.appendChild(document.createTextNode(child.nodeValue ?? ""));
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.localName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      copyChildren(element, to);
      continue;
    }
    const next = document.createElement(tag);
    for (const name of ALLOWED_ATTRS[tag] ?? []) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      if (NUMERIC_ATTRS.has(name) && !/^\d{1,4}$/.test(value.trim())) continue;
      next.setAttribute(name, value);
    }
    copyChildren(element, next);
    to.appendChild(next);
  }
}

/**
 * Provider HTML reduced to safe markup. Links keep only http(s) and mailto
 * targets and open through the system browser (see `SafeHtml`). Images
 * become links to the image: Azure attachments need the PAT, so an `<img>`
 * would only ever show as broken.
 */
export function sanitizeProviderHtml(html: string): string {
  if (!html.trim()) return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const holder = document.createElement("div");
  copyChildren(parsed.body, holder);
  for (const image of [...holder.querySelectorAll("img")]) {
    const src = image.getAttribute("src") ?? "";
    const name = attachmentName(src, image.getAttribute("alt") ?? "");
    const replacement = SAFE_HREF.test(src)
      ? document.createElement("a")
      : document.createElement("span");
    if (SAFE_HREF.test(src)) replacement.setAttribute("href", src);
    replacement.setAttribute("data-attachment", "");
    replacement.textContent = `Image: ${name}`;
    image.replaceWith(replacement);
  }
  for (const anchor of [...holder.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!SAFE_HREF.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("href", href);
    anchor.setAttribute("rel", "noopener noreferrer");
    if (!anchor.getAttribute("title")) anchor.setAttribute("title", href);
  }
  return holder.innerHTML;
}

/**
 * Renders provider HTML after `sanitizeProviderHtml`. Clicks on links open
 * in the system browser instead of navigating the window.
 */
export function SafeHtml({
  html,
  className,
  emptyLabel,
}: {
  html: string;
  className?: string;
  /** Shown when nothing is left after sanitizing. */
  emptyLabel?: string;
}) {
  const clean = useMemo(() => sanitizeProviderHtml(html), [html]);
  if (!clean.trim()) {
    return emptyLabel ? (
      <p className="text-[13px] text-content/45">{emptyLabel}</p>
    ) : null;
  }
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (href) void openUrl(href).catch(() => {});
  };
  return (
    <div
      className={`safe-html ${className ?? ""}`}
      onClick={onClick}
      // Rebuilt from an allowlist above; nothing else reaches here.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
