import type { APIRoute } from "astro";

const images = import.meta.glob<string>("../../../assets/studio-resources/*.webp", {
  eager: true,
  import: "default",
  query: "?inline",
});

export const GET: APIRoute = ({ params }) => {
  const image = images[`../../../assets/studio-resources/${params.file}`];
  if (!image) return new Response(null, { status: 404 });
  return new Response(
    Uint8Array.from(atob(image.split(",")[1]!), (character) => character.charCodeAt(0)),
    {
      headers: { "content-type": "image/webp", "cache-control": "private, no-store" },
    },
  );
};
