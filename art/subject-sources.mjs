/**
 * Researched subject-image sources for the launch catalogue.
 *
 * The launch collections use real, publicly published character/player images
 * rather than generated monograms. Each source is recorded with its page, file,
 * retrieval date and the licence metadata the host exposes. These are third-
 * party images used in a private, non-commercial member album; this file does
 * not claim official affiliation or a licence that the source does not grant.
 *
 * `file` pins a specific image when a wiki's current page image is the wrong
 * adaptation, a lower-quality crop, or not a still image.
 */
export const COLLECTION_SOURCES = {
  "alien-stage": { provider: "fandom", wiki: "alien-stage.fandom.com", label: "Alien Stage Wiki (Fandom)" },
  "chainsaw-man": { provider: "fandom", wiki: "chainsaw-man.fandom.com", label: "Chainsaw Man Wiki (Fandom)" },
  "danganronpa": { provider: "fandom", wiki: "danganronpa.fandom.com", label: "Danganronpa Wiki (Fandom)" },
  "death-note": { provider: "fandom", wiki: "deathnote.fandom.com", label: "Death Note Wiki (Fandom)" },
  "doki-doki-literature-club": {
    provider: "fandom",
    wiki: "doki-doki-literature-club.fandom.com",
    label: "Doki Doki Literature Club Wiki (Fandom)",
  },
  "madoka-magica": { provider: "fandom", wiki: "madoka.fandom.com", label: "Puella Magi Wiki (Fandom)" },
  "nana": { provider: "fandom", wiki: "nana.fandom.com", label: "NANA Wiki (Fandom)" },
  "neon-genesis-evangelion": { provider: "fandom", wiki: "evangelion.fandom.com", label: "Evangelion Wiki (Fandom)" },
  "project-sekai": { provider: "fandom", wiki: "projectsekai.fandom.com", label: "Project SEKAI Wiki (Fandom)" },
  "rick-and-morty": { provider: "fandom", wiki: "rickandmorty.fandom.com", label: "Rick and Morty Wiki (Fandom)" },
  "scott-pilgrim": { provider: "fandom", wiki: "scottpilgrim.fandom.com", label: "Scott Pilgrim Wiki (Fandom)" },
  "south-park": { provider: "fandom", wiki: "southpark.fandom.com", label: "South Park Archives (Fandom)" },
  "summer-hikaru-died": {
    provider: "fandom",
    wiki: "the-summer-hikaru-died.fandom.com",
    label: "The Summer Hikaru Died Wiki (Fandom)",
  },
  "the-simpsons": { provider: "fandom", wiki: "simpsons.fandom.com", label: "Simpsons Wiki (Fandom)" },
  "total-drama-island": { provider: "fandom", wiki: "totaldrama.fandom.com", label: "Total Drama Wiki (Fandom)" },
  "vocaloid": { provider: "fandom", wiki: "vocaloid.fandom.com", label: "Vocaloid Wiki (Fandom)" },
  "nba": { provider: "wikimedia", wiki: "en.wikipedia.org", label: "Wikipedia / Wikimedia Commons" },
};

/**
 * Card-level source overrides. Keys are `<collection-slug>:<card-slug>`.
 * `page` changes the wiki page; `file` pins an exact File: image; `focus`
 * controls the crop (`attention`, `centre`, `top`, `bottom`, `left`, `right`).
 */
export const CARD_SOURCE_OVERRIDES = {
  // Season 1 (2007) stills, not the 2023 reboot character renders.
  "total-drama-island:chris-mclean": {
    file: "TDI01 Chris McLean is the host of Total Drama Island.png",
    crop: { x: 0.318, y: 0.148, w: 0.365, h: 0.833 },
  },
  "total-drama-island:chef-hatchet": { file: "TDI01 Chef wants Owen to repeat himself.png", focus: "attention" },
  "total-drama-island:gwen": { file: "TDI01 Gwen hears her name.png", focus: "centre" },
  "total-drama-island:owen": { file: "TDI01 Owen's first appearance.png", focus: "attention" },
  "total-drama-island:heather": { file: "TDI01 Heather hears her name.png", focus: "centre" },
  "total-drama-island:duncan": { file: "TDI01 Duncan hears his name.png", focus: "centre" },
  "total-drama-island:leshawna": { file: "TDI01 Leshawna doesn't like Eva eventually.png", focus: "attention" },
  "total-drama-island:izzy": { file: "TDI01 Izzy asks about the food in Camp Wawanakwa.png", focus: "attention" },

  // Clean character renders where the wiki's current page image is a screenshot.
  "the-simpsons:homer-simpson": { file: "Profile - Homer Simpson.png" },
  "the-simpsons:marge-simpson": { file: "Profile - Marge Simpson.png" },
  "the-simpsons:bart-simpson": { file: "Profile - Bart Simpson.png" },
  "the-simpsons:lisa-simpson": { file: "Profile - Lisa Simpson.png" },
  "the-simpsons:maggie-simpson": { file: "Maggie-and-snowball.jpg", focus: "attention" },
  "the-simpsons:moe-szyslak": { file: "Profile - Moe Szyslak.png" },
  "the-simpsons:ned-flanders": { file: "Profile - Ned Flanders.png" },
  "the-simpsons:mr-burns": { file: "Charles Montgomery Burns.png" },

  // Twin voicebanks share a page image; use the individual 2024 renders.
  "vocaloid:kagamine-rin": { file: "RIN_SP.png" },
  "vocaloid:kagamine-len": { file: "LEN_SP.png" },

  // Context cards use a scene/key image, not a person.
  "alien-stage:the-stage": { file: "(ZOMR1)The-Stage.png", focus: "attention" },
  "doki-doki-literature-club:clubroom": { file: "Club.png", focus: "centre" },
  "doki-doki-literature-club:poem-exchange": { file: "Sukipoem.webp", focus: "centre" },
  "doki-doki-literature-club:school-festival": { file: "Epilogue.png", focus: "attention" },

  // Page titles that differ from the display name.
  "death-note:l": { page: "L (character)" },
  "death-note:light-yagami": { focus: "top" },
  "doki-doki-literature-club:protagonist": { file: "Protagonist's_sketch.jpg", focus: "attention" },
  "doki-doki-literature-club:poem-exchange": { file: "Say_trust_poem1.jpg", focus: "attention" },
  "madoka-magica-mitakihara:junko-kaname": { file: "PMMM01_Junko_is_ready_for_work.jpg", focus: "attention" },
  "nba-opening-night:shai-gilgeous-alexander": { commonsFile: "Shai Gilgeous-Alexander (51815871018) (cropped).jpg" },
  "nba-opening-night:jaylen-brown": { commonsFile: "Jaylen Brown 2022 (cropped).jpg" },
  "nana-two-nanas:reira-serizawa": { page: "Layla Serizawa" },
  "south-park:chef": { page: 'Jerome "Chef" McElroy' },
  "nba-opening-night:anthony-edwards": { wikipediaTitle: "Anthony Edwards (basketball)" },
};
