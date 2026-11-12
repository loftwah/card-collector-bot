CREATE TABLE fb_public_cabinet_visits (
  day TEXT PRIMARY KEY,
  visits INTEGER NOT NULL CHECK (visits > 0),
  first_seen_at TEXT NOT NULL
);
