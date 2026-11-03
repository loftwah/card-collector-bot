/**
 * Deliberate Portable Text renderer for the EmDash journal.
 *
 * EmDash owns the content; this module is the site's supported rendering
 * contract. It preserves the structures the editor actually produces (marks,
 * links, nested ordered/unordered lists, images, galleries, code, tables,
 * videos) and shows an explicit, visible fallback for anything it deliberately
 * refuses to execute. Raw HTML and iframes are never injected.
 */

export interface PortableTextSpan {
  _type?: string;
  _key?: string;
  text?: string;
  marks?: string[];
}

export interface PortableTextBlock {
  _type?: string;
  _key?: string;
  style?: string;
  listItem?: "bullet" | "number";
  level?: number;
  listStart?: number;
  children?: PortableTextSpan[];
  markDefs?: Array<{ _key: string; _type: string; href?: string }>;
  alt?: string;
  caption?: string;
  title?: string;
  url?: string;
  src?: string;
  code?: string;
  language?: string;
  filename?: string;
  asset?: { _ref?: string; url?: string; provider?: string };
  images?: Array<{ asset?: { url?: string }; alt?: string; caption?: string }>;
  columns?: number;
  rows?: Array<{ cells?: Array<{ content?: PortableTextSpan[]; isHeader?: boolean; colspan?: number; rowspan?: number }> }>;
  hasHeaderRow?: boolean;
  html?: string;
  [key: string]: unknown;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  const href = value.trim();
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  if (/^tel:/i.test(href)) return href;
  return null;
}

function safeMediaUrl(value: string | undefined): string | null {
  return safeHref(value);
}

function renderInline(block: PortableTextBlock): string {
  const defs = new Map((block.markDefs ?? []).map((definition) => [definition._key, definition]));
  return (block.children ?? [])
    .filter((child) => child._type === "span" || !child._type)
    .map((child) => {
      let html = escapeHtml(child.text ?? "");
      for (const mark of child.marks ?? []) {
        switch (mark) {
          case "strong":
            html = `<strong>${html}</strong>`;
            break;
          case "em":
            html = `<em>${html}</em>`;
            break;
          case "code":
            html = `<code>${html}</code>`;
            break;
          case "underline":
            html = `<u>${html}</u>`;
            break;
          case "strike-through":
            html = `<s>${html}</s>`;
            break;
          default: {
            const definition = defs.get(mark);
            const href = safeHref(definition?.href);
            if (href) {
              const external = /^https?:\/\//i.test(href);
              html = `<a href="${escapeHtml(href)}"${external ? ' rel="noreferrer noopener"' : ""}>${html}</a>`;
            }
          }
        }
      }
      return html;
    })
    .join("");
}

function listTag(ordered: boolean): string {
  return ordered ? "ol" : "ul";
}

function parseList(
  blocks: PortableTextBlock[],
  start: number,
  ordered: boolean,
  level: number,
): { html: string; next: number } {
  const tag = listTag(ordered);
  const startNumber = ordered ? Number(blocks[start]?.listStart ?? 1) : 1;
  const items: string[] = [];
  let index = start;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (!block.listItem) break;
    const blockLevel = Math.max(1, Number(block.level ?? 1));
    if (blockLevel < level) break;
    if (blockLevel > level) {
      const nested = parseList(blocks, index, block.listItem === "number", level + 1);
      if (items.length) items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `${nested.html}</li>`);
      index = nested.next;
      continue;
    }
    if (block.listItem !== (ordered ? "number" : "bullet")) break;
    items.push(`<li>${renderInline(block)}</li>`);
    index += 1;
  }
  const startAttribute = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
  return { html: `<${tag}${startAttribute}>${items.join("")}</${tag}>`, next: index };
}

function renderImage(block: PortableTextBlock): string {
  const src = safeMediaUrl(block.asset?.url ?? block.url);
  if (!src) {
    return `<div class="editorial-unavailable" role="note">Editorial image unavailable — the media reference did not resolve. Nothing was invented in its place.</div>`;
  }
  const alt = escapeHtml(block.alt ?? block.title ?? "Editorial image");
  const caption = block.caption ? `<figcaption>${escapeHtml(String(block.caption))}</figcaption>` : "";
  const width = Number(block.displayWidth ?? block.width ?? 0) || undefined;
  const height = Number(block.displayHeight ?? block.height ?? 0) || undefined;
  return `<figure><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async"${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}>${caption}</figure>`;
}

function renderBlock(block: PortableTextBlock): string {
  switch (block._type) {
    case "image":
      return renderImage(block);
    case "gallery": {
      const images = (block.images ?? [])
        .map((image) => {
          const src = safeMediaUrl(image.asset?.url);
          if (!src) return "";
          return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt ?? "Editorial image")}" loading="lazy" decoding="async">${image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : ""}</figure>`;
        })
        .filter(Boolean)
        .join("");
      return images ? `<div class="editorial-gallery" style="--gallery-columns:${Math.min(4, Math.max(1, Number(block.columns ?? 2)))}">${images}</div>` : `<div class="editorial-unavailable" role="note">Editorial gallery unavailable.</div>`;
    }
    case "code":
      return `<figure class="editorial-code">${block.filename ? `<figcaption>${escapeHtml(block.filename)}</figcaption>` : ""}<pre><code${block.language ? ` class="language-${escapeHtml(block.language)}"` : ""}>${escapeHtml(block.code ?? "")}</code></pre></figure>`;
    case "table": {
      const rows = (block.rows ?? [])
        .map((row, rowIndex) => {
          const cells = (row.cells ?? [])
            .map((cell) => {
              const tag = cell.isHeader || (block.hasHeaderRow && rowIndex === 0) ? "th" : "td";
              const content = renderInline({ children: cell.content ?? [] });
              const colspan = cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
              const rowspan = cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
              return `<${tag}${colspan}${rowspan}>${content}</${tag}>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<div class="editorial-table-wrap"><table>${rows}</table></div>`;
    }
    case "video": {
      const src = safeMediaUrl(block.asset?.url ?? block.url);
      if (!src) return `<div class="editorial-unavailable" role="note">Editorial video unavailable.</div>`;
      return `<figure><video controls preload="none" src="${escapeHtml(src)}"${block.caption ? ` aria-label="${escapeHtml(block.caption)}"` : ""}></video>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
    }
    case "block": {
      const children = renderInline(block);
      const align = block.textAlign ? ` style="text-align:${escapeHtml(String(block.textAlign))}"` : "";
      switch (block.style) {
        case "h1":
          return `<h1${align}>${children}</h1>`;
        case "h2":
          return `<h2${align}>${children}</h2>`;
        case "h3":
          return `<h3${align}>${children}</h3>`;
        case "h4":
          return `<h4${align}>${children}</h4>`;
        case "h5":
          return `<h5${align}>${children}</h5>`;
        case "h6":
          return `<h6${align}>${children}</h6>`;
        case "blockquote":
          return `<blockquote${align}>${children}</blockquote>`;
        default:
          return `<p${align}>${children}</p>`;
      }
    }
    case "htmlBlock":
    case "iframe":
      return `<div class="editorial-unavailable" role="note"><strong>${escapeHtml(block._type === "htmlBlock" ? "Raw HTML block" : "Embedded page")} not rendered.</strong> Foilbury shows supported native editorial blocks only; executable HTML and third-party frames are intentionally excluded. The authored block remains stored in EmDash.</div>`;
    default:
      return `<div class="editorial-unavailable" role="note">Unsupported editorial block <code>${escapeHtml(String(block._type ?? "unknown"))}</code> was not rendered. The authored content remains stored in EmDash.</div>`;
  }
}

export function renderPortableText(blocks: PortableTextBlock[] | null | undefined): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const out: string[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (block.listItem) {
      const parsed = parseList(blocks, index, block.listItem === "number", Math.max(1, Number(block.level ?? 1)));
      out.push(parsed.html);
      index = parsed.next;
      continue;
    }
    out.push(renderBlock(block));
    index += 1;
  }
  return out.join("\n");
}
