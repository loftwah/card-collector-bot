const badge = document.querySelector<HTMLElement>("[data-art-pending]");
const endpoint = badge?.dataset.endpoint;
if (badge && endpoint) {
  fetch(endpoint, { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const count = Number((payload as { count?: number } | null)?.count ?? 0);
      if (!count) return;
      badge.textContent = String(count);
      badge.hidden = false;
    })
    .catch(() => undefined);
}
