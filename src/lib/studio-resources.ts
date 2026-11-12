export const STUDIO_IMAGE_BASE = "/studio/resource-images";
export const REFERENCE_PRINTS = [
  {
    title: "Under the Wave off Kanagawa",
    credit: "Katsushika Hokusai · 1830/33",
    use: "Silhouette, ink and negative space.",
    file: "great-wave.webp",
    width: 1200,
    height: 628,
    url: "https://www.artic.edu/artworks/24645",
    rights: "Art Institute of Chicago · CC0",
  },
  {
    title: "Water Lilies",
    credit: "Claude Monet · c. 1922",
    use: "Reflected light and atmosphere.",
    file: "water-lilies.webp",
    width: 1050,
    height: 987,
    url: "https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Water_Lilies_-_Google_Art_Project.jpg",
    rights: "Toledo Museum of Art · public domain",
  },
  {
    title: "The Child’s Bath",
    credit: "Mary Cassatt · 1893",
    use: "An overhead viewpoint, patterned fabric and quiet colour.",
    file: "childs-bath.webp",
    width: 787,
    height: 1200,
    url: "https://commons.wikimedia.org/wiki/File:Mary_Cassatt_-_The_Child%27s_Bath_-_Google_Art_Project.jpg",
    rights: "Art Institute of Chicago · public domain",
  },
];

export const AFTER_THE_TIDE = {
  slug: "after-the-tide",
  title: "After the Tide",
  kind: "Scene layer",
  use: "Ink, paper grain and negative space based on the CC0 Hokusai print.",
  file: "after-the-tide.webp",
  width: 1536,
  height: 1024,
};

export const STUDIO_STUDIES = [
  {
    slug: "clubroom-after-hours",
    title: "Clubroom After Hours",
    kind: "Scene layer",
    use: "Warm character backdrop with an open centre for a separately composited subject.",
    file: "clubroom-after-hours.webp",
    width: 1536,
    height: 1024,
    prompt:
      "Create one landscape scene plate for a layered collectible-card illustration. An empty literature clubroom late in the afternoon, viewed from the doorway. Warm peach sunlight from tall windows on the left, deep wine-red curtain, soft olive shadows, modest desks and books toward the edges. Leave the centre open and low contrast for a separate character. Carefully drawn perspective, lived-in details, cel-paint and gouache finish. Wistful. Edge-to-edge landscape 3:2. No people, readable text, lettering, logos, border, UI or mockup.",
  },
  {
    slug: "bell-before-the-bout",
    title: "Bell Before the Bout",
    kind: "Banner background",
    use: "A Fighter banner direction with room for the real collection mark and code-set title.",
    file: "bell-before-the-bout.webp",
    width: 1536,
    height: 1024,
    prompt:
      "Create an original banner background for an indie fighting-game collection named Fighter. A small empty boxing gym just before a bout, photographed from ringside at waist height. Place the worn oxblood corner pad, heavy brass bell and strong rope diagonals on the right. Reserve a darker open left third for a real logo and title that will be set later. Warm spotlit amber dust and ivory canvas against burgundy and charcoal. Cinematic sports editorial photography with tactile grain. Edge-to-edge landscape 3:2 that can survive a centred 16:9 crop. No people, text, branding, symbols, watermarks or mockup.",
  },
  {
    slug: "rolled-silver",
    title: "Rolled Silver",
    kind: "Material texture",
    use: "A monochrome texture for masked Silver borders and narrow foil highlights.",
    file: "rolled-silver.webp",
    width: 1254,
    height: 1254,
    prompt:
      "Make a square material plate for a collectible-card compositor: a flat sheet of finely brushed, lightly rolled silver foil seen straight-on in macro, filling the image edge to edge. Nearly neutral monochrome with physically credible directional hairline marks and a few broad soft bands of reflection. A strong but diffuse reflection crosses diagonally. Restrained contrast, with texture visible at thumbnail scale. Suitable for masked overlay or soft-light blending. No object boundary, frame, folds, props, watermarks, text, tint, emblems or card.",
  },
  {
    slug: "fern-corner",
    title: "Fern Corner",
    kind: "Frame ornament",
    use: "A transparent corner ornament for botanical and Fairy treatments.",
    file: "fern-corner.webp",
    width: 1254,
    height: 1254,
    prompt:
      "Create one standalone frame-corner ornament for a premium archival collectible. An asymmetric upper-left L made from two antique engraved fern fronds and a tiny seed pod. One frond follows the top edge, the other drops along the left edge. Warm tarnished-brass foil with etched dark-green detail, crisp silhouette and slender strokes. The inner lower-right space remains empty. Square RGBA with a true transparent background and generous clear margins. No enclosing frame, simulated checkerboard, backdrop, cast shadow, card, type, watermark or stray objects.",
  },
  {
    slug: "ember-moth",
    title: "Ember Moth",
    kind: "Subject cutout",
    use: "An original subject for testing cutout scale, framing and finish.",
    file: "ember-moth.webp",
    width: 1374,
    height: 1145,
    prompt:
      "Create one full-body original fantasy creature cutout for a layered collectible-card compositor. An ember moth the size of a songbird with a compact velvet-charcoal body, broad rust-red wings with cream eyespots, and short feathery antennae. Three-quarter view, wings open asymmetrically, head angled toward the viewer. Hand-painted natural-history textures and a strong silhouette, warm amber rim light, readable at small size. Keep every wing tip and both antennae within frame. Square RGBA with true transparency and clean edges. Subject only. No props, cast shadow, scenery, floor, text, logos, frame, badge or simulated checkerboard.",
  },
];
