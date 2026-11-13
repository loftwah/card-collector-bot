const media = "/media/showcase/editorial";
const woodhouse = "https://woodhouse.loftwah.com/campaign";

export const editorialShareImage = `${media}/rhea-at-the-bench.jpg`;

export const cabinetArtwork = {
  src: `${media}/midnight-cabinet.webp`,
  srcset: `${media}/midnight-cabinet-480.webp 480w, ${media}/midnight-cabinet.webp 960w`,
  width: 960,
  height: 1200,
  title: "The midnight cabinet",
  alt: "A candlelit cabinet filled with illustrated collectibles, with Rhea at its centre",
  source: `${woodhouse}/20261113-seasonal-library/foil-halloween.png`,
};

// Public Woodhouse × Foilbury illustrations. These are editorial assets, so they
// never become a print, a card thumbnail, or a substitute for an owned copy.
export const characterArtwork = [
  {
    slug: "moss",
    name: "Moss",
    title: "Moss, the quiet collector",
    alt: "Moss in a yellow hat and green hoodie, holding a keepsake in a woodland clearing",
    src: `${media}/moss-cut-paper.webp`,
    width: 576,
    height: 720,
    source: `${woodhouse}/20261113-share-expansion/foilbury-moss-cut-paper-feed-original.jpg`,
  },
  {
    slug: "rhea",
    name: "Rhea",
    title: "Rhea in broken tile",
    alt: "A ceramic mosaic of Rhea with round glasses, teal hair and a coral backdrop",
    src: `${media}/rhea-mosaic.webp`,
    width: 672,
    height: 672,
    source: `${woodhouse}/20261113-wild-25/foilbury-rhea-mosaic.png`,
  },
  {
    slug: "pippa",
    name: "Pippa",
    title: "Pippa in print",
    alt: "An illustrated portrait of Pippa, a black dog with expressive brown eyes",
    src: `${media}/pippa-in-print.webp`,
    width: 576,
    height: 720,
    source: `${woodhouse}/20261113-share-expansion/foilbury-pippa-print-feed-original.jpg`,
  },
] as const;
