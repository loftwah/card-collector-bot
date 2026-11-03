"use client";

import { useEffect, useState } from "react";
import { Bot, Copy, Pause, Pencil, Play, Plus, RotateCcw, ShieldAlert, Sparkles, Users } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

interface NpcPreset {
  key: string;
  label: string;
  description: string;
  behaviour: string;
}

interface NpcItem {
  id: string;
  name: string;
  slug: string;
  preset_key: string;
  preset_label: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  goals: { collection_id?: string | null; pool_slug?: string | null; preset_goal?: string };
  schedule: { enabled?: boolean; interval_minutes?: number };
  actions_count: number;
  last_action_at: string | null;
  synthetic_label: string;
  cards: number;
  subjects: number;
  gold: number;
  holographic: number;
  balance: number;
}

interface Overview {
  items: NpcItem[];
  presets: NpcPreset[];
  limits: { max_npcs: number; max_draws_per_day: number; paused_all: number };
  action_counts: Record<string, number>;
  cap: { max_batch: number; synthetic_label: string };
}

interface Collection {
  id: string;
  name: string;
}

interface ActionRow {
  id: string;
  status: string;
  reason: string | null;
  pool_slug: string | null;
  amount: number;
  created_at: string;
  after: { card_name?: string; variant_name?: string; serial?: string; balance_after?: number };
}

export default function NpcStudio() {
  const [data, setData] = useState<Overview | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [name, setName] = useState("");
  const [presetKey, setPresetKey] = useState("rookie");
  const [goalCollectionId, setGoalCollectionId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<{ npc: NpcItem; actions: ActionRow[] } | null>(null);
  const [editing, setEditing] = useState<NpcItem | null>(null);
  const [edit, setEdit] = useState({ name: "", bio: "", presetKey: "rookie", goalCollectionId: "", poolSlug: "", scheduleEnabled: false, intervalMinutes: 1440 });

  async function load() {
    try {
      const [overview, collectionList] = await Promise.all([
        api<Overview>("/api/v1/npcs/admin"),
        api<{ items: Collection[] }>("/api/v1/collections"),
      ]);
      setData(overview);
      setCollections(collectionList.items.filter((item) => "name" in item));
      if (!overview.presets.some((preset) => preset.key === presetKey)) setPresetKey(overview.presets[0]?.key ?? "rookie");
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(path: string, method: string, body?: unknown, key = path) {
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

  async function create() {
    const created = await act("/api/v1/npcs", "POST", {
      name,
      presetKey,
      goalCollectionId: goalCollectionId || null,
    }, "create");
    if (created) {
      setNotice(`${name} created with a real wallet and no invented history.`);
      setName("");
      await load();
    }
  }

  async function play(npc: NpcItem) {
    const result = await act(`/api/v1/npcs/${npc.id}/play`, "POST", {}, `play-${npc.id}`);
    if (result) {
      const receipt = result.receipt as { card_name?: string; serial?: string } | undefined;
      setNotice(`${npc.name} opened a real capsule: ${receipt?.card_name ?? "a card"}${receipt?.serial ? ` · ${receipt.serial}` : ""}.`);
      await load();
    }
  }

  async function batch(npc: NpcItem) {
    const result = await act(`/api/v1/npcs/${npc.id}/run`, "POST", { count: 3 }, `run-${npc.id}`);
    if (result) {
      const results = result.results as Array<{ status: string; receipt?: { card_name?: string } }>;
      setNotice(`${npc.name}: ${results.filter((item) => item.status === "completed").length} real draws completed, then stopped at the first limit.`);
      await load();
    }
  }

  async function preview(npc: NpcItem) {
    const result = await act(`/api/v1/npcs/${npc.id}/preview`, "POST", {}, `preview-${npc.id}`);
    if (result) {
      setNotice(result.allowed
        ? `${npc.name} would draw from ${String(result.pool_name)} at ${String(result.price)} Foil (${String(result.eligible_count)} eligible).`
        : `${npc.name} cannot act: ${String(result.reason)}`);
    }
  }

  async function lifecycle(npc: NpcItem, action: "pause" | "resume" | "retire") {
    const result = await act(`/api/v1/npcs/${npc.id}/${action}`, "POST", {}, `${action}-${npc.id}`);
    if (result) {
      setNotice(`${npc.name} is now ${action === "retire" ? "retired" : action === "pause" ? "paused" : "active"}.`);
      await load();
    }
  }

  async function openDetail(npc: NpcItem) {
    setBusy(`detail-${npc.id}`);
    setError("");
    try {
      const actions = await api<{ items: ActionRow[] }>(`/api/v1/npcs/${npc.id}/actions`);
      setDetail({ npc, actions: actions.items });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  function beginEdit(npc: NpcItem) {
    setEditing(npc);
    setEdit({
      name: npc.name,
      bio: npc.bio,
      presetKey: npc.preset_key,
      goalCollectionId: npc.goals.collection_id ?? "",
      poolSlug: npc.goals.pool_slug ?? "",
      scheduleEnabled: Boolean(npc.schedule.enabled),
      intervalMinutes: Number(npc.schedule.interval_minutes ?? 1440),
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const result = await act(`/api/v1/npcs/${editing.id}`, "PATCH", {
      name: edit.name,
      bio: edit.bio,
      presetKey: edit.presetKey,
      goalCollectionId: edit.goalCollectionId || null,
      poolSlug: edit.poolSlug || null,
      scheduleEnabled: edit.scheduleEnabled,
      intervalMinutes: edit.intervalMinutes,
    }, "edit");
    if (result) {
      setNotice(`${edit.name} updated. Its existing cards and history are unchanged.`);
      setEditing(null);
      await load();
    }
  }

  async function clone(npc: NpcItem) {
    const result = await act("/api/v1/npcs", "POST", {
      name: `${npc.name} II`,
      presetKey: npc.preset_key,
      bio: npc.bio,
      avatarUrl: npc.avatar_url,
      goalCollectionId: npc.goals.collection_id ?? null,
      poolSlug: npc.goals.pool_slug ?? null,
    }, `clone-${npc.id}`);
    if (result) {
      setNotice(`${npc.name} cloned as a new collector with its own wallet. No cards or history were copied.`);
      await load();
    }
  }

  async function saveLimits(patch: Record<string, unknown>) {
    const result = await act("/api/v1/npcs/limits", "PATCH", patch, "limits");
    if (result) await load();
  }

  if (!data) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-40 w-full" />
        {error ? <div className="error-box" role="alert">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {notice ? <div className="success-box" role="status">{notice}</div> : null}

      <section className="border border-[var(--line)] bg-[var(--paper-2)]/50 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">NPC collectors</p>
            <h2 className="display-sm mt-1 text-3xl uppercase">A populated cabinet, honestly labelled.</h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">NPCs are persistent synthetic game actors with real wallets, serials, draws, achievements and ledger entries. They never sign in, never appear as Discord members and never claim a human biography.</p>
          </div>
          <span className="badge badge-signal"><Bot size={13} /> {data.cap.synthetic_label}</span>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <div className="studio-stat"><p className="studio-stat__label">NPCs</p><p className="studio-stat__value">{data.items.length}</p></div>
          <div className="studio-stat"><p className="studio-stat__label">Completed actions</p><p className="studio-stat__value">{data.action_counts.completed ?? 0}</p></div>
          <div className="studio-stat"><p className="studio-stat__label">Skipped safely</p><p className="studio-stat__value">{data.action_counts.skipped ?? 0}</p></div>
          <div className="studio-stat"><p className="studio-stat__label">Daily cap</p><p className="studio-stat__value">{data.limits.max_draws_per_day}</p></div>
        </div>
      </section>

      <section className="surface-flat p-5">
        <div className="flex items-center gap-2"><Plus size={16} className="text-[var(--teal)]" /><p className="eyebrow">Create one collector</p></div>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <label className="text-xs font-semibold">Display name<Input className="mt-1" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Nova Ledger" /></label>
          <label className="text-xs font-semibold">Preset<select className="select mt-1 w-full" value={presetKey} onChange={(event) => setPresetKey(event.target.value)}>{data.presets.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}</select></label>
          <label className="text-xs font-semibold">Focus collection<select className="select mt-1 w-full" value={goalCollectionId} onChange={(event) => setGoalCollectionId(event.target.value)}><option value="">Any eligible collection</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label>
          <Button onClick={create} disabled={busy === "create" || name.trim().length < 2}>{busy === "create" ? "Creating…" : "Create NPC"}</Button>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">{data.presets.find((preset) => preset.key === presetKey)?.behaviour}</p>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--line)] pb-3">
          <div><h3 className="display-sm text-2xl uppercase">The cast</h3><p className="mt-1 text-sm text-[var(--muted)]">Every action is bounded, idempotent and recorded before the card is revealed.</p></div>
          <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={Boolean(data.limits.paused_all)} onChange={(event) => saveLimits({ pausedAll: event.target.checked })} /> Pause every NPC on this Bot</label>
        </div>
        {data.items.length === 0 ? (
          <div className="empty mt-4"><div><p className="display-sm text-2xl">No NPC collectors yet.</p><p className="mt-2 text-sm">Create one above. It receives the ordinary starter allowance and must use the same pools and odds as a human member.</p></div></div>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {data.items.map((npc) => (
              <article key={npc.id} className="border border-[var(--line)] bg-[var(--paper)] p-4">
                <div className="flex items-start gap-3">
                  {npc.avatar_url ? <img src={npc.avatar_url} alt="" width="56" height="56" className="h-14 w-14 border border-[var(--line)] object-cover" /> : <span className="grid h-14 w-14 place-items-center bg-[var(--ink)] font-display text-xl text-[var(--paper)]" aria-hidden="true">{npc.name.slice(0, 2).toUpperCase()}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{npc.name}</p>
                      <span className="badge">NPC</span>
                      <span className={npc.status === "active" ? "badge badge-signal" : "badge"}>{npc.status}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">{npc.preset_label} · {npc.bio}</p>
                    <p className="mt-1 font-mono text-[0.56rem] uppercase tracking-[0.08em] text-[var(--muted)]">{npc.subjects} subjects · {npc.cards} copies · {npc.gold} Gold · {npc.holographic} Holographic · {npc.balance} Foil</p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">{npc.actions_count} completed actions{npc.last_action_at ? ` · last ${new Date(npc.last_action_at).toLocaleString("en-AU")}` : " · never played"}{npc.schedule.enabled ? ` · every ${npc.schedule.interval_minutes} min` : " · manual only"}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => preview(npc)} disabled={busy === `preview-${npc.id}` || npc.status !== "active"}><Sparkles size={13} /> Preview next</Button>
                  <Button size="sm" onClick={() => play(npc)} disabled={busy === `play-${npc.id}` || npc.status !== "active"}><Play size={13} /> Play once</Button>
                  <Button size="sm" variant="secondary" onClick={() => batch(npc)} disabled={busy === `run-${npc.id}` || npc.status !== "active"}><Users size={13} /> Run 3</Button>
                  <Button size="sm" variant="ghost" onClick={() => openDetail(npc)} disabled={busy === `detail-${npc.id}`}>Receipts</Button>
                  <Button size="sm" variant="ghost" onClick={() => beginEdit(npc)} disabled={npc.status === "retired"}><Pencil size={13} /> Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => clone(npc)} disabled={busy === `clone-${npc.id}`}><Copy size={13} /> Clone</Button>
                  {npc.status === "active" ? <Button size="sm" variant="ghost" onClick={() => lifecycle(npc, "pause")} disabled={busy === `pause-${npc.id}`}><Pause size={13} /> Pause</Button> : npc.status === "paused" ? <Button size="sm" variant="ghost" onClick={() => lifecycle(npc, "resume")} disabled={busy === `resume-${npc.id}`}><RotateCcw size={13} /> Resume</Button> : null}
                  {npc.status !== "retired" ? <Button size="sm" variant="danger" onClick={() => lifecycle(npc, "retire")} disabled={busy === `retire-${npc.id}`}>Retire</Button> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="surface-flat p-5">
        <div className="flex items-center gap-2"><ShieldAlert size={16} className="text-[var(--oxblood)]" /><p className="eyebrow">Bounded controls</p></div>
        <p className="mt-2 text-sm text-[var(--muted)]">These limits apply before a draw is attempted. Reaching a limit records a skip and never charges, awards or retries unbounded.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 sm:items-end">
          <label className="text-xs font-semibold">Maximum NPCs<Input className="mt-1" type="number" min={0} max={100} defaultValue={data.limits.max_npcs} onBlur={(event) => saveLimits({ maxNpcs: Number(event.target.value) })} /></label>
          <label className="text-xs font-semibold">Draws per day (all NPCs)<Input className="mt-1" type="number" min={0} max={500} defaultValue={data.limits.max_draws_per_day} onBlur={(event) => saveLimits({ maxDrawsPerDay: Number(event.target.value) })} /></label>
          <Button variant="secondary" onClick={() => saveLimits({ pausedAll: false })}>Resume all</Button>
        </div>
      </section>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent>
          {editing ? (
            <>
              <DialogTitle>Edit {editing.name}</DialogTitle>
              <DialogDescription>Changes affect future behaviour only. Existing cards, serials, balances and receipts are preserved.</DialogDescription>
              <div className="mt-4 grid gap-3">
                <label className="text-xs font-semibold">Display name<Input className="mt-1" value={edit.name} maxLength={80} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></label>
                <label className="text-xs font-semibold">Bio<textarea className="mt-1 min-h-20 w-full border border-[var(--line)] bg-[var(--paper)] p-2 text-sm" maxLength={500} value={edit.bio} onChange={(event) => setEdit({ ...edit, bio: event.target.value })} /></label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold">Preset<select className="select mt-1 w-full" value={edit.presetKey} onChange={(event) => setEdit({ ...edit, presetKey: event.target.value })}>{data.presets.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}</select></label>
                  <label className="text-xs font-semibold">Focus collection<select className="select mt-1 w-full" value={edit.goalCollectionId} onChange={(event) => setEdit({ ...edit, goalCollectionId: event.target.value })}><option value="">Any eligible collection</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label>
                  <label className="text-xs font-semibold">Pool slug (optional)<Input className="mt-1" value={edit.poolSlug} placeholder="cabinet-draw" onChange={(event) => setEdit({ ...edit, poolSlug: event.target.value })} /></label>
                  <label className="text-xs font-semibold">Interval (minutes)<Input className="mt-1" type="number" min={15} max={10080} value={edit.intervalMinutes} onChange={(event) => setEdit({ ...edit, intervalMinutes: Number(event.target.value) })} /></label>
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={edit.scheduleEnabled} onChange={(event) => setEdit({ ...edit, scheduleEnabled: event.target.checked })} /> Allow bounded scheduled progression</label>
                <div className="flex flex-wrap gap-2"><Button onClick={saveEdit} disabled={busy === "edit" || edit.name.trim().length < 2}>{busy === "edit" ? "Saving…" : "Save changes"}</Button><Button variant="ghost" onClick={() => setEditing(null)} disabled={busy === "edit"}>Cancel</Button></div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent>
          {detail ? (
            <>
              <DialogTitle>{detail.npc.name} · action receipts</DialogTitle>
              <DialogDescription>Real persisted actions for this NPC. Skipped and failed rows explain why no card or Foil moved.</DialogDescription>
              <div className="mt-4 grid max-h-[28rem] gap-2 overflow-auto">
                {detail.actions.map((action) => (
                  <div key={action.id} className="border border-[var(--line)] p-3 text-xs">
                    <p className="font-semibold">{action.status} · {action.pool_slug ?? "no pool"} · {action.amount} Foil</p>
                    <p className="mt-1 text-[var(--muted)]">{action.after.card_name ? `${action.after.card_name} · ${action.after.variant_name} · ${action.after.serial} · balance ${action.after.balance_after}` : action.reason ?? "No award recorded."}</p>
                    <p className="mt-1 font-mono text-[0.55rem] uppercase tracking-[0.08em] text-[var(--muted)]">{new Date(action.created_at).toLocaleString("en-AU")}</p>
                  </div>
                ))}
                {detail.actions.length === 0 ? <p className="text-sm text-[var(--muted)]">No actions yet.</p> : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
