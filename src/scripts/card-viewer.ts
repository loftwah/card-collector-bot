/**
 * Server-rendered card objects open the shared CardViewer island without
 * pulling the whole gallery into React. A trigger carries its own facts as
 * JSON; the enclosing [data-card-grid] supplies the order for arrow-key
 * browsing between sibling cards.
 */
type CardFacts = Record<string, unknown>;

function readFacts(element: HTMLElement): CardFacts | null {
  const raw = element.dataset.cardFacts;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardFacts;
  } catch {
    return null;
  }
}

function triggerElements(element: HTMLElement): HTMLElement[] {
  const grid = element.closest<HTMLElement>("[data-card-grid]");
  if (!grid) return [element];
  return Array.from(grid.querySelectorAll<HTMLElement>("[data-card-facts]"));
}

function openFrom(element: HTMLElement) {
  const siblings = triggerElements(element);
  const items = siblings.map(readFacts).filter((item): item is CardFacts => Boolean(item));
  if (!items.length) return;
  const index = Math.max(0, siblings.indexOf(element));
  window.dispatchEvent(new CustomEvent("foilbury:card-viewer", { detail: { items, index } }));
}

document.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const trigger = target?.closest<HTMLElement>("[data-card-facts]");
  if (!trigger) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openFrom(trigger);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target as Element | null;
  const trigger = target?.closest<HTMLElement>("[data-card-facts]");
  if (!trigger) return;
  const tag = trigger.tagName;
  if (tag === "BUTTON" || tag === "A") return;
  event.preventDefault();
  openFrom(trigger);
});
