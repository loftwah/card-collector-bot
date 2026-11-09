function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function publicBackHtml({ card, collection, logo, manrope, fraunces }) {
  const attrs = (() => {
    try {
      return JSON.parse(card.attributes_json ?? "[]");
    } catch {
      return [];
    }
  })();
  const attrMarkup =
    attrs
      .slice(0, 4)
      .map(
        (attribute) =>
          `<div><dt>${esc(attribute.label)}</dt><dd>${esc(attribute.value)}${attribute.unit ? ` ${esc(attribute.unit)}` : ""}</dd></div>`,
      )
      .join("") ||
    `<div><dt>Collection</dt><dd>${esc(collection?.name ?? "Foilbury")}</dd></div><div><dt>Category</dt><dd>${esc(card.category?.name ?? "Cabinet card")}</dd></div><div><dt>Rarity</dt><dd>${esc(card.rarity?.name ?? "Unclassified")}</dd></div><div><dt>Source</dt><dd>${esc(String(card.source_work ?? "").trim() || "Source not specified")}</dd></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
    @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:#07110f;color:#eff5f1;font-family:Manrope,sans-serif;overflow:hidden}
    .back{position:relative;width:750px;height:1050px;padding:72px 64px;background:
      radial-gradient(circle at 80% 16%,rgba(44,227,211,.10),transparent 38%),
      linear-gradient(140deg,#0b1a16,#07110f 55%,#0b1a16)}
    .frame{position:absolute;inset:30px;border:1px solid #3d6259}.frame::before{content:"";position:absolute;inset:8px;border:1px solid rgba(201,242,95,.18)}
    .top{display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(239,245,241,.18);padding-bottom:18px}
    .top img{width:52px;height:52px;flex:none;object-fit:contain;border:1px solid rgba(201,242,95,.5)}
    .top>div{min-width:0;max-width:calc(100% - 245px)}
    .kicker{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#2ce3d3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    h1{font-family:Fraunces,serif;font-size:64px;line-height:.95;letter-spacing:-.03em;margin-top:38px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .sub{font-size:19px;color:#b6cec7;margin-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .bio{font-size:18px;line-height:1.55;color:#cfe0da;margin-top:24px;display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
    .bio.small{font-size:16px;-webkit-line-clamp:10}
    .watermark{position:absolute;right:72px;bottom:188px;width:390px;height:390px;object-fit:contain;opacity:.11;filter:grayscale(1)}
    dl{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;margin-top:26px;border-top:1px solid rgba(239,245,241,.14);padding-top:18px}
    dt{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8aa39b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    dd{font-size:15px;color:#eff5f1;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .credit{position:absolute;left:64px;right:64px;bottom:120px;border-top:1px solid rgba(239,245,241,.14);padding-top:14px;font-size:16px;line-height:1.4;color:#b6cec7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .foot{position:absolute;left:64px;right:64px;bottom:88px;display:flex;justify-content:space-between;gap:24px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a8beb7}
    .foot span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.foot span:last-child{text-align:right;flex-shrink:0}
    .stamp{position:absolute;right:64px;top:76px;border:1px solid #c9f25f;color:#c9f25f;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;padding:5px 7px;text-transform:uppercase;transform:rotate(1.5deg)}
  </style></head><body><div class="back"><div class="frame"></div><img class="watermark" src="${logo}" alt=""><div class="top"><img src="${logo}" alt=""><div><p class="kicker">${esc(collection?.name ?? "Foilbury")}</p><p style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;color:#8aa39b;margin-top:4px">PUBLIC SHOWCASE · DESIGNED BACK</p></div></div><span class="stamp">Public-safe</span><h1>${esc(card.name)}</h1><p class="sub">${esc(card.subtitle ?? "")}</p><p class="bio ${(card.bio_safe ?? card.description ?? "").length > 480 ? "small" : ""}">${esc(card.bio_safe ?? card.description ?? "")}</p><dl>${attrMarkup}</dl><div class="credit">${esc(String(card.credit ?? "").trim() || "Credit not supplied")}</div><div class="foot"><span>Foilbury · ${esc(collection?.name ?? "Public showcase")}</span><span>No serial on a published back</span></div></div></body></html>`;
}
