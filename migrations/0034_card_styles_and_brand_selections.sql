-- Named card art directions and brand asset selection.
--
-- Styles are art directions (Atelier, Cinematic, Editorial, Archive, Manga,
-- Minimal). Plain/Silver/Gold/Holographic remain finishes. The brief carries
-- the requested directions, each job and candidate carries the one it was
-- generated in, the approval records the chosen direction, and the published
-- variant render keeps it so member surfaces can name the card they show.

ALTER TABLE fb_art_briefs ADD COLUMN style_keys_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fb_art_jobs ADD COLUMN style_key TEXT;
ALTER TABLE fb_art_candidates ADD COLUMN style_key TEXT;
ALTER TABLE fb_art_approvals ADD COLUMN style_key TEXT;
ALTER TABLE fb_variant_renders ADD COLUMN style_key TEXT;

CREATE INDEX IF NOT EXISTS fb_art_candidates_style_idx
  ON fb_art_candidates(tenant_id, style_key);

-- One selected asset per real consumer. This is not a second asset library:
-- every path points at a file that already ships under /public.
CREATE TABLE IF NOT EXISTS fb_brand_selections (
  slot TEXT PRIMARY KEY,
  asset_path TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
