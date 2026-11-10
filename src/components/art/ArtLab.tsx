"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import CardViewer, { openCardViewer, type CardViewerItem } from "../cards/CardViewer";
import BrandShelf from "./BrandShelf";
import { CARD_STYLES, CARD_STYLE_LABEL } from "@/lib/card-styles";
import { BRAND_ASSETS, type BrandKind } from "@/lib/brand-catalogue";

type Surface = "studio" | "platform";
type ArtCategory =
  "cards" | "icons" | "mascots" | "logo" | "og_images" | "shareables" | "banners" | "other";
type ArtMethod = "whole_card" | "composed_scene" | "composed_texture" | "raw_art";
type FeedbackTag =
  | "too-busy"
  | "wrong-palette"
  | "wrong-face"
  | "too-generic"
  | "text-unreadable"
  | "flat-material"
  | "composition"
  | "keep";

interface Permissions {
  read: boolean;
  write: boolean;
  approve_public: boolean;
  publish: boolean;
  publish_brand: boolean;
}

interface DailySpend {
  cap_cents: number;
  spent_cents: number;
  remaining_cents: number;
  day: string;
}

interface BriefSummary {
  id: string;
  category: ArtCategory;
  title: string;
  intent: string;
  collection_id: string | null;
  collection_name: string | null;
  collection_slug: string | null;
  card_id: string | null;
  card_name: string | null;
  target_variant_id: string | null;
  audience: string;
  status: string;
  candidate_count: number;
  methods: ArtMethod[];
  styles: string[];
  spend_cents: number;
  cost_cap_cents: number;
  candidate_total: number;
  pending_count: number;
  approved_count: number;
  latest_job_status: string | null;
  latest_error: string | null;
  cover_candidate_id: string | null;
  cover_url: string | null;
  cover_method: ArtMethod | null;
  created_at: string;
  updated_at: string;
}

interface ArtPin {
  candidate_id: string;
  brief_id: string;
  brief_title: string;
  category: ArtCategory;
  collection_name: string | null;
  card_name: string | null;
  label: string;
  method: ArtMethod;
  style_key: string | null;
  status: string;
  width: number;
  height: number;
  audience: string;
  created_at: string;
  image_url: string;
}

interface CategoryCount {
  key: ArtCategory;
  label: string;
  brief_count: number;
  candidate_count: number;
  pending_count: number;
  spend_cents: number;
}

interface IndexData {
  briefs: BriefSummary[];
  pins: ArtPin[];
  categories: CategoryCount[];
  daily: DailySpend;
  permissions: Permissions;
}

interface Job {
  id: string;
  brief_id: string;
  method: ArtMethod;
  style_key: string | null;
  provider: string;
  model: string;
  prompt: string;
  count: number;
  status: string;
  cost_estimate_cents: number;
  cost_actual_cents: number | null;
  cost_source: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface Feedback {
  id: string;
  decision: string;
  author_user_id: string;
  tags: FeedbackTag[];
  body: string | null;
  created_at: string;
}

interface Approval {
  id: string;
  candidate_id: string;
  approved_by: string;
  approved_at: string;
  usage: string;
  notes: string | null;
  vector_ref: string | null;
  target_kind: string | null;
  target_id: string | null;
  published_at: string | null;
  published_by: string | null;
  rollback_at: string | null;
  published_asset_id: string | null;
}

interface Candidate {
  id: string;
  brief_id: string;
  job_id: string;
  label: string;
  method: ArtMethod;
  method_label: string;
  method_note: string;
  style_key: string | null;
  style_label: string | null;
  provider: string;
  model: string;
  prompt: string;
  seed: string | null;
  width: number;
  height: number;
  display_width: number;
  display_height: number;
  sha256: string;
  audience: string;
  official: boolean;
  status: string;
  asset_id: string;
  render_asset_id: string | null;
  render_back_asset_id: string | null;
  master_asset_id: string | null;
  preview_400_asset_id: string | null;
  thumb_128_asset_id: string | null;
  display_side: "render" | "raw";
  metadata: Record<string, unknown>;
  files: {
    display: string;
    raw: string;
    back: string | null;
    master: string | null;
    preview400: string | null;
    thumb128: string | null;
    reference: string | null;
    download: string;
  };
  feedback: Feedback[];
  approval: Approval | null;
  created_at: string;
  updated_at: string;
}

interface BriefDetail {
  brief: BriefSummary & {
    references: string[];
    output_sizes: string[];
    notes: string | null;
    provider: string;
    model: string;
    style_keys: string[];
    created_by: string;
  };
  collection: {
    id: string;
    slug: string;
    name: string;
    scope: string;
    view_audience: string;
    logo_url: string | null;
    banner_url: string | null;
  } | null;
  card: {
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    status: string;
    rarity_name: string | null;
    collection_name: string | null;
  } | null;
  target_variant: {
    id: string;
    name: string;
    material_key: string;
    effect_key: string | null;
    edition_id: string;
  } | null;
  jobs: Job[];
  candidates: Candidate[];
  current_render: {
    asset_id: string;
    public_url: string;
    width: number;
    height: number;
    sha256: string;
    published_at: string | null;
    back_asset_id: string | null;
    back_sha256: string | null;
  } | null;
  permissions: Permissions;
  price: { provider: string; model: string; unit_cents: number; note: string } | null;
}

interface OptionCollection {
  id: string;
  slug: string;
  name: string;
  scope: string;
  status: string;
  view_audience: string;
  manageable: boolean;
}

interface OptionCard {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  collections: Array<{ id: string; name: string; slug: string }>;
  editions: Array<{
    id: string;
    name: string;
    variants: Array<{
      id: string;
      name: string;
      material_key: string;
      effect_key: string | null;
      status: string;
    }>;
  }>;
}

interface PriceModel {
  id: string;
  label: string;
  unitCents: number;
  priceNote: string;
  methods: ArtMethod[];
}

interface PriceProvider {
  provider: "fal" | "openai";
  label: string;
  keyEnv: string;
  models: PriceModel[];
}

interface OptionsData {
  categories: ArtCategory[];
  category_labels: Record<string, string>;
  providers: PriceProvider[];
  methods: Array<{ key: ArtMethod; label: string; note: string }>;
  collections: OptionCollection[];
  cards: OptionCard[];
  daily_cap_cents: number;
  default_cap_cents: number;
  max_cap_cents: number;
  tags: FeedbackTag[];
  styles: Array<{ key: string; label: string; note: string; prompt: string; thumb: string }>;
  default_style: string;
}

const BRAND_KIND_BY_CATEGORY: Partial<Record<ArtCategory, BrandKind>> = {
  icons: "icons",
  mascots: "mascots",
  logo: "logos",
  og_images: "og_images",
  banners: "banners",
  shareables: "shareables",
  other: "other",
};

const CATEGORY_LABELS: Record<ArtCategory, string> = {
  cards: "Cards",
  icons: "Icons",
  mascots: "Mascots",
  logo: "Logo",
  og_images: "OG images",
  shareables: "Shareables",
  banners: "Banners",
  other: "Other art",
};

const STATUS_TONE: Record<string, string> = {
  draft: "text-[var(--muted)]",
  generating: "text-[var(--signal)]",
  review: "text-[var(--ink)]",
  approved: "text-[var(--green)]",
  published: "text-[var(--green)]",
  archived: "text-[var(--muted)]",
  generated: "text-[var(--signal)]",
  shortlisted: "text-[var(--ink)]",
  needs_revision: "text-[var(--oxblood)]",
  rejected: "text-[var(--oxblood)]",
  failed: "text-[var(--oxblood)]",
  running: "text-[var(--signal)]",
  queued: "text-[var(--muted)]",
  succeeded: "text-[var(--green)]",
};

function money(cents: number | null | undefined): string {
  return `US$${(Number(cents ?? 0) / 100).toFixed(2)}`;
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function finishLabel(material: string | null, effect: string | null): string {
  if (material === "diamond" || material === "holographic" || effect === "holographic") {
    return "Holographic";
  }
  return (material ?? "plain").charAt(0).toUpperCase() + (material ?? "plain").slice(1);
}

function methodNote(candidate: Candidate): string {
  if (candidate.method === "whole_card") {
    return "Whole-card AI · reference-guided";
  }
  if (candidate.method === "composed_scene" || candidate.method === "composed_texture") {
    return "Composed card · not an AI image";
  }
  return "Raw brand art · type stays in code";
}

function exactCopyFromPrompt(prompt: string): string | null {
  const match = prompt.match(/EXACT COPY[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
  return match?.[1]?.trim() || null;
}

function candidateImage(candidate: Candidate): string {
  return candidate.display_side === "render" ? candidate.files.display : candidate.files.raw;
}

function readTags(candidate: Candidate): FeedbackTag[] {
  return [...new Set(candidate.feedback.flatMap((entry) => entry.tags))];
}

function fileBaseFor(surface: Surface): string {
  // The platform page and `/api/v1/admin` are separate Cloudflare Access
  // applications. The page-aligned transport keeps the browser inside the
  // Access session it already holds; the endpoint still enforces Super Admin.
  return surface === "studio" ? "/api/v1/studio/art" : "/platform-admin/art-api";
}

export default function ArtLab({ surface }: { surface: Surface }) {
  const base = fileBaseFor(surface);
  const [index, setIndex] = useState<IndexData | null>(null);
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState<ArtCategory>(surface === "studio" ? "cards" : "icons");
  const [selectedBriefId, setSelectedBriefId] = useState("");
  const [detail, setDetail] = useState<BriefDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [pendingCandidateId, setPendingCandidateId] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareSize, setCompareSize] = useState<300 | 750 | 400 | 214 | 128>(750);
  const [statusFilter, setStatusFilter] = useState("all");
  const [styleFilter, setStyleFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState("");
  const [feedbackTags, setFeedbackTags] = useState<FeedbackTag[]>([]);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [approvalUsage, setApprovalUsage] = useState("");
  const [approvalNotes, setApprovalNotes] = useState("");
  const [vectorRef, setVectorRef] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishVariantId, setPublishVariantId] = useState("");
  const [publishConfirmation, setPublishConfirmation] = useState("");
  const [publishNotes, setPublishNotes] = useState("");
  const [publishBack, setPublishBack] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [form, setForm] = useState({
    category: surface === "studio" ? ("cards" as ArtCategory) : ("icons" as ArtCategory),
    collectionId: "",
    cardId: "",
    targetVariantId: "",
    title: "",
    intent: "",
    references: "",
    audience: "members" as "private" | "members" | "public",
    candidateCount: 6,
    provider: "openai",
    model: "gpt-image-2.6-sunburst",
    methods: (surface === "studio" ? ["whole_card"] : ["raw_art"]) as ArtMethod[],
    styleKeys: ["atelier"] as string[],
    notes: "",
    costCapCents: 200,
  });

  const candidates = detail?.candidates ?? [];
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const filteredCandidates = useMemo(() => {
    return candidates.filter((candidate) => {
      if (statusFilter !== "all" && candidate.status !== statusFilter) return false;
      if (styleFilter === "unstyled" && candidate.style_key) return false;
      if (
        styleFilter !== "all" &&
        styleFilter !== "unstyled" &&
        candidate.style_key !== styleFilter
      )
        return false;
      if (methodFilter !== "all" && candidate.method !== methodFilter) return false;
      if (modelFilter !== "all" && candidate.model !== modelFilter) return false;
      if (tagFilter !== "all" && !readTags(candidate).includes(tagFilter as FeedbackTag))
        return false;
      return true;
    });
  }, [candidates, statusFilter, styleFilter, methodFilter, modelFilter, tagFilter]);
  const modelOptions = [...new Set(candidates.map((candidate) => candidate.model))];
  const compareCandidates = compareIds
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const categoryBriefs = (index?.briefs ?? []).filter((brief) => brief.category === category);
  const allCategoryPins = (index?.pins ?? []).filter((pin) => pin.category === category);
  const categoryPins =
    styleFilter === "all"
      ? allCategoryPins
      : styleFilter === "unstyled"
        ? allCategoryPins.filter((pin) => !pin.style_key)
        : allCategoryPins.filter((pin) => pin.style_key === styleFilter);
  const visibleCategories = (index?.categories ?? []).filter((entry) =>
    surface === "studio" ? entry.key === "cards" : entry.key !== "cards",
  );
  const activeCategoryLabel = options?.category_labels[category] ?? CATEGORY_LABELS[category];
  const provider = options?.providers.find((entry) => entry.provider === form.provider) ?? null;
  const providerModels = provider?.models ?? [];
  const formCollectionCards = (options?.cards ?? []).filter((card) =>
    card.collections.some((collection) => collection.id === form.collectionId),
  );
  const formCard = formCollectionCards.find((card) => card.id === form.cardId) ?? null;
  const formVariants =
    formCard?.editions.flatMap((edition) =>
      edition.variants
        .filter((variant) => variant.status === "published" || variant.status === "draft")
        .map((variant) => ({ ...variant, editionName: edition.name })),
    ) ?? [];
  const variantOptions =
    options?.cards
      .find((card) => card.id === detail?.brief.card_id)
      ?.editions.flatMap((edition) =>
        edition.variants
          .filter((variant) => variant.status === "published" || variant.status === "draft")
          .map((variant) => ({ ...variant, editionName: edition.name })),
      ) ?? [];

  useEffect(() => {
    void loadIndex();
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (surface === "studio") {
      setCategory("cards");
      setForm((current) => ({ ...current, category: "cards", methods: ["whole_card"] }));
    } else {
      setForm((current) => ({
        ...current,
        category: current.category === "cards" ? "icons" : current.category,
        methods: ["raw_art"],
        audience: "private",
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  useEffect(() => {
    if (selectedBriefId) void loadBrief(selectedBriefId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBriefId]);

  useEffect(() => {
    setSelectedCandidateId("");
    setCompareIds([]);
    setFeedbackTags([]);
    setFeedbackBody("");
    setApprovalUsage("");
    setApprovalNotes("");
    setVectorRef("");
    setPublishOpen(false);
    setStyleFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBriefId]);

  useEffect(() => {
    if (!selectedCandidate) return;
    setFeedbackTags(readTags(selectedCandidate));
    setFeedbackBody("");
    setApprovalUsage(
      detail?.brief.category === "cards"
        ? `Card front · ${detail.collection?.name ?? selectedCandidate.label}`
        : `Brand kit · ${detail?.brief.title ?? selectedCandidate.label}`,
    );
    setApprovalNotes("");
    setVectorRef(selectedCandidate.approval?.vector_ref ?? "");
    setPublishVariantId(detail?.brief.target_variant_id ?? detail?.target_variant?.id ?? "");
    setPublishConfirmation("");
    setPublishNotes("");
    setPublishBack(Boolean(selectedCandidate.render_back_asset_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCandidateId, detail?.brief.id]);

  async function loadIndex() {
    try {
      setError("");
      const data = await api<IndexData>(base);
      setIndex(data);
      if (!data.categories.some((entry) => entry.key === category)) {
        setCategory(data.categories[0]?.key ?? "cards");
      }
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function loadOptions() {
    try {
      const data = await api<OptionsData>(`${base}/options`);
      setOptions(data);
      if (data.default_style) {
        setForm((current) => ({
          ...current,
          styleKeys: current.styleKeys.length ? current.styleKeys : [data.default_style],
        }));
      }
    } catch {
      // The brief form is not the whole surface; keep the index usable.
    }
  }

  async function loadBrief(briefId: string) {
    setDetailLoading(true);
    try {
      const data = await api<BriefDetail>(`${base}/briefs/${briefId}`);
      setDetail(data);
      const preferred =
        data.candidates.find((candidate) => candidate.id === pendingCandidateId)?.id ??
        (data.candidates.some((candidate) => candidate.id === selectedCandidateId)
          ? selectedCandidateId
          : (data.candidates[0]?.id ?? ""));
      setSelectedCandidateId(preferred);
      setPendingCandidateId("");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setDetailLoading(false);
    }
  }

  async function refresh(briefId = selectedBriefId) {
    await Promise.all([loadIndex(), briefId ? loadBrief(briefId) : Promise.resolve()]);
  }

  async function act<T>(
    key: string,
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<T | null> {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      return await api<T>(`${base}${path}`, { method, body });
    } catch (cause) {
      setError(describeError(cause));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function createBrief() {
    const result = await act<{ brief: BriefDetail }>("create", "/briefs", {
      category: form.category,
      collectionId: form.category === "cards" ? form.collectionId : null,
      cardId: form.category === "cards" ? form.cardId : null,
      targetVariantId: form.category === "cards" ? form.targetVariantId || null : null,
      title: form.title,
      intent: form.intent,
      references: form.references
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      audience: form.audience,
      candidateCount: form.candidateCount,
      provider: form.provider,
      model: form.model,
      methods: form.methods,
      styleKeys: form.category === "cards" ? form.styleKeys : undefined,
      notes: form.notes || null,
      costCapCents: form.costCapCents,
    });
    if (!result) return;
    setShowNew(false);
    setNotice(
      `Brief “${result.brief.brief.title}” created. Queue generation when the direction is ready.`,
    );
    setSelectedBriefId(result.brief.brief.id);
    setCategory(result.brief.brief.category);
    await loadIndex();
  }

  async function generate() {
    if (!detail) return;
    const result = await act<{ brief: BriefDetail }>(
      "generate",
      `/briefs/${detail.brief.id}/generate`,
      {},
    );
    if (!result) return;
    setNotice(
      `Generation queued for ${result.brief.brief.methods.join(" + ")}. Run pnpm art:run locally; the job will fail loudly if a provider is unavailable.`,
    );
    await refresh();
  }

  async function cancelJob(job: Job) {
    if (!window.confirm("Cancel this queued or running job? The spend is recorded.")) return;
    const result = await act<{ job: Job }>("cancel-job", `/jobs/${job.id}/cancel`, {});
    if (!result) return;
    setNotice("Generation job cancelled. Queue a new direction when ready.");
    await refresh();
  }

  async function candidateFeedback(
    decision: "comment" | "shortlist" | "needs_revision" | "reject",
  ) {
    if (!selectedCandidate) return;
    const result = await act<{ candidate: Candidate }>(
      "feedback",
      `/candidates/${selectedCandidate.id}/feedback`,
      {
        decision,
        tags: feedbackTags,
        body: feedbackBody || null,
      },
    );
    if (!result) return;
    setNotice(`Feedback recorded on ${selectedCandidate.label}.`);
    setFeedbackBody("");
    await refresh();
  }

  async function approve() {
    if (!selectedCandidate) return;
    const result = await act<{ candidate: Candidate }>(
      "approve",
      `/candidates/${selectedCandidate.id}/approve`,
      {
        usage: approvalUsage,
        notes: approvalNotes || null,
        vectorRef: vectorRef || null,
      },
    );
    if (!result) return;
    setNotice(
      `${selectedCandidate.label} approved as the direction. Publish is a separate action.`,
    );
    await refresh();
  }

  async function publish() {
    if (!selectedCandidate) return;
    const result = await act<{ publication: Record<string, unknown> }>(
      "publish",
      `/candidates/${selectedCandidate.id}/publish`,
      {
        confirmation: publishConfirmation,
        variantId: publishVariantId || null,
        notes: publishNotes || null,
        publishBack,
        vectorRef: vectorRef || null,
      },
    );
    if (!result) return;
    setPublishOpen(false);
    setPublishConfirmation("");
    setNotice(`Published. The previous render is recorded for rollback.`);
    await refresh();
  }

  async function rollback() {
    if (!selectedCandidate?.approval) return;
    if (
      !window.confirm(
        "Roll back this publication? The previous render is restored from the recorded snapshot.",
      )
    ) {
      return;
    }
    const result = await act<{ approval: Approval }>(
      "rollback",
      `/approvals/${selectedCandidate.approval.id}/rollback`,
      {},
    );
    if (!result) return;
    setNotice("Publication rolled back. The previous render is live again.");
    await refresh();
  }

  function pinViewerItems(pins: ArtPin[]): CardViewerItem[] {
    return pins.map((pin) => ({
      id: pin.candidate_id,
      name: pin.card_name ?? pin.brief_title,
      subtitle: pin.brief_title,
      collection: pin.collection_name,
      styleKey: pin.style_key,
      finish: detail?.target_variant
        ? finishLabel(detail.target_variant.material_key, detail.target_variant.effect_key)
        : null,
      method: pin.method === "whole_card" ? "Whole-card AI" : "Composed card",
      status: pin.status,
      width: pin.width,
      height: pin.height,
      audience: pin.audience,
      provenance: null,
      front: pin.image_url,
    }));
  }

  function candidateViewerItems(list: Candidate[]): CardViewerItem[] {
    return list.map((candidate) => ({
      id: candidate.id,
      name: detail?.card?.name ?? detail?.brief.title ?? candidate.label,
      subtitle: detail?.card?.subtitle ?? candidate.label,
      collection: detail?.collection?.name ?? null,
      styleKey: candidate.style_key,
      styleLabel: candidate.style_label,
      finish: detail?.target_variant
        ? finishLabel(detail.target_variant.material_key, detail.target_variant.effect_key)
        : null,
      method: candidate.method_label,
      model: candidate.model,
      status: candidate.status,
      width: candidate.display_width,
      height: candidate.display_height,
      masterWidth: candidate.master_asset_id ? candidate.width : null,
      masterHeight: candidate.master_asset_id ? candidate.height : null,
      audience: candidate.audience,
      provenance: (() => {
        const match = candidate.prompt.match(/PROVENANCE:\s*([^\n]+)/);
        return match?.[1]?.trim() ?? candidate.method_note;
      })(),
      front: candidateImage(candidate),
      back: candidate.files.back,
      master: candidate.files.master,
      downloadUrl: candidate.files.download,
    }));
  }

  function openCandidateViewer(candidate: Candidate) {
    setSelectedCandidateId(candidate.id);
    const list = filteredCandidates.length ? filteredCandidates : candidates;
    const index = Math.max(
      0,
      list.findIndex((entry) => entry.id === candidate.id),
    );
    openCardViewer(candidateViewerItems(list), index);
  }

  function openPin(pin: ArtPin) {
    const list = categoryPins.length ? categoryPins : allCategoryPins;
    const index = Math.max(
      0,
      list.findIndex((entry) => entry.candidate_id === pin.candidate_id),
    );
    openCardViewer(pinViewerItems(list), index);
  }

  function toggleStyle(key: string) {
    setForm((current) => ({
      ...current,
      styleKeys: current.styleKeys.includes(key)
        ? current.styleKeys.length > 1
          ? current.styleKeys.filter((entry) => entry !== key)
          : current.styleKeys
        : [...current.styleKeys, key].slice(0, 4),
    }));
  }

  function updateCategory(next: ArtCategory) {
    if (surface === "studio" && next !== "cards") return;
    if (surface === "platform" && next === "cards") return;
    setCategory(next);
    setSelectedBriefId("");
    setDetail(null);
    setSelectedCandidateId("");
    setStyleFilter("all");
    const firstProvider = options?.providers[0] ?? null;
    const model = firstProvider?.models[0] ?? null;
    setForm((current) => ({
      ...current,
      category: next,
      collectionId: next === "cards" ? current.collectionId : "",
      cardId: next === "cards" ? current.cardId : "",
      targetVariantId: next === "cards" ? current.targetVariantId : "",
      methods: next === "cards" ? ["whole_card"] : ["raw_art"],
      styleKeys:
        next === "cards"
          ? current.styleKeys.length
            ? current.styleKeys
            : [options?.default_style ?? "atelier"]
          : [],
      provider: firstProvider?.provider ?? current.provider,
      model: model?.id ?? current.model,
      audience: next === "cards" ? current.audience : "private",
    }));
  }

  function updateProvider(providerId: string) {
    const next = options?.providers.find((entry) => entry.provider === providerId);
    const model =
      (form.category === "cards"
        ? next?.models.find((entry) => entry.methods.includes("whole_card"))
        : next?.models.find((entry) => entry.methods.includes("raw_art"))) ?? next?.models[0];
    setForm((current) => ({
      ...current,
      provider: providerId,
      model: model?.id ?? current.model,
      methods:
        model?.methods.filter((method) =>
          current.category === "cards" ? method !== "raw_art" : method === "raw_art",
        ) ?? current.methods,
    }));
  }

  function updateModel(modelId: string) {
    const model = providerModels.find((entry) => entry.id === modelId);
    setForm((current) => ({
      ...current,
      model: modelId,
      methods:
        model?.methods.filter((method) =>
          current.category === "cards" ? method !== "raw_art" : method === "raw_art",
        ) ?? current.methods,
    }));
  }

  function toggleCompare(candidateId: string) {
    setCompareIds((current) =>
      current.includes(candidateId)
        ? current.filter((id) => id !== candidateId)
        : [...current, candidateId].slice(0, 4),
    );
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const cards = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-candidate-card]") ?? [],
    );
    if (!cards.length) return;
    const active = cards.findIndex((card) => card === document.activeElement);
    const columns = window.innerWidth >= 1280 ? 3 : window.innerWidth >= 640 ? 2 : 1;
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? columns
            : event.key === "ArrowUp"
              ? -columns
              : 0;
    let next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : active + step;
    if (active < 0) next = 0;
    next = Math.max(0, Math.min(cards.length - 1, next));
    event.preventDefault();
    cards[next]?.focus();
  }

  if (loading) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading Art Lab">
        <div className="skeleton h-16 rounded-[3px]" />
        <div className="columns-2 gap-3 md:columns-3 xl:columns-4">
          <div className="skeleton mb-3 h-64 rounded-[3px]" />
          <div className="skeleton mb-3 h-80 rounded-[3px]" />
          <div className="skeleton mb-3 h-52 rounded-[3px]" />
          <div className="skeleton mb-3 h-72 rounded-[3px]" />
        </div>
      </div>
    );
  }

  const showStyleRail = (detail?.brief.category ?? category) === "cards";
  const brandKind = BRAND_KIND_BY_CATEGORY[category] ?? null;
  const canWrite = Boolean(index?.permissions.write);
  const activeStyleLabel =
    styleFilter === "all"
      ? "All styles"
      : styleFilter === "unstyled"
        ? "Unstyled"
        : (CARD_STYLE_LABEL[styleFilter] ?? styleFilter);

  return (
    <div className="min-w-0">
      <CardViewer />

      <header className="artlab-bar">
        <div className="artlab-bar__title">
          <h2>Art Lab</h2>
          <p>
            {surface === "studio" ? "Card art" : "Brand art"} · {money(index?.daily.spent_cents)} of{" "}
            {money(index?.daily.cap_cents)} today ·{" "}
            {index?.permissions.write ? "write" : "read only"}
          </p>
        </div>
        <div className="artlab-bar__actions">
          <a className="btn btn-secondary btn-sm" href="/studio/all-art">
            All art
          </a>
          {canWrite ? (
            <Button size="sm" onClick={() => setShowNew((open) => !open)}>
              {showNew ? "Close" : "New brief"}
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p role="alert" className="error-box mt-3">
          {error}{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => void loadIndex()}
          >
            Retry
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice mt-3">
          {notice}
        </p>
      ) : null}

      <nav className="artlab-categories" aria-label="Art Lab categories">
        {visibleCategories.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => updateCategory(entry.key)}
            aria-pressed={category === entry.key}
            className="chip shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--signal)]"
            data-active={category === entry.key}
          >
            {entry.label}
            <span className="text-[var(--muted)]">
              {surface === "platform"
                ? BRAND_ASSETS.filter((asset) => asset.kind === BRAND_KIND_BY_CATEGORY[entry.key])
                    .length
                : entry.brief_count}
            </span>
            {surface === "studio" && entry.pending_count ? (
              <span className="text-[var(--signal)]">{entry.pending_count}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {surface === "platform" && brandKind ? (
        <BrandShelf kind={brandKind} base={base} onNotice={setNotice} onError={setError} />
      ) : null}

      {showNew ? (
        <section className="panel artlab-form mt-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">New brief</h3>
            <span className="badge">Cap {money(form.costCapCents)}</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span>Category</span>
              <select
                className="select"
                value={form.category}
                onChange={(event) => updateCategory(event.target.value as ArtCategory)}
              >
                {(options?.categories ?? [form.category])
                  .filter((entry) => (surface === "studio" ? entry === "cards" : entry !== "cards"))
                  .map((entry) => (
                    <option key={entry} value={entry}>
                      {options?.category_labels[entry] ?? CATEGORY_LABELS[entry]}
                    </option>
                  ))}
              </select>
            </label>
            {form.category === "cards" ? (
              <>
                <label className="field">
                  <span>Collection</span>
                  <select
                    className="select"
                    value={form.collectionId}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        collectionId: event.target.value,
                        cardId: "",
                        targetVariantId: "",
                      })
                    }
                  >
                    <option value="">Choose a collection</option>
                    {(options?.collections ?? []).map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Subject</span>
                  <select
                    className="select"
                    value={form.cardId}
                    disabled={!form.collectionId}
                    onChange={(event) => {
                      const card = formCollectionCards.find(
                        (entry) => entry.id === event.target.value,
                      );
                      const firstVariant = card?.editions
                        .flatMap((edition) => edition.variants)
                        .find((variant) => variant.status === "published");
                      setForm({
                        ...form,
                        cardId: event.target.value,
                        targetVariantId: firstVariant?.id ?? "",
                      });
                    }}
                  >
                    <option value="">Choose a subject</option>
                    {formCollectionCards.map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Target finish</span>
                  <select
                    className="select"
                    value={form.targetVariantId}
                    disabled={!form.cardId}
                    onChange={(event) => setForm({ ...form, targetVariantId: event.target.value })}
                  >
                    <option value="">First published variant</option>
                    {formVariants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.name} · {variant.material_key}
                        {variant.effect_key ? ` / ${variant.effect_key}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>

          {form.category === "cards" ? (
            <fieldset className="mt-4">
              <legend className="eyebrow">Card styles · choose one or more</legend>
              <div className="style-picker mt-2">
                {(options?.styles ?? CARD_STYLES).map((style) => {
                  const active = form.styleKeys.includes(style.key);
                  return (
                    <label key={style.key} className="style-picker__item" data-active={active}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={active}
                        onChange={() => toggleStyle(style.key)}
                      />
                      <img src={style.thumb} alt="" width={480} height={480} loading="lazy" />
                      <span className="style-picker__label">{style.label}</span>
                      <span className="style-picker__note">{style.note}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <details className="artlab-form__details mt-4" open>
            <summary className="eyebrow cursor-pointer">Brief</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="field sm:col-span-2">
                <span>Title</span>
                <Input
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  placeholder="Doki Doki · rain on the clubroom window"
                />
              </label>
              <label className="field sm:col-span-2">
                <span>Intent</span>
                <Textarea
                  className="min-h-24"
                  value={form.intent}
                  onChange={(event) => setForm({ ...form, intent: event.target.value })}
                  placeholder="Composition, mood, palette, subject treatment and what must not appear."
                />
              </label>
              <label className="field">
                <span>Provider</span>
                <select
                  className="select"
                  value={form.provider}
                  onChange={(event) => updateProvider(event.target.value)}
                >
                  {(options?.providers ?? []).map((entry) => (
                    <option key={entry.provider} value={entry.provider}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <select
                  className="select"
                  value={form.model}
                  onChange={(event) => updateModel(event.target.value)}
                >
                  {providerModels.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} · {money(entry.unitCents)}/image
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="sm:col-span-2">
                <legend className="eyebrow">Methods</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(options?.methods ?? [])
                    .filter((entry) =>
                      form.category === "cards" ? entry.key !== "raw_art" : entry.key === "raw_art",
                    )
                    .filter((entry) =>
                      providerModels
                        .find((model) => model.id === form.model)
                        ?.methods.includes(entry.key),
                    )
                    .map((entry) => (
                      <label
                        key={entry.key}
                        className="chip cursor-pointer"
                        data-active={form.methods.includes(entry.key)}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={form.methods.includes(entry.key)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              methods: event.target.checked
                                ? [...new Set([...form.methods, entry.key])]
                                : form.methods.filter((method) => method !== entry.key),
                            })
                          }
                        />
                        {entry.label}
                      </label>
                    ))}
                </div>
              </fieldset>
              <label className="field">
                <span>Candidates</span>
                <Input
                  type="number"
                  min={form.category === "cards" ? 2 : 1}
                  max={8}
                  value={form.candidateCount}
                  onChange={(event) =>
                    setForm({ ...form, candidateCount: Number(event.target.value) || 1 })
                  }
                />
              </label>
              <label className="field">
                <span>Audience</span>
                <select
                  className="select"
                  value={form.audience}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      audience: event.target.value as "private" | "members" | "public",
                    })
                  }
                >
                  <option value="private">Private</option>
                  <option value="members">Members</option>
                  <option value="public">Public · Super Admin approval required</option>
                </select>
              </label>
              <label className="field">
                <span>Per-brief ceiling · US$</span>
                <Input
                  type="number"
                  min={0.5}
                  max={(options?.max_cap_cents ?? 2000) / 100}
                  step={0.5}
                  value={form.costCapCents / 100}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      costCapCents: Math.round((Number(event.target.value) || 0) * 100),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>References · one path per line</span>
                <Textarea
                  className="min-h-16"
                  value={form.references}
                  onChange={(event) => setForm({ ...form, references: event.target.value })}
                  placeholder="/art/backgrounds/doki-doki-literature-club.webp"
                />
              </label>
              <label className="field sm:col-span-2">
                <span>Notes for the runner</span>
                <Textarea
                  className="min-h-16"
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                  placeholder="Source pack, identity anchors or an exclusion."
                />
              </label>
            </div>
          </details>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--line)] pt-3">
            <p className="hidden text-xs text-[var(--muted)] sm:block">
              Whole-card AI is production. Scene and texture compare the renderer.
            </p>
            <Button
              onClick={() => void createBrief()}
              disabled={
                busy === "create" ||
                !form.title.trim() ||
                form.intent.trim().length < 12 ||
                !form.methods.length ||
                (form.category === "cards" && (!form.collectionId || !form.cardId))
              }
            >
              {busy === "create" ? "Creating…" : "Create brief"}
            </Button>
          </div>
        </section>
      ) : null}

      {!detail ? (
        <section className="artlab-wall mt-4">
          {categoryBriefs.length ? (
            <div className="artlab-boards" aria-label="Briefs">
              {categoryBriefs.map((brief) => (
                <button
                  key={brief.id}
                  type="button"
                  onClick={() => {
                    setPendingCandidateId("");
                    setSelectedBriefId(brief.id);
                  }}
                  className="chip max-w-[260px] shrink-0"
                  data-active={selectedBriefId === brief.id}
                >
                  <span className="truncate">{brief.title}</span>
                  <span className="text-[var(--muted)]">{brief.candidate_total}</span>
                  {brief.pending_count ? (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-[var(--signal)]"
                      aria-label="Pending"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {showStyleRail ? <StyleRail value={styleFilter} onChange={setStyleFilter} /> : null}

          {categoryPins.length ? (
            <div className="proof-grid">
              {categoryPins.map((pin) => (
                <button
                  key={pin.candidate_id}
                  type="button"
                  onClick={() => openPin(pin)}
                  className="proof-pin"
                >
                  <span className="proof-pin__object">
                    <img
                      src={pin.image_url}
                      alt={`${pin.card_name ?? pin.brief_title} · ${pin.label}`}
                      width={pin.width}
                      height={pin.height}
                      loading="lazy"
                    />
                    <span className="proof-pin__status">{statusLabel(pin.status)}</span>
                    <span className="proof-pin__method">
                      {pin.method === "whole_card" ? "AI" : "CMP"}
                    </span>
                  </span>
                  <span className="proof-pin__caption">
                    <span className="proof-pin__name">{pin.card_name ?? pin.brief_title}</span>
                    <span className="proof-pin__meta">
                      {[
                        pin.collection_name ?? "Brand",
                        pin.style_key
                          ? (CARD_STYLE_LABEL[pin.style_key] ?? pin.style_key)
                          : "Unstyled",
                        pin.label,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">
              <div>
                <p className="font-mono text-[0.62rem] tracking-[0.12em] uppercase">
                  {activeStyleLabel} · no cards yet
                </p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  {allCategoryPins.length
                    ? "No card in this style yet."
                    : "Create a brief, then queue the first generation run."}
                </p>
                {canWrite ? (
                  <Button className="mt-3" size="sm" onClick={() => setShowNew(true)}>
                    Create a brief
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="artlab-detail mt-4 min-w-0">
          <button
            type="button"
            className="font-mono text-[0.6rem] tracking-[0.1em] text-[var(--muted)] uppercase underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--signal)]"
            onClick={() => {
              setSelectedBriefId("");
              setDetail(null);
            }}
          >
            ← All briefs
          </button>

          <header className="brief-head">
            <div className="brief-head__copy">
              <h3>{detail.brief.title}</h3>
              <p className="brief-head__meta">
                {[
                  detail.brief.styles.length
                    ? detail.brief.styles
                        .map((style) => CARD_STYLE_LABEL[style] ?? style)
                        .join(" + ")
                    : null,
                  detail.target_variant
                    ? finishLabel(
                        detail.target_variant.material_key,
                        detail.target_variant.effect_key,
                      )
                    : detail.brief.category === "cards"
                      ? "First finish"
                      : CATEGORY_LABELS[detail.brief.category],
                  detail.brief.model,
                  statusLabel(detail.brief.status),
                  `${money(detail.brief.spend_cents)} / ${money(detail.brief.cost_cap_cents)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => void generate()}
              disabled={
                busy === "generate" ||
                !detail.permissions.write ||
                detail.jobs.some((job) => job.status === "queued" || job.status === "running")
              }
            >
              {busy === "generate" ? "Queueing…" : "Generate"}
            </Button>
          </header>

          <details className="brief-intent">
            <summary>
              Brief · {detail.brief.provider} / {detail.brief.model} · {detail.brief.audience}
            </summary>
            <p>{detail.brief.intent}</p>
            <div className="brief-intent__jobs">
              {detail.jobs.length ? (
                detail.jobs.map((job) => (
                  <span key={job.id} className="brief-intent__job">
                    <span className={STATUS_TONE[job.status] ?? ""}>{job.status}</span>
                    <span>
                      {job.method.replaceAll("_", " ")}
                      {job.style_key
                        ? ` · ${CARD_STYLE_LABEL[job.style_key] ?? job.style_key}`
                        : ""}{" "}
                      · {job.count} · {money(job.cost_actual_cents ?? job.cost_estimate_cents)}
                    </span>
                    {["queued", "running"].includes(job.status) && detail.permissions.write ? (
                      <button
                        type="button"
                        className="text-[var(--muted)] hover:text-[var(--oxblood)]"
                        onClick={() => void cancelJob(job)}
                        aria-label="Cancel job"
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))
              ) : (
                <span className="text-[var(--muted)]">No generation queued</span>
              )}
            </div>
            {detail.jobs.some((job) => job.error) ? (
              <div className="brief-intent__errors">
                {detail.jobs
                  .filter((job) => job.error)
                  .map((job) => (
                    <p key={job.id}>
                      {job.method.replaceAll("_", " ")}: {job.error}
                    </p>
                  ))}
              </div>
            ) : null}
          </details>

          {showStyleRail ? <StyleRail value={styleFilter} onChange={setStyleFilter} /> : null}

          <div className="artlab-filters">
            <select
              className="select h-8 text-xs"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter by status"
            >
              <option value="all">All statuses</option>
              {[
                "generated",
                "shortlisted",
                "needs_revision",
                "rejected",
                "approved",
                "published",
              ].map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
            <select
              className="select h-8 text-xs"
              value={methodFilter}
              onChange={(event) => setMethodFilter(event.target.value)}
              aria-label="Filter by method"
            >
              <option value="all">All methods</option>
              {detail.brief.methods.map((method) => (
                <option key={method} value={method}>
                  {method.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <select
              className="select h-8 text-xs"
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              aria-label="Filter by model"
            >
              <option value="all">All models</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <select
              className="select h-8 text-xs"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              aria-label="Filter by feedback"
            >
              <option value="all">All feedback</option>
              {(options?.tags ?? []).map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <span className="artlab-filters__count">
              {filteredCandidates.length} shown · {compareIds.length} compare
            </span>
          </div>

          {compareCandidates.length ? (
            <section className="notice mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[0.58rem] tracking-[0.1em] uppercase">Compare</span>
                {(
                  [750, 400, ...(detail.brief.category === "cards" ? [214] : []), 128] as const
                ).map((size) => (
                  <button
                    key={size}
                    type="button"
                    className="chip"
                    data-active={compareSize === size}
                    onClick={() => setCompareSize(size as 750 | 400 | 214 | 128)}
                  >
                    {size}px{size === 214 ? " · Discord cap" : ""}
                  </button>
                ))}
                <button
                  type="button"
                  className="ml-auto font-mono text-[0.58rem] tracking-[0.08em] uppercase underline underline-offset-4"
                  onClick={() => setCompareIds([])}
                >
                  Clear
                </button>
              </div>
              <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
                {compareCandidates.map((candidate) => (
                  <figure key={candidate.id} className="shrink-0 text-center">
                    <img
                      src={candidateImage(candidate)}
                      alt={`${candidate.label} at ${compareSize} pixels`}
                      className="mx-auto bg-[var(--paper-2)] object-contain"
                      style={{
                        width: compareSize,
                        maxWidth: "none",
                        height:
                          detail.brief.category === "cards"
                            ? Math.round((compareSize * 7) / 5)
                            : "auto",
                      }}
                    />
                    <figcaption className="mt-1 font-mono text-[0.55rem] tracking-[0.08em] text-[var(--muted)] uppercase">
                      {candidate.label} · {candidate.method_label}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}

          <div className="artlab-review">
            <div className="min-w-0">
              {detailLoading ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="skeleton h-80 rounded-[3px]" />
                  <div className="skeleton h-80 rounded-[3px]" />
                  <div className="skeleton h-80 rounded-[3px]" />
                </div>
              ) : filteredCandidates.length ? (
                <div
                  ref={gridRef}
                  className="candidate-grid"
                  onKeyDown={onGridKeyDown}
                  aria-label="Candidate contact sheet"
                  data-card-grid
                >
                  {filteredCandidates.map((candidate) => (
                    <article
                      key={candidate.id}
                      className="candidate-tile"
                      data-active={selectedCandidateId === candidate.id}
                    >
                      <div className="candidate-tile__top">
                        <label>
                          <input
                            type="checkbox"
                            checked={compareIds.includes(candidate.id)}
                            onChange={() => toggleCompare(candidate.id)}
                            aria-label={`Select ${candidate.label} for comparison`}
                          />
                          <span>{candidate.label}</span>
                        </label>
                        <span className={STATUS_TONE[candidate.status] ?? ""}>
                          {statusLabel(candidate.status)}
                        </span>
                      </div>
                      <button
                        type="button"
                        data-candidate-card
                        onClick={() => openCandidateViewer(candidate)}
                        className="candidate-tile__view"
                        aria-label={`Open ${candidate.label} full size`}
                      >
                        <img
                          src={candidateImage(candidate)}
                          alt={`${candidate.label} · ${candidate.method_label}`}
                          width={candidate.display_width}
                          height={candidate.display_height}
                          loading="lazy"
                        />
                      </button>
                      <div className="candidate-tile__meta">
                        <span>
                          {candidate.style_label ??
                            (candidate.style_key
                              ? (CARD_STYLE_LABEL[candidate.style_key] ?? candidate.style_key)
                              : "No style")}
                        </span>
                        <span>
                          {candidate.method === "whole_card" ? "Whole-card AI" : "Composed"}
                        </span>
                        <span>
                          {candidate.display_width}×{candidate.display_height}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <div>
                    <p className="font-mono text-[0.62rem] tracking-[0.12em] uppercase">
                      No candidates to show
                    </p>
                    <p className="mt-2 max-w-md text-sm">
                      {candidates.length
                        ? "No candidate matches the current filters."
                        : "Queue generation to fill the review board with real options."}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <aside className="artlab-panel">
              {selectedCandidate ? (
                <CandidatePanel
                  candidate={selectedCandidate}
                  detail={detail}
                  options={options}
                  variantOptions={variantOptions}
                  permissions={detail.permissions}
                  busy={busy}
                  feedbackTags={feedbackTags}
                  setFeedbackTags={setFeedbackTags}
                  feedbackBody={feedbackBody}
                  setFeedbackBody={setFeedbackBody}
                  approvalUsage={approvalUsage}
                  setApprovalUsage={setApprovalUsage}
                  approvalNotes={approvalNotes}
                  setApprovalNotes={setApprovalNotes}
                  vectorRef={vectorRef}
                  setVectorRef={setVectorRef}
                  onFeedback={candidateFeedback}
                  onApprove={approve}
                  onRollback={rollback}
                  publishOpen={publishOpen}
                  setPublishOpen={setPublishOpen}
                  publishVariantId={publishVariantId}
                  setPublishVariantId={setPublishVariantId}
                  publishConfirmation={publishConfirmation}
                  setPublishConfirmation={setPublishConfirmation}
                  publishNotes={publishNotes}
                  setPublishNotes={setPublishNotes}
                  publishBack={publishBack}
                  setPublishBack={setPublishBack}
                  onPublish={publish}
                />
              ) : (
                <div className="panel p-4">
                  <p className="eyebrow">Candidate</p>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
                    Open a card to inspect it full size. Select one to leave feedback, approve a
                    direction or publish it.
                  </p>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

function StyleRail({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="style-rail" role="group" aria-label="Filter by card style">
      <button
        type="button"
        className="style-rail__all"
        data-active={value === "all"}
        onClick={() => onChange("all")}
        aria-pressed={value === "all"}
      >
        All
      </button>
      {CARD_STYLES.map((style) => (
        <button
          key={style.key}
          type="button"
          className="style-rail__item"
          data-active={value === style.key}
          aria-pressed={value === style.key}
          onClick={() => onChange(value === style.key ? "all" : style.key)}
          title={style.note}
        >
          <img src={style.thumb} alt="" width={480} height={480} loading="lazy" />
          <span>{style.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="style-rail__all style-rail__unstyled"
        data-active={value === "unstyled"}
        aria-pressed={value === "unstyled"}
        onClick={() => onChange(value === "unstyled" ? "all" : "unstyled")}
        title="Cards generated before the style catalogue"
      >
        Unstyled
      </button>
    </div>
  );
}

function CandidatePanel(props: {
  candidate: Candidate;
  detail: BriefDetail;
  options: OptionsData | null;
  variantOptions: Array<{
    id: string;
    name: string;
    material_key: string;
    effect_key: string | null;
    editionName: string;
  }>;
  permissions: Permissions;
  busy: string;
  feedbackTags: FeedbackTag[];
  setFeedbackTags: (tags: FeedbackTag[]) => void;
  feedbackBody: string;
  setFeedbackBody: (value: string) => void;
  approvalUsage: string;
  setApprovalUsage: (value: string) => void;
  approvalNotes: string;
  setApprovalNotes: (value: string) => void;
  vectorRef: string;
  setVectorRef: (value: string) => void;
  onFeedback: (decision: "comment" | "shortlist" | "needs_revision" | "reject") => void;
  onApprove: () => void;
  onRollback: () => void;
  publishOpen: boolean;
  setPublishOpen: (open: boolean) => void;
  publishVariantId: string;
  setPublishVariantId: (value: string) => void;
  publishConfirmation: string;
  setPublishConfirmation: (value: string) => void;
  publishNotes: string;
  setPublishNotes: (value: string) => void;
  publishBack: boolean;
  setPublishBack: (value: boolean) => void;
  onPublish: () => void;
}) {
  const {
    candidate,
    detail,
    permissions,
    busy,
    feedbackTags,
    setFeedbackTags,
    feedbackBody,
    setFeedbackBody,
    approvalUsage,
    setApprovalUsage,
    approvalNotes,
    setApprovalNotes,
    vectorRef,
    setVectorRef,
    publishOpen,
    setPublishOpen,
    publishVariantId,
    setPublishVariantId,
    publishConfirmation,
    setPublishConfirmation,
    publishNotes,
    setPublishNotes,
    publishBack,
    setPublishBack,
    onFeedback,
    onApprove,
    onPublish,
    onRollback,
  } = props;
  const approved = Boolean(candidate.approval);
  const published = Boolean(candidate.approval?.published_at && !candidate.approval.rollback_at);
  const isPublic = detail.brief.audience === "public";
  const canApprove = permissions.write && (!isPublic || permissions.approve_public);
  const isLogo = detail.brief.category === "logo";
  const tags = props.options?.tags ?? [];

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold">{candidate.label}</p>
          <p className="mt-1 font-mono text-[0.56rem] tracking-[0.08em] text-[var(--muted)] uppercase">
            {candidate.style_label ?? "No style"} · {candidate.method_label} ·{" "}
            {statusLabel(candidate.status)}
          </p>
        </div>
        <a
          className="font-mono text-[0.58rem] tracking-[0.08em] uppercase underline underline-offset-4"
          href={candidate.files.download}
        >
          Download
        </a>
      </div>

      <figure className="mt-3 border border-[var(--line)] bg-[var(--paper-2)] p-2">
        <img
          src={candidateImage(candidate)}
          alt={`${candidate.label} · ${candidate.method_label}`}
          className="mx-auto block max-h-[560px] w-auto max-w-full object-contain"
        />
        <figcaption className="mt-2 text-center font-mono text-[0.55rem] tracking-[0.08em] text-[var(--muted)] uppercase">
          {methodNote(candidate)}
        </figcaption>
      </figure>
      {candidate.files.reference ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          <a
            href={candidate.files.reference}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            Reference sheet used ↗
          </a>{" "}
          · real subject, supplied mark and exact copy
        </p>
      ) : null}
      {exactCopyFromPrompt(candidate.prompt) ? (
        <details className="candidate-copy mt-2">
          <summary>Exact copy used</summary>
          <pre>{exactCopyFromPrompt(candidate.prompt)}</pre>
        </details>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Fact label="Style" value={candidate.style_label ?? "—"} />
        <Fact
          label="Finish"
          value={
            detail.target_variant
              ? finishLabel(detail.target_variant.material_key, detail.target_variant.effect_key)
              : "—"
          }
        />
        <Fact label="Method" value={candidate.method_label} />
        <Fact label="Model" value={candidate.model} />
        <Fact label="Dimensions" value={`${candidate.width} × ${candidate.height}`} />
        <Fact label="Seed" value={candidate.seed ?? "—"} />
        <Fact label="Audience" value={candidate.audience} />
        <Fact label="Official" value={candidate.official ? "yes" : "no"} />
        <Fact label="SHA-256" value={shortHash(candidate.sha256)} mono />
        <Fact
          label="Cost"
          value={`${money(Number(candidate.metadata.cost_estimate_cents ?? 0))} estimate`}
        />
      </dl>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-mono text-[0.58rem] tracking-[0.08em] text-[var(--muted)] uppercase">
          Prompt and provenance
        </summary>
        <p className="mt-2 font-mono text-[0.65rem] leading-relaxed break-words whitespace-pre-wrap text-[var(--muted)]">
          {candidate.prompt}
        </p>
      </details>

      {candidate.feedback.length ? (
        <section className="mt-4 border-t border-[var(--line)] pt-3">
          <p className="font-mono text-[0.56rem] tracking-[0.08em] text-[var(--muted)] uppercase">
            Thread · {candidate.feedback.length}
          </p>
          <ol className="mt-2 grid gap-2">
            {candidate.feedback.map((entry) => (
              <li key={entry.id} className="border-l-2 border-[var(--line-strong)] pl-2 text-xs">
                <div className="flex flex-wrap gap-2 font-mono text-[0.55rem] tracking-[0.08em] text-[var(--muted)] uppercase">
                  <span>{entry.decision.replaceAll("_", " ")}</span>
                  <span>{new Date(entry.created_at).toLocaleString()}</span>
                </div>
                {entry.tags.length ? (
                  <p className="mt-1 font-mono text-[0.55rem] tracking-[0.08em] text-[var(--signal)] uppercase">
                    {entry.tags.join(" · ")}
                  </p>
                ) : null}
                {entry.body ? <p className="mt-1 leading-relaxed">{entry.body}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {candidate.status !== "published" ? (
        <section className="mt-4 border-t border-[var(--line)] pt-3">
          <p className="font-mono text-[0.56rem] tracking-[0.08em] text-[var(--muted)] uppercase">
            Feedback
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="chip"
                data-active={feedbackTags.includes(tag)}
                onClick={() =>
                  setFeedbackTags(
                    feedbackTags.includes(tag)
                      ? feedbackTags.filter((entry) => entry !== tag)
                      : [...feedbackTags, tag],
                  )
                }
              >
                {tag}
              </button>
            ))}
          </div>
          <Textarea
            className="mt-2 min-h-20"
            value={feedbackBody}
            onChange={(event) => setFeedbackBody(event.target.value)}
            placeholder="What is wrong, what must stay, and what should the next direction try?"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!permissions.write || busy === "feedback"}
              onClick={() => onFeedback("comment")}
            >
              Add note
            </Button>
            {!approved ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!permissions.write || busy === "feedback"}
                  onClick={() => onFeedback("shortlist")}
                >
                  Shortlist
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!permissions.write || busy === "feedback"}
                  onClick={() => onFeedback("needs_revision")}
                >
                  Needs revision
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="danger"
              disabled={!permissions.write || busy === "feedback"}
              onClick={() => onFeedback("reject")}
            >
              Reject
            </Button>
          </div>
        </section>
      ) : null}

      <section className="mt-4 border-t border-[var(--line)] pt-3">
        <p className="font-mono text-[0.56rem] tracking-[0.08em] text-[var(--muted)] uppercase">
          Decision
        </p>
        {approved ? (
          <p className="mt-2 text-xs leading-relaxed text-[var(--green)]">
            Approved for {candidate.approval?.usage}.{" "}
            {published ? "Published; rollback is available." : "Publish makes it live."}
          </p>
        ) : (
          <p className="mt-1 text-[0.65rem] text-[var(--muted)]">
            Approve first; publish is separate.
          </p>
        )}
        {!approved && candidate.status !== "rejected" ? (
          <div className="mt-2 grid gap-2">
            <label className="field">
              <span>Usage</span>
              <Input
                value={approvalUsage}
                onChange={(event) => setApprovalUsage(event.target.value)}
                placeholder="Card front · collection"
              />
            </label>
            <Textarea
              className="min-h-16"
              value={approvalNotes}
              onChange={(event) => setApprovalNotes(event.target.value)}
              placeholder="Why this direction wins; what is still a limit."
            />
            {isLogo ? (
              <label className="field">
                <span>Vector source · required for logo approval</span>
                <Input
                  value={vectorRef}
                  onChange={(event) => setVectorRef(event.target.value)}
                  placeholder="/brand/kit/approved/logo.svg or https://…"
                />
              </label>
            ) : null}
            {isPublic && !permissions.approve_public ? (
              <p className="notice text-xs">Only the Super Admin can approve a public direction.</p>
            ) : null}
            <Button
              size="sm"
              disabled={!canApprove || busy === "approve" || approvalUsage.trim().length < 3}
              onClick={onApprove}
            >
              {busy === "approve" ? "Approving…" : "Approve direction"}
            </Button>
          </div>
        ) : null}
        {candidate.status === "rejected" ? (
          <p className="mt-2 text-xs leading-relaxed text-[var(--oxblood)]">
            This direction is rejected. Generate a new candidate set or revise the brief; there is
            no silent re-roll.
          </p>
        ) : null}

        {approved && !published ? (
          <div className="mt-3 border-t border-[var(--line)] pt-3">
            {publishOpen ? (
              <div className="grid gap-2">
                <p className="text-xs leading-relaxed text-[var(--muted)]">
                  Current live render:{" "}
                  <span className="font-mono">
                    {detail.current_render ? shortHash(detail.current_render.sha256) : "none"}
                  </span>
                  {detail.current_render?.published_at
                    ? ` · ${new Date(detail.current_render.published_at).toLocaleString()}`
                    : ""}
                </p>
                {detail.current_render ? (
                  <img
                    src={detail.current_render.public_url}
                    alt="Current live card render"
                    className="max-h-40 w-auto border border-[var(--line)] bg-[var(--paper-2)] object-contain"
                  />
                ) : null}
                {detail.brief.category === "cards" ? (
                  <label className="field">
                    <span>Target variant</span>
                    <select
                      className="select"
                      value={publishVariantId}
                      onChange={(event) => setPublishVariantId(event.target.value)}
                    >
                      <option value="">Choose a variant</option>
                      {props.variantOptions.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.name} · {variant.material_key}
                          {variant.effect_key ? ` / ${variant.effect_key}` : ""} ·{" "}
                          {variant.editionName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {detail.brief.category === "cards" && candidate.render_back_asset_id ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={publishBack}
                      onChange={(event) => setPublishBack(event.target.checked)}
                    />
                    Publish the composed back too
                  </label>
                ) : null}
                <Textarea
                  className="min-h-16"
                  value={publishNotes}
                  onChange={(event) => setPublishNotes(event.target.value)}
                  placeholder="Publication note for the audit record."
                />
                <label className="field">
                  <span>Type PUBLISH to confirm</span>
                  <Input
                    value={publishConfirmation}
                    onChange={(event) => setPublishConfirmation(event.target.value)}
                    placeholder="PUBLISH"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={
                      publishConfirmation !== "PUBLISH" ||
                      busy === "publish" ||
                      (detail.brief.category === "cards" && !publishVariantId)
                    }
                    onClick={onPublish}
                  >
                    {busy === "publish" ? "Publishing…" : "Publish direction"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPublishOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={!permissions.publish}
                onClick={() => setPublishOpen(true)}
              >
                Publish this direction
              </Button>
            )}
          </div>
        ) : null}

        {published ? (
          <div className="mt-3 border-t border-[var(--line)] pt-3">
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              Published{" "}
              {candidate.approval?.published_at
                ? new Date(candidate.approval.published_at).toLocaleString()
                : ""}
              . Target: {candidate.approval?.target_kind} · {candidate.approval?.target_id}.
            </p>
            <Button size="sm" variant="danger" className="mt-2" onClick={onRollback}>
              Roll back publication
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[0.52rem] tracking-[0.08em] text-[var(--muted)] uppercase">
        {label}
      </dt>
      <dd className={`mt-0.5 break-words ${mono ? "font-mono text-[0.6rem]" : ""}`}>{value}</dd>
    </div>
  );
}
