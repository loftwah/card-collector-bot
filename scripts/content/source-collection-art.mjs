#!/usr/bin/env node
/**
 * Build the sourced collection banner/mark set from the downloaded reference
 * artwork. Real series art only: no gradients, motifs, initials, card collages
 * or generated placeholders.
 *
 * Inputs live under .foilbury/art-src (private working copies). Outputs and the
 * provenance manifest live under .foilbury/collection-art. Neither is public.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { ROOT } from "../lib/local.mjs";

const SRC = path.join(ROOT, ".foilbury", "art-src");
const OUT = path.join(ROOT, ".foilbury", "collection-art");
fs.mkdirSync(OUT, { recursive: true });
const fandom = JSON.parse(fs.readFileSync(path.join(SRC, "fandom-info.json"), "utf8"));
const retrievedAt = new Date().toISOString();

const fandomFile = (wiki, title) => {
  const key = wiki.replace(/\.fandom\.com$/, "");
  const record = (fandom[key] ?? []).find((item) => item.title === title);
  if (!record || record.missing || !record.url) throw new Error(`Missing Fandom image ${wiki} ${title}`);
  return record;
};
const fandomPage = (wiki, title) => `https://${wiki}/wiki/File:${title.replace(/^File:/, "").replaceAll(" ", "_")}`;
const fileTitle = (name) => name.replace(/^File:/, "");

const commons = {
  "chainsaw-man": {
    wiki: "commons.wikimedia.org",
    title: "File:Chainsaw Man (Japanese) logo.svg",
    local: "chainsaw-logo.svg",
    width: 792,
    height: 134,
    url: "https://upload.wikimedia.org/wikipedia/commons/4/46/Chainsaw_Man_%28Japanese%29_logo.svg",
    page: "https://commons.wikimedia.org/wiki/File:Chainsaw_Man_(Japanese)_logo.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "™/® Tatsuki Fujimoto, Shueisha",
    credit: "Vectorised by VulcanSphere based on the official chainsawman.dog logo. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  danganronpa: {
    wiki: "commons.wikimedia.org",
    title: "File:Danganronpa series English logo.svg",
    local: "dangan-logo.svg",
    width: 695,
    height: 190,
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Danganronpa_series_English_logo.svg",
    page: "https://commons.wikimedia.org/wiki/File:Danganronpa_series_English_logo.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "™ Spike Chunsoft",
    credit: "Vectorised by VulcanSphere. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "death-note": {
    wiki: "commons.wikimedia.org",
    title: "File:Death Note (black background) logo v2.svg",
    local: "death-logo-black.svg",
    width: 400,
    height: 117,
    url: "https://upload.wikimedia.org/wikipedia/commons/8/8c/Death_Note_%28black_background%29_logo_v2.svg",
    page: "https://commons.wikimedia.org/wiki/File:Death_Note_(black_background)_logo_v2.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "™/® Tsugumi Ohba, Takeshi Obata / Shueisha",
    credit: "White-on-black logo variant, vectorised by Mohammdaon and VulcanSphere. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  madoka: {
    wiki: "commons.wikimedia.org",
    title: "File:Mahō Shōjo Madoka Magika (Logo).svg",
    local: "madoka-logo.svg",
    width: 512,
    height: 115,
    url: "https://upload.wikimedia.org/wikipedia/commons/8/84/Mah%C5%8D_Sh%C5%8Djo_Madoka_Magika_%28Logo%29.svg",
    page: "https://commons.wikimedia.org/wiki/File:Mah%C5%8D_Sh%C5%8Djo_Madoka_Magika_(Logo).svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "™/® Magica Quartet / Aniplex・Madoka Partners・MBS",
    credit: "Extracted and optimised from the official 10th-anniversary site. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  nana: {
    wiki: "commons.wikimedia.org",
    title: "File:Nana anime logo.svg",
    local: "nana-logo.svg",
    width: 480,
    height: 200,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/17/Nana_anime_logo.svg",
    page: "https://commons.wikimedia.org/wiki/File:Nana_anime_logo.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "Yazawa Ai, Madhouse",
    credit: "Own SVG based on the anime cover. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "nba-opening-night": {
    wiki: "commons.wikimedia.org",
    title: "File:NBA script.svg",
    local: "nba-script.svg",
    width: 500,
    height: 267,
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e5/NBA_script.svg",
    page: "https://commons.wikimedia.org/wiki/File:NBA_script.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "National Basketball Association",
    credit: "League wordmark via Wikimedia Commons. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "project-sekai": {
    wiki: "commons.wikimedia.org",
    title: "File:Project Sekai wordmark.svg",
    local: "sekai-logo.svg",
    width: 602,
    height: 84,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/12/Project_Sekai_wordmark.svg",
    page: "https://commons.wikimedia.org/wiki/File:Project_Sekai_wordmark.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "™/® SEGA / Colorful Palette Inc. / Crypton Future Media, INC.",
    credit: "Vectorised by VulcanSphere from the official app wordmark. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "rick-and-morty": {
    wiki: "commons.wikimedia.org",
    title: "File:Rick and Morty.svg",
    local: "rick-logo.svg",
    width: 938,
    height: 286,
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Rick_and_Morty.svg",
    page: "https://commons.wikimedia.org/wiki/File:Rick_and_Morty.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "Adult Swim",
    credit: "Series wordmark via Wikimedia Commons. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "south-park": {
    wiki: "commons.wikimedia.org",
    title: "File:South Park logo.svg",
    local: "south-park-logo.svg",
    width: 2849,
    height: 339,
    url: "https://upload.wikimedia.org/wikipedia/commons/1/13/South_Park_logo.svg",
    page: "https://commons.wikimedia.org/wiki/File:South_Park_logo.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "Comedy Central / South Park Studios",
    credit: "Series wordmark via Wikimedia Commons. Trademark of its rights holder; no affiliation or licence claimed.",
  },
  "the-simpsons": {
    wiki: "commons.wikimedia.org",
    title: "File:The Simpsons logo - Yellow.svg",
    local: "simpsons-logo.svg",
    width: 1000,
    height: 459,
    url: "https://upload.wikimedia.org/wikipedia/commons/c/c0/The_Simpsons_logo_-_Yellow.svg",
    page: "https://commons.wikimedia.org/wiki/File:The_Simpsons_logo_-_Yellow.svg",
    license: "Public domain (PD-textlogo, Wikimedia Commons)",
    artist: "20th Century Studios / Matt Groening",
    credit: "Series wordmark via Wikimedia Commons. Trademark of its rights holder; no affiliation or licence claimed.",
  },
};

const entries = [
  {
    slug: "alien-stage",
    name: "Alien Stage — Stage Lights",
    wiki: "alien-stage.fandom.com",
    seriesPage: "https://alien-stage.fandom.com/wiki/Alien_Stage",
    banner: { source: "alien-museum.png", title: "File:Alien Stage Museum thumbnail.jpg" },
    logo: { source: "alien-logo.png", title: "File:ALNST anime logo.jpg", fit: "contain" },
  },
  {
    slug: "chainsaw-man-public-safety",
    name: "Chainsaw Man — Public Safety, Part 1",
    wiki: "chainsaw-man.fandom.com",
    seriesPage: "https://chainsaw-man.fandom.com/wiki/Chainsaw_Man",
    banner: { source: "chainsaw-banner.png", title: "File:Chainsaw Man Movie - Reze Arc Prime Video Key Visual.png" },
    logo: { commons: commons["chainsaw-man"] },
  },
  {
    slug: "danganronpa-three-games",
    name: "Danganronpa — Three Killing Games",
    wiki: "danganronpa.fandom.com",
    seriesPage: "https://danganronpa.fandom.com/wiki/Danganronpa",
    banner: { source: "dangan-banner.png", title: "File:Danganronpa 1.2 Wallpaper - Group - Japanese (1920 x 1200).jpg" },
    logo: { commons: commons.danganronpa },
  },
  {
    slug: "death-note",
    name: "Death Note — The Kira Case",
    wiki: "deathnote.fandom.com",
    seriesPage: "https://deathnote.fandom.com/wiki/Death_Note",
    logo: { commons: commons["death-note"] },
  },
  {
    slug: "doki-doki-literature-club",
    name: "Doki Doki Literature Club! — The Clubroom",
    wiki: "doki-doki-literature-club.fandom.com",
    seriesPage: "https://doki-doki-literature-club.fandom.com/wiki/Doki_Doki_Literature_Club!",
    banner: { source: "ddlc-banner.png", title: "File:Doki Doki Literature Club.png" },
    logo: { source: "ddlc-square.png", title: "File:Logo.png", fit: "contain" },
  },
  {
    slug: "madoka-magica-mitakihara",
    name: "Puella Magi Madoka Magica — Mitakihara",
    wiki: "madoka.fandom.com",
    seriesPage: "https://madoka.fandom.com/wiki/Puella_Magi_Madoka_Magica",
    banner: { source: "madoka-banner.png", title: "File:Madoka Magica visual of the main characters.jpeg" },
    logo: { commons: commons.madoka },
  },
  {
    slug: "nana-two-nanas",
    name: "NANA — Two Nanas, One Tokyo",
    wiki: "nana.fandom.com",
    seriesPage: "https://nana.fandom.com/wiki/Nana",
    banner: { source: "nana-banner.png", title: "File:Nana-anime.png" },
    logo: { commons: commons.nana },
  },
  {
    slug: "nba-opening-night",
    name: "NBA — Opening Night",
    wiki: "commons.wikimedia.org",
    seriesPage: "https://commons.wikimedia.org/wiki/File:NBA_script.svg",
    logo: { commons: commons["nba-opening-night"] },
  },
  {
    slug: "neon-genesis-evangelion",
    name: "Neon Genesis Evangelion — Episodes 1–26",
    wiki: "evangelion.fandom.com",
    seriesPage: "https://evangelion.fandom.com/wiki/Neon_Genesis_Evangelion",
    logo: { source: "evangelion-logo.png", title: "File:Neon Genesis Evangelion Logo transparent.png", fit: "contain" },
  },
  {
    slug: "project-sekai",
    name: "Project Sekai — Unit Stage",
    wiki: "projectsekai.fandom.com",
    seriesPage: "https://projectsekai.fandom.com/wiki/Project_SEKAI_COLORFUL_STAGE!_feat._Hatsune_Miku",
    banner: { source: "sekai-festa.png", title: "File:Creators Festa 2025 Key Visual.jpg" },
    logo: { commons: commons["project-sekai"] },
  },
  {
    slug: "rick-and-morty",
    name: "Rick and Morty — Portal",
    wiki: "rickandmorty.fandom.com",
    seriesPage: "https://rickandmorty.fandom.com/wiki/Rick_and_Morty",
    logo: { commons: commons["rick-and-morty"] },
  },
  {
    slug: "scott-pilgrim",
    name: "Scott Pilgrim — Six Volumes, One City",
    wiki: "scottpilgrim.fandom.com",
    seriesPage: "https://scottpilgrim.fandom.com/wiki/Scott_Pilgrim",
    logo: { source: "scott-logo.png", title: "File:Scott Pilgrim logo.png", fit: "contain" },
  },
  {
    slug: "south-park",
    name: "South Park — Town Album",
    wiki: "southpark.fandom.com",
    seriesPage: "https://southpark.fandom.com/wiki/South_Park",
    banner: { source: "south-banner.png", title: "File:SP new Intro.png" },
    logo: { commons: commons["south-park"] },
  },
  {
    slug: "summer-hikaru-died",
    name: "The Summer Hikaru Died — The Village and the Voice",
    wiki: "the-summer-hikaru-died.fandom.com",
    seriesPage: "https://the-summer-hikaru-died.fandom.com/wiki/The_Summer_Hikaru_Died",
    banner: { source: "hikaru-banner.png", title: "File:Hikaru Banner.jpg" },
    logo: { source: "hikaru-logo.png", title: "File:The Summer Hikaru Died Logo.png", fit: "contain" },
  },
  {
    slug: "the-simpsons",
    name: "The Simpsons — Springfield, U.S.A.",
    wiki: "simpsons.fandom.com",
    seriesPage: "https://simpsons.fandom.com/wiki/The_Simpsons",
    logo: { commons: commons["the-simpsons"] },
  },
  {
    slug: "total-drama-island",
    name: "Total Drama Island — Camp Wawanakwa, 2007",
    wiki: "totaldrama.fandom.com",
    seriesPage: "https://totaldrama.fandom.com/wiki/Total_Drama_Island_(2007)",
    banner: { source: "tdi-promo.png", title: "File:Total Drama Island promo.png" },
    logo: {
      source: "tdi-logo.png",
      title: "File:TDILogo.jpg",
      fit: "contain",
      transform: "crop",
      crop: { left: 250, top: 150, width: 800, height: 490 },
      note: "Cropped from the published TDI logo card to the logo plate only; no generated decoration.",
    },
  },
  {
    slug: "vocaloid",
    name: "Vocaloid — Voicebanks",
    wiki: "vocaloid.fandom.com",
    seriesPage: "https://vocaloid.fandom.com/wiki/Vocaloid",
    banner: { source: "vocaloid-group.png", title: "File:The Vocaloid full image without logo.jpg" },
    logo: { source: "vocaloid-logo.png", title: "File:VOCALOID6 Logo.png", fit: "contain" },
  },
];

const creditFor = (wiki, title) =>
  `Third-party artwork © its rights holders; sourced from ${wiki} (“${fileTitle(title)}”) for this private, non-commercial member album. Not official or licensed. No affiliation or licence claimed.`;

async function sourceRecord(entry, role, spec) {
  if (spec.commons) {
    const c = spec.commons;
    return {
      role,
      wiki: c.wiki,
      page_url: c.page,
      file_page: c.page,
      image_url: c.url,
      file_title: c.title,
      retrieved_at: retrievedAt,
      license: c.license,
      artist: c.artist,
      credit: c.credit,
      source_dimensions: { width: c.width, height: c.height },
      origin: "sourced",
      official: false,
      review_status: "reviewed",
      access_classification: "member",
      local_source: path.join(SRC, c.local),
    };
  }
  const info = fandomFile(entry.wiki, spec.title);
  return {
    role,
    wiki: entry.wiki,
    page_url: entry.seriesPage,
    file_page: fandomPage(entry.wiki, spec.title),
    image_url: info.url,
    file_title: spec.title,
    retrieved_at: retrievedAt,
    license: info.license ?? "Not stated by source",
    artist: info.artist ?? null,
    credit: info.credit ?? creditFor(entry.wiki, spec.title),
    source_dimensions: { width: info.width, height: info.height },
    origin: "sourced",
    official: false,
    review_status: "reviewed",
    access_classification: "member",
    local_source: path.join(SRC, spec.source),
  };
}

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function buildBanner(entry, spec) {
  const source = await sourceRecord(entry, "banner", spec);
  const input = sharp(source.local_source);
  const meta = await input.metadata();
  const targetWidth = Math.min(1920, meta.width ?? 1920);
  const targetHeight = Math.round((targetWidth * 9) / 16);
  const bytes = await input
    .resize(targetWidth, targetHeight, { fit: "cover", position: "centre", withoutEnlargement: true })
    .webp({ quality: 88, effort: 5 })
    .toBuffer();
  const out = path.join(OUT, `${entry.slug}-banner.webp`);
  fs.writeFileSync(out, bytes);
  const outMeta = await sharp(bytes).metadata();
  return {
    ...source,
    local_source: undefined,
    source_bytes_sha256: hash(fs.readFileSync(source.local_source)),
    output_file: out,
    output_mime: "image/webp",
    output_dimensions: { width: outMeta.width, height: outMeta.height },
    output_bytes: bytes.length,
    sha256: hash(bytes),
    transform: meta.width === 1920 && meta.height === 1080 ? "resize" : "centre-crop to 16:9",
  };
}

async function buildLogo(entry, spec) {
  const source = await sourceRecord(entry, "logo", spec);
  const isSvg = source.local_source.endsWith(".svg");
  let pipeline = isSvg
    ? sharp(source.local_source, { density: 100 })
    : sharp(source.local_source);
  if (spec.transform === "crop") {
    pipeline = pipeline.extract(spec.crop);
  }
  const meta = await pipeline.metadata();
  const targetWidth = Math.min(2400, Math.max(1200, meta.width ?? 1200));
  const bytes = await pipeline
    .resize({
      width: targetWidth,
      withoutEnlargement: false,
      fit: "inside",
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const out = path.join(OUT, `${entry.slug}-logo.png`);
  fs.writeFileSync(out, bytes);
  const outMeta = await sharp(bytes).metadata();
  return {
    ...source,
    local_source: undefined,
    source_bytes_sha256: hash(fs.readFileSync(source.local_source)),
    output_file: out,
    output_mime: "image/png",
    output_dimensions: { width: outMeta.width, height: outMeta.height },
    output_bytes: bytes.length,
    sha256: hash(bytes),
    transform: spec.transform === "crop" ? `crop ${JSON.stringify(spec.crop)}` : isSvg ? "SVG render" : "resize",
    note: spec.note ?? null,
  };
}

const manifest = [];
for (const entry of entries) {
  const collection = { slug: entry.slug, name: entry.name, wiki: entry.wiki, seriesPage: entry.seriesPage };
  if (entry.banner) collection.banner = await buildBanner(entry, entry.banner);
  if (entry.logo) collection.logo = await buildLogo(entry, entry.logo);
  manifest.push(collection);
  console.log(`${entry.slug}: ${collection.banner ? "banner" : "no banner"} + ${collection.logo ? "logo" : "no logo"}`);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ generated_at: retrievedAt, entries: manifest }, null, 2));
console.log(`Wrote ${manifest.length} collection art records to ${path.relative(ROOT, OUT)}`);
