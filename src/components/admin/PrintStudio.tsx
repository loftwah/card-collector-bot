"use client";

import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
          const result = await api<{ reviews: Review[] }>(`/api/v1/admin/prints/${proposal.id}`).catch(
            () => ({ reviews: [] }),
          );
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

  async function proposalAction(
    proposal: Proposal,
    action: "submit" | "approve" | "reject",
  ) {
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
    const result = await act(`${action}-${proposal.id}`, `/api/v1/admin/prints/${proposal.id}/${path}`, "POST", body);
    if (result) {
      setNotice(`Print ${proposal.print_number} ${action === "submit" ? "submitted for review" : `${action}d`}.`);
      await loadPrints(proposal.card_id);
    }
  }

  async function linkEdition(proposal: Proposal) {
    const edition = editions.find(
      (item) => item.subject_asset_id === proposal.artwork_asset_id && item.status !== "retired",
    );
    if (!edition) {
      setError("Create an artwork edition with the approved print artwork first, then link it here.");
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
    <div className="grid gap-6 lg:grid-cols-[280px_1fr] lg:items-start">
      <aside className="panel p-3">
        <label className="field">
          <span>Find a subject</span>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, slug or collection"
          />
        </label>
        <div className="mt-3 grid max-h-[68vh] gap-0.5 overflow-y-auto pr-1">
          {filtered.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => setSelectedId(card.id)}
              className={`rounded-[1px] px-2.5 py-2 text-left transition-colors ${
                card.id === selectedId
                  ? "bg-[var(--ink)] text-[var(--paper)]"
                  : "hover:bg-[var(--paper-2)]"
              }`}
            >
              <span className="block text-sm font-medium">{card.name}</span>
              <span className="block font-mono text-[0.58rem] uppercase tracking-[0.08em] opacity-70">
                {card.collections[0]?.name ?? "Unfiled"} · {card.editions.length} editions · {card.status}
              </span>
            </button>
          ))}
          {!filtered.length ? (
            <p className="px-2 py-3 text-sm text-[var(--muted)]">No subject matches that search.</p>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0">
        {error ? (
          <p className="mb-4 border border-[var(--oxblood)] bg-[var(--paper)] p-3 text-sm text-[var(--oxblood)]">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mb-4 border border-[var(--line-strong)] bg-[var(--paper)] p-3 text-sm">
            {notice}
          </p>
        ) : null}

        {!selected ? (
          <div className="panel p-6">
            <p className="text-sm text-[var(--muted)]">Choose a subject to review its prints.</p>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="eyebrow">Print studio · distinct artwork editions</p>
                <h2 className="display-sm mt-1 text-3xl uppercase">{selected.name}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  A print is a different artwork and composition. A finish is a treatment of that print.
                </p>
              </div>
              <Button onClick={() => setCreateOpen((open) => !open)}>
                {createOpen ? "Close form" : "Propose a print"}
              </Button>
            </header>

            {coverage ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-4">
                {[
                  ["Coverage", statusLabel(coverage.label)],
                  ["Approved prints", `${coverage.approved_prints}`],
                  ["Distinct artwork", `${coverage.distinct_approved_artwork}`],
                  ["Linked editions", `${coverage.linked_editions}`],
                ].map(([label, value]) => (
                  <div key={label} className="panel p-3">
                    <p className="eyebrow">{label}</p>
                    <p className="mt-1 text-lg font-semibold">{value}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {createOpen ? (
              <section className="panel mt-5 p-4">
                <h3 className="display-sm text-xl uppercase">Propose a print</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Create the review record first. Approval, edition linking and publication stay separate.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
                      className="input min-h-28"
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
                      onChange={(event) => setForm({ ...form, sourceAssetId: event.target.value })}
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
                      onChange={(event) => setForm({ ...form, artworkAssetId: event.target.value })}
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
                      placeholder="Original Foilbury character; generated with a reviewed identity reference."
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
                <div className="mt-4 flex justify-end">
                  <Button onClick={createProposal} disabled={busy === "create"}>
                    {busy === "create" ? "Saving…" : "Save print proposal"}
                  </Button>
                </div>
              </section>
            ) : null}

            <section className="mt-6">
              <div className="flex items-end justify-between gap-3">
                <h3 className="display-sm text-xl uppercase">Proposed prints</h3>
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                  {proposals.length} record{proposals.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-3 grid gap-3">
                {proposals.map((proposal) => (
                  <article key={proposal.id} className="panel p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="eyebrow">
                          Print {proposal.print_number} · {statusLabel(proposal.role)}
                        </p>
                        <h4 className="mt-1 text-lg font-semibold">{proposal.title}</h4>
                        <p className="mt-1 font-mono text-[0.6rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          {proposal.print_key} · v{proposal.revision} · {proposal.status}
                          {proposal.reviewer_kind ? ` · ${proposal.reviewer_kind}-reviewed` : ""}
                        </p>
                      </div>
                      <span className="border border-[var(--line-strong)] px-2 py-1 font-mono text-[0.58rem] uppercase tracking-[0.08em]">
                        {proposal.status}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <figure className="border border-[var(--line)] bg-[var(--paper-2)] p-2">
                        <img
                          src={proposal.source_asset_url}
                          alt={`${proposal.title} identity source`}
                          className="mx-auto max-h-64 w-auto object-contain"
                          loading="lazy"
                        />
                        <figcaption className="mt-2 text-center font-mono text-[0.55rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Identity source
                        </figcaption>
                      </figure>
                      <figure className="border border-[var(--line)] bg-[var(--paper-2)] p-2">
                        {proposal.artwork_url ? (
                          <img
                            src={proposal.artwork_url}
                            alt={`${proposal.title} print artwork`}
                            className="mx-auto max-h-64 w-auto object-contain"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-64 items-center justify-center text-sm text-[var(--muted)]">
                            No artwork attached
                          </div>
                        )}
                        <figcaption className="mt-2 text-center font-mono text-[0.55rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Print artwork
                        </figcaption>
                      </figure>
                    </div>
                    <p className="mt-3 max-w-3xl text-sm leading-relaxed">{proposal.creative_direction}</p>
                    <div className="mt-2 flex flex-wrap gap-2 font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                      <span>Finishes: {proposal.finish_keys.join(" · ")}</span>
                      {proposal.approved_edition ? (
                        <span>Edition: {proposal.approved_edition.name}</span>
                      ) : null}
                    </div>
                    {proposal.review_note ? (
                      <p className="mt-2 border-l-2 border-[var(--line-strong)] pl-3 text-sm">
                        {proposal.review_note}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {proposal.status === "draft" ? (
                        <Button
                          size="sm"
                          onClick={() => proposalAction(proposal, "submit")}
                          disabled={busy === `submit-${proposal.id}`}
                        >
                          Submit for review
                        </Button>
                      ) : null}
                      {proposal.status === "proposed" ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() => proposalAction(proposal, "approve")}
                            disabled={busy === `approve-${proposal.id}`}
                          >
                            Approve print
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
                          Link the matching edition
                        </Button>
                      ) : null}
                    </div>
                    {(reviews[proposal.id]?.length ?? 0) > 0 ? (
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Review history · {reviews[proposal.id]!.length}
                        </summary>
                        <ol className="mt-2 grid gap-1">
                          {reviews[proposal.id]!.map((review) => (
                            <li key={review.id} className="text-[var(--muted)]">
                              <span className="font-mono text-[0.55rem] uppercase tracking-[0.08em]">
                                v{review.revision} · {review.decision} · {review.reviewer_kind}
                              </span>{" "}
                              {review.note}
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                  </article>
                ))}
                {!proposals.length ? (
                  <p className="panel p-5 text-sm text-[var(--muted)]">
                    No print proposals yet. A single artwork edition is not a multi-print subject; record a second
                    genuinely different composition before claiming coverage.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="mt-6">
              <h3 className="display-sm text-xl uppercase">Printed editions on this subject</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                These are the actual collectable editions. Finishes are listed inside each edition, not as prints.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {editions.map((edition) => (
                  <article key={edition.id} className="panel p-3">
                    {edition.subject_url ? (
                      <img
                        src={edition.subject_url}
                        alt={`${edition.name} artwork`}
                        className="mx-auto max-h-56 w-auto object-contain"
                        loading="lazy"
                      />
                    ) : null}
                    <p className="mt-2 text-sm font-semibold">{edition.name}</p>
                    <p className="font-mono text-[0.56rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                      {edition.status} · {edition.variants.length} finish
                      {edition.variants.length === 1 ? "" : "es"}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {edition.variants.map((variant) => variant.name).join(" · ")}
                    </p>
                  </article>
                ))}
                {!editions.length ? (
                  <p className="panel p-5 text-sm text-[var(--muted)]">
                    No artwork edition exists yet. Create one in Catalogue → Artwork after the print is approved.
                  </p>
                ) : null}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
