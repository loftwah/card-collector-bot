import type { APIRoute } from "astro";
import { pageContext } from "../server/page";
import { listCards } from "../server/modules/catalogue";
import { listPublicCollections } from "../server/modules/collections";

export const prerender = false;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export const GET: APIRoute = async ({ request }) => {
  const ctx = await pageContext(request);
  const [cards, collections] = await Promise.all([listCards(ctx, { publicOnly: true, limit: 200 }), listPublicCollections(ctx)]);
  const origin = ctx.config.publicOrigin.replace(/\/$/, "");
  const urls = [
    { loc: `${origin}/`, priority: "1.0" },
    { loc: `${origin}/cabinet`, priority: "0.9" },
    { loc: `${origin}/tour`, priority: "0.8" },
    { loc: `${origin}/brand-kit`, priority: "0.6" },
    { loc: `${origin}/showcase`, priority: "0.6" },
    { loc: `${origin}/journal`, priority: "0.7" },
    { loc: `${origin}/login`, priority: "0.4" },
    ...collections.map((collection) => ({ loc: `${origin}/cabinet?collection=${encodeURIComponent(collection.slug)}`, priority: "0.7" })),
    ...cards.map((card) => ({ loc: `${origin}/cabinet/${encodeURIComponent(card.slug)}`, priority: "0.6" })),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (entry) => `  <url><loc>${escapeXml(entry.loc)}</loc><changefreq>weekly</changefreq><priority>${entry.priority}</priority></url>`,
  )
  .join("\n")}
</urlset>`;
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
};
