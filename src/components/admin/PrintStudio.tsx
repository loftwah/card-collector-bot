"use client";

import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import CardViewer, { openCardViewer, type CardViewerItem } from "../cards/CardViewer";

interface Variant {
  id: string;
  name: string;
  material_key: string;
  effect_key: string | null;
  status: string;
  render_url: string | null;
}

interface Edition {
  id: string;
  name: string;
  status: string;
  subject_asset_id?: string;
  subject_url?: string;
  variants: Variant[];
}

interface Card {
  id: string;
  slug: string;
  name: string;
  status: string;
  collections: Array<{ slug: string; name: string }>;
  editions: Edition[];
}

interface Asset {
  id: string;
  name: string;
  kind: string;
  width: number | null;
  height: number | null;
}

interface Proposal {
  id: string;
  card_id: string;
  print_number: string;
  print_key: string;
  role: string;
  title: string;
  creative_direction: string;
  status: "draft" | "proposed" | "approved" | "rejected";
  revision: number;
  source_asset_id: string;
  artwork_asset_id: string | null;
  background_asset_id: string | null;
  finish_keys: string[];
  rights_note: string | null;
  source_refs: string[];
  provenance: Record<string, unknown>;
  source_asset_url: string;
  artwork_url: string | null;
  background_url: string | null;
  review_note: string | null;
  reviewer_kind: "human" | "agent" | null;
  approved_edition: { id: string; name: string; status: string } | null;
  created_at: string;
  updated_at: string;
}

interface Coverage {
  card_id: string;
  total: number;
  by_status: Record<string, number>;
  approved_prints: number;
  distinct_approved_artwork: number;
  linked_editions: number;
  minimum_met: boolean;
  recommended_third: boolean;
  label: string;
}

interface Review {
  id: string;
  revision: number;
  decision: string;
  reviewer_kind: "human" | "agent";
  note: string | null;
  created_at: string;
}

const ROLES = [
  ["portrait", "Portrait"],
  ["action_scene", "Action / scene"],
  ["alternate_art", "Alternate art"],
  ["special_release", "Special release"],
  ["ensemble", "Ensemble"],
  ["location", "Location"],
  ["object", "Object"],
  ["other", "Other"],
] as const;

const FINISHES = ["plain", "silver", "gold", "holographic"] as const;

function statusLabel(label: string) {
  return label.replaceAll("_", " ");
}

export default function PrintStudio() {
  const [cards, setCards] = useState<Card[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [reviews, setReviews] = useState<Record<string, Review[]>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const selected = cards.find((card) => card.id === selectedId) ?? null;
  const editions = selected?.editions ?? [];
  const subjectAssets = assets.filter((asset) => asset.kind === "subject");
  const nextNumber = useMemo(() => {
    const used = new Set(proposals.map((proposal) => proposal.print_number));
    for (let number = 1; number < 100; number += 1) {
      const candidate = String(number).padStart(2, "0");
      if (!used.has(candidate)) return candidate;
    }
    return "01";
  }, [proposals]);

  const [form, setForm] = useState({
    printNumber: "01",
    role: "portrait",
    title: "",
    creativeDirection: "",
    sourceAssetId: "",
    artworkAssetId: "",
    rightsNote: "",
    finishKeys: ["plain", "silver", "gold", "holographic"] as string[],
    status: "draft" as "draft" | "proposed",
  });

  async function loadCards(keepSelection = true) {
    try {
      const data = await api<{ items: Card[] }>("/api/v1/admin/cards?limit=300");
      setCards(data.items);
      if (!keepSelection || !data.items.some((card) => card.id === selectedId)) {
        setSelectedId(data.items[0]?.id ?? "");
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function loadAssets() {
    try {
      const data = await api<{ items: Asset[] }>("/api/v1/admin/assets?kind=subject");
      setAssets(data.items);
    } catch {
      setAssets([]);
    }
  }

  async function loadPrints(cardId: string) {
    if (!cardId) return;
    try {
      const data = await api<{ items: Proposal[]; coverage: Coverage }>(
        `/api/v1/admin/cards/${cardId}/prints`,
      );
      setProposals(data.items);
      setCoverage(data.coverage);
      const detail = await Promise.all(
        data.items.map(async (proposal) => {
          const result = await api<{ reviews: Review[] }>(
            `/api/v1/admin/prints/${proposal.id}`,
          ).catch(() => ({ reviews: [] }));
          return [proposal.id, result.reviews] as const;
        }),
      );
      setReviews(Object.fromEntries(detail));
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    void Promise.all([loadCards(false), loadAssets()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) void loadPrints(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!selected) return;
    const sourceId = selected.editions[0]?.subject_asset_id ?? "";
    setForm((current) => ({
      ...current,
      printNumber: nextNumber,
      title: current.title || `${selected.name} · New print`,
      sourceAssetId: current.sourceAssetId || sourceId,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nextNumber]);

  async function act(key: string, path: string, method: string, body?: unknown) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await api<Record<string, unknown>>(path, { method, body });
      return result;
    } catch (cause) {
      setError(describeError(cause));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function createProposal() {
    if (!selected) return;
    const result = await act("create", `/api/v1/admin/cards/${selected.id}/prints`, "POST", {
      printNumber: form.printNumber,
      role: form.role,
      title: form.title,
      creativeDirection: form.creativeDirection,
      sourceAssetId: form.sourceAssetId,
      artworkAssetId: form.artworkAssetId || null,
      rightsNote: form.rightsNote || null,
      finishKeys: form.finishKeys,
      status: form.status,
    });
    if (result) {
      setNotice(`Print ${form.printNumber} recorded as ${form.status}.`);
      setCreateOpen(false);
      setForm((current) => ({ ...current, title: "", creativeDirection: "", artworkAssetId: "" }));
      await Promise.all([loadPrints(selected.id), loadCards(true)]);
    }
  }

  async function proposalAction(proposal: Proposal, action: "submit" | "approve" | "reject") {
    const path = action === "submit" ? "submit" : "review";
    const body =
      action === "submit"
        ? { expectedRevision: proposal.revision, note: "Submitted from Studio → Print studio." }
        : {
            decision: action === "approve" ? "approved" : "rejected",
            expectedRevision: proposal.revision,
            note:
              action === "approve"
                ? "Reviewed in Studio → Print studio against the source and card contract."
                : "Rejected in Studio → Print studio. Revise the proposal or artwork.",
          };
    const result = await act(
      `${action}-${proposal.id}`,
      `/api/v1/admin/prints/${proposal.id}/${path}`,
      "POST",
      body,
    );
    if (result) {
      setNotice(
        `Print ${proposal.print_number} ${action === "submit" ? "submitted for review" : `${action}d`}.`,
      );
      await loadPrints(proposal.card_id);
    }
  }

  async function linkEdition(proposal: Proposal) {
    const edition = editions.find(
      (item) => item.subject_asset_id === proposal.artwork_asset_id && item.status !== "retired",
    );
    if (!edition) {
      setError(
        "Create an artwork edition with the approved print artwork first, then link it here.",
      );
      return;
    }
    const result = await act(
      `link-${proposal.id}`,
      `/api/v1/admin/prints/${proposal.id}/link`,
      "POST",
      { editionId: edition.id, expectedRevision: proposal.revision },
    );
    if (result) {
      setNotice(`Print ${proposal.print_number} linked to ${edition.name}.`);
      await loadPrints(proposal.card_id);
    }
  }

  const proposalViewerItems: CardViewerItem[] = proposals.map((proposal) => ({
    id: proposal.id,
    name: selected?.name ?? proposal.title,
    subtitle: proposal.title,
    collection: selected?.collections[0]?.name ?? null,
    styleKey: null,
    finish: proposal.finish_keys.join(", "),
    method: `Print ${proposal.print_number} · ${statusLabel(proposal.role)}`,
    status: proposal.status,
    audience: null,
    provenance: proposal.rights_note ?? proposal.creative_direction,
    front: proposal.artwork_url ?? proposal.source_asset_url,
    downloadUrl: proposal.artwork_url ?? proposal.source_asset_url,
  }));

  const editionArt = (edition: Edition) =>
    edition.variants.find((variant) => variant.render_url)?.render_url ?? edition.subject_url;

  const editionViewerItems: CardViewerItem[] = editions
    .filter((edition) => editionArt(edition))
    .map((edition) => ({
      id: edition.id,
      name: selected?.name ?? edition.name,
      subtitle: edition.name,
      collection: selected?.collections[0]?.name ?? null,
      finish: edition.variants
        .map((variant) => variant.name)
        .slice(0, 4)
        .join(", "),
      method: "Artwork edition",
      status: edition.status,
      front: editionArt(edition)!,
      downloadUrl: editionArt(edition)!,
    }));

  function openProposal(proposal: Proposal) {
    const index = Math.max(
      0,
      proposals.findIndex((entry) => entry.id === proposal.id),
    );
    openCardViewer(proposalViewerItems, index);
  }

  function openEdition(edition: Edition) {
    const list = editions.filter((entry) => editionArt(entry));
    const index = Math.max(
      0,
      list.findIndex((entry) => entry.id === edition.id),
    );
    openCardViewer(editionViewerItems, index);
  }

  const subjectList = (prefix: string) => (
    <>
      <label className="field">
        <span>Find a subject</span>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, slug or collection"
          aria-label="Find a subject"
        />
      </label>
      <div className="print-subjects__list" id={`${prefix}-subjects`}>
        {filtered.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => setSelectedId(card.id)}
            aria-pressed={card.id === selectedId}
            className="print-subject"
            data-active={card.id === selectedId}
          >
            <span className="print-subject__name">{card.name}</span>
            <span className="print-subject__meta">
              {card.collections[0]?.name ?? "Unfiled"} · {card.editions.length} editions
            </span>
          </button>
        ))}
        {!filtered.length ? (
          <p className="px-1 py-3 text-sm text-[var(--muted)]">No subject matches that search.</p>
        ) : null}
      </div>
    </>
  );

  const filtered = cards.filter((card) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return (
      card.name.toLowerCase().includes(needle) ||
      card.slug.toLowerCase().includes(needle) ||
      card.collections.some((collection) => collection.name.toLowerCase().includes(needle))
    );
  });

  return (
    <div className="print-studio">
      <CardViewer />

      <header className="artlab-bar">
        <div className="artlab-bar__title">
          <h2>Print studio</h2>
          <p>
            {selected ? selected.name : "Choose a subject"} · {proposals.length} print
            {proposals.length === 1 ? "" : "s"} ·{" "}
            {coverage ? statusLabel(coverage.label) : "no coverage yet"}
          </p>
        </div>
        <div className="artlab-bar__actions">
          {selected ? (
            <Button size="sm" onClick={() => setCreateOpen((open) => !open)}>
              {createOpen ? "Close" : "Propose a print"}
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p role="alert" className="error-box mt-3">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice mt-3">
          {notice}
        </p>
      ) : null}

      <details className="print-picker-mobile">
        <summary>
          Subject · <strong>{selected?.name ?? "choose one"}</strong>
        </summary>
        <div className="mt-2">{subjectList("mobile")}</div>
      </details>

      <div className="print-studio__body">
        <aside className="print-subjects" aria-label="Subjects">
          {subjectList("desktop")}
        </aside>

        <div className="min-w-0">
          {!selected ? (
            <div className="empty">
              <div>
                <p className="font-mono text-[0.62rem] tracking-[0.12em] uppercase">
                  No subject selected
                </p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Choose a subject to review its distinct prints.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="print-subject-head">
                <div className="min-w-0">
                  <h3>{selected.name}</h3>
                  <p>
                    {selected.editions.length} edition
                    {selected.editions.length === 1 ? "" : "s"} · {proposals.length} print
                    {proposals.length === 1 ? "" : "s"}
                    {coverage
                      ? ` · ${coverage.approved_prints} approved · ${coverage.distinct_approved_artwork} distinct artwork · ${coverage.linked_editions} linked`
                      : ""}
                  </p>
                </div>
              </div>

              {createOpen ? (
                <section className="panel artlab-form mt-3 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold">Propose a print</h3>
                    <span className="badge">v1 draft</span>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="field">
                      <span>Print number</span>
                      <Input
                        value={form.printNumber}
                        onChange={(event) => setForm({ ...form, printNumber: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Role</span>
                      <select
                        className="input"
                        value={form.role}
                        onChange={(event) => setForm({ ...form, role: event.target.value })}
                      >
                        {ROLES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field sm:col-span-2">
                      <span>Title</span>
                      <Input
                        value={form.title}
                        onChange={(event) => setForm({ ...form, title: event.target.value })}
                        placeholder={`${selected.name} · Rooftop relay`}
                      />
                    </label>
                    <label className="field sm:col-span-2">
                      <span>Creative direction · at least 40 characters</span>
                      <textarea
                        className="input min-h-24"
                        value={form.creativeDirection}
                        onChange={(event) =>
                          setForm({ ...form, creativeDirection: event.target.value })
                        }
                        placeholder="Composition, pose, setting, palette, medium and why this is a different print."
                      />
                    </label>
                    <label className="field">
                      <span>Identity source asset</span>
                      <select
                        className="input"
                        value={form.sourceAssetId}
                        onChange={(event) =>
                          setForm({ ...form, sourceAssetId: event.target.value })
                        }
                      >
                        <option value="">Choose a subject asset</option>
                        {subjectAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Print artwork asset</span>
                      <select
                        className="input"
                        value={form.artworkAssetId}
                        onChange={(event) =>
                          setForm({ ...form, artworkAssetId: event.target.value })
                        }
                      >
                        <option value="">No artwork yet · draft only</option>
                        {subjectAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field sm:col-span-2">
                      <span>Rights / provenance note</span>
                      <Input
                        value={form.rightsNote}
                        onChange={(event) => setForm({ ...form, rightsNote: event.target.value })}
                        placeholder="Original Foilbury character; reviewed identity reference."
                      />
                    </label>
                    <fieldset className="sm:col-span-2">
                      <legend className="eyebrow">Finish availability</legend>
                      <div className="mt-2 flex flex-wrap gap-3">
                        {FINISHES.map((finish) => (
                          <label key={finish} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={form.finishKeys.includes(finish)}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  finishKeys: event.target.checked
                                    ? [...form.finishKeys, finish]
                                    : form.finishKeys.filter((item) => item !== finish),
                                })
                              }
                            />
                            {finish}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <label className="field sm:col-span-2">
                      <span>Save as</span>
                      <select
                        className="input"
                        value={form.status}
                        onChange={(event) =>
                          setForm({ ...form, status: event.target.value as "draft" | "proposed" })
                        }
                      >
                        <option value="draft">Draft</option>
                        <option value="proposed">Submit for review</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-4 flex justify-end border-t border-[var(--line)] pt-3">
                    <Button onClick={createProposal} disabled={busy === "create"}>
                      {busy === "create" ? "Saving…" : "Save print proposal"}
                    </Button>
                  </div>
                </section>
              ) : null}

              <section className="mt-4">
                <div className="collection-section-head">
                  <h3 className="collection-section-title">Proof wall</h3>
                  <span className="collection-section-meta">
                    {proposals.length} print{proposals.length === 1 ? "" : "s"}
                  </span>
                </div>
                {proposals.length ? (
                  <div className="print-grid">
                    {proposals.map((proposal) => (
                      <article key={proposal.id} className="print-tile">
                        <div className="print-tile__top">
                          <span>
                            Print {proposal.print_number} · {statusLabel(proposal.role)}
                          </span>
                          <span className="print-tile__status">{proposal.status}</span>
                        </div>
                        <button
                          type="button"
                          className="print-tile__view"
                          onClick={() => openProposal(proposal)}
                          aria-label={`Open ${proposal.title} full size`}
                        >
                          <img
                            src={proposal.artwork_url ?? proposal.source_asset_url}
                            alt={`${proposal.title} print artwork`}
                            width={750}
                            height={1050}
                            loading="lazy"
                          />
                          <span className="proof-pin__flag">
                            {proposal.artwork_url ? "Artwork" : "Source only"}
                          </span>
                        </button>
                        <div className="print-tile__caption">
                          <p className="print-tile__name">{proposal.title}</p>
                          <p className="print-tile__meta">
                            {proposal.print_key} · v{proposal.revision} ·{" "}
                            {proposal.finish_keys.join(" / ")}
                          </p>
                        </div>
                        <div className="print-tile__actions">
                          {proposal.status === "draft" ? (
                            <Button
                              size="sm"
                              onClick={() => proposalAction(proposal, "submit")}
                              disabled={busy === `submit-${proposal.id}`}
                            >
                              Submit
                            </Button>
                          ) : null}
                          {proposal.status === "proposed" ? (
                            <>
                              <Button
                                size="sm"
                                onClick={() => proposalAction(proposal, "approve")}
                                disabled={busy === `approve-${proposal.id}`}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => proposalAction(proposal, "reject")}
                                disabled={busy === `reject-${proposal.id}`}
                              >
                                Reject
                              </Button>
                            </>
                          ) : null}
                          {proposal.status === "approved" && !proposal.approved_edition ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => linkEdition(proposal)}
                              disabled={busy === `link-${proposal.id}`}
                            >
                              Link edition
                            </Button>
                          ) : null}
                        </div>
                        <details className="print-tile__details">
                          <summary>Direction and review</summary>
                          <p>{proposal.creative_direction}</p>
                          {proposal.rights_note ? <p>Rights: {proposal.rights_note}</p> : null}
                          {proposal.review_note ? <p>Review: {proposal.review_note}</p> : null}
                          {proposal.approved_edition ? (
                            <p>Edition: {proposal.approved_edition.name}</p>
                          ) : null}
                          {(reviews[proposal.id]?.length ?? 0) > 0 ? (
                            <ol>
                              {reviews[proposal.id]!.map((review) => (
                                <li key={review.id}>
                                  <span>
                                    v{review.revision} · {review.decision} · {review.reviewer_kind}
                                  </span>{" "}
                                  {review.note}
                                </li>
                              ))}
                            </ol>
                          ) : null}
                          <a
                            href={proposal.source_asset_url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-4"
                          >
                            Open the identity source
                          </a>
                        </details>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty mt-2">
                    <div>
                      <p className="font-mono text-[0.62rem] tracking-[0.12em] uppercase">
                        No print proposals yet
                      </p>
                      <p className="mt-2 max-w-md text-sm">
                        One artwork edition is not a multi-print subject. Record a genuinely
                        different composition before claiming coverage.
                      </p>
                    </div>
                  </div>
                )}
              </section>

              <section className="mt-6">
                <div className="collection-section-head">
                  <h3 className="collection-section-title">Printed editions</h3>
                  <span className="collection-section-meta">
                    {editions.length} edition{editions.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="print-edition-grid">
                  {editions.map((edition) => (
                    <article key={edition.id} className="print-edition">
                      {editionArt(edition) ? (
                        <button
                          type="button"
                          className="print-edition__view"
                          onClick={() => openEdition(edition)}
                          aria-label={`Open ${edition.name} artwork full size`}
                        >
                          <img
                            src={editionArt(edition)!}
                            alt={`${edition.name} artwork`}
                            width={750}
                            height={1050}
                            loading="lazy"
                          />
                        </button>
                      ) : null}
                      <p className="print-edition__name">{edition.name}</p>
                      <p className="print-edition__meta">
                        {edition.status} · {edition.variants.length} finish
                        {edition.variants.length === 1 ? "" : "es"}
                      </p>
                    </article>
                  ))}
                  {!editions.length ? (
                    <p className="empty mt-2 p-5 text-sm text-[var(--muted)]">
                      No artwork edition yet. Create one in Catalogue → Artwork after the print is
                      approved.
                    </p>
                  ) : null}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
