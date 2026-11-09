// A broken private object must never show initials or a broken image.
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.dataset.avatarImg) return;
    const fallback = image.dataset.fallbackSrc || "/avatars/default/keeper-256.png";
    if (image.src.endsWith(fallback)) return;
    image.removeAttribute("srcset");
    image.src = fallback;
  },
  true,
);
