import { describe, expect, it } from "vitest";
import { renderPortableText, type PortableTextBlock } from "../../src/server/modules/portable-text";

describe("EmDash Portable Text rendering", () => {
  it("preserves ordered, unordered and nested list structure", () => {
    const blocks: PortableTextBlock[] = [
      { _type: "block", style: "normal", children: [{ text: "Before" }] },
      { _type: "block", listItem: "bullet", level: 1, children: [{ text: "One" }] },
      { _type: "block", listItem: "bullet", level: 2, children: [{ text: "One A" }] },
      { _type: "block", listItem: "number", level: 2, children: [{ text: "One B" }] },
      { _type: "block", listItem: "bullet", level: 1, children: [{ text: "Two" }] },
      { _type: "block", listItem: "number", level: 1, listStart: 3, children: [{ text: "Three" }] },
    ];
    const html = renderPortableText(blocks);
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("<ul><li>One<ul><li>One A</li></ul><ol><li>One B</li></ol></li><li>Two</li></ul>");
    expect(html).toContain('<ol start="3"><li>Three</li></ol>');
    expect((html.match(/<ul>/g) ?? []).length).toBe(2);
    expect((html.match(/<\/ol>/g) ?? []).length).toBe(2);
  });

  it("renders marks, safe links and escapes hostile text", () => {
    const blocks: PortableTextBlock[] = [
      {
        _type: "block",
        style: "h2",
        children: [
          { _type: "span", text: "<script>alert(1)</script>" },
          { _type: "span", text: " bold", marks: ["strong"] },
          { _type: "span", text: " link", marks: ["link-1"] },
          { _type: "span", text: " hostile", marks: ["link-2"] },
        ],
        markDefs: [
          { _key: "link-1", _type: "link", href: "https://example.com/story" },
          { _key: "link-2", _type: "link", href: "javascript:alert(1)" },
        ],
      },
    ];
    const html = renderPortableText(blocks);
    expect(html).toContain("<h2>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<strong> bold</strong>");
    expect(html).toContain('<a href="https://example.com/story" rel="noreferrer noopener"> link</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
  });

  it("renders a real image, gallery, code, table and video", () => {
    const blocks: PortableTextBlock[] = [
      { _type: "image", asset: { url: "/media/editorial/one.webp" }, alt: "A cabinet", caption: "The first cabinet" },
      { _type: "gallery", columns: 3, images: [{ asset: { url: "https://example.com/a.webp" }, alt: "A" }, { asset: { url: "/b.webp" }, alt: "B" }] },
      { _type: "code", language: "ts", filename: "example.ts", code: "const value = 1 < 2;" },
      {
        _type: "table",
        hasHeaderRow: true,
        rows: [
          { cells: [{ content: [{ text: "Name" }], isHeader: true }, { content: [{ text: "Value" }], isHeader: true }] },
          { cells: [{ content: [{ text: "Alpha" }] }, { content: [{ text: "One" }] }] },
        ],
      },
      { _type: "video", asset: { url: "https://example.com/clip.mp4" }, caption: "Opening" },
    ];
    const html = renderPortableText(blocks);
    expect(html).toContain('<img src="/media/editorial/one.webp" alt="A cabinet"');
    expect(html).toContain("<figcaption>The first cabinet</figcaption>");
    expect(html).toContain('style="--gallery-columns:3"');
    expect(html).toContain('<code class="language-ts">const value = 1 &lt; 2;</code>');
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>Alpha</td>");
    expect(html).toContain('<video controls preload="none" src="https://example.com/clip.mp4"');
  });

  it("is explicit about unsupported or unsafe blocks instead of silently dropping them", () => {
    const blocks: PortableTextBlock[] = [
      { _type: "htmlBlock", html: "<script>alert(1)</script>" },
      { _type: "iframe", src: "https://example.com" },
      { _type: "custom-embed", headline: "Hello" },
      { _type: "image", asset: {} },
    ];
    const html = renderPortableText(blocks);
    expect(html).toContain("Raw HTML block");
    expect(html).toContain("Embedded page");
    expect(html).toContain("custom-embed");
    expect(html).toContain("Editorial image unavailable");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<iframe");
  });
});
