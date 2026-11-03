"use client";

import { useEffect, useState } from "react";
import { Loader2, Medal, Plus } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/input";

interface Achievement {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: string;
  category: string;
  art_key: string;
  visibility: string;
  reward_amount: number;
  state: string;
}

interface Collection {
  id: string;
  slug: string;
  name: string;
}

export default function AchievementAdmin({ platformAdmin }: { platformAdmin: boolean }) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({
    scope: platformAdmin ? "platform" : "bot",
    key: "",
    name: "",
    description: "",
    type: "collection_unique",
    target: 5,
    collectionId: "",
    finish: "plain",
    foil: 240,
    artKey: "medal-collection",
    visibility: "member",
  });

  async function load() {
    try {
      const [achievements, collectionResult] = await Promise.all([
        api<{ items: Achievement[] }>("/api/v1/admin/achievements"),
        api<{ items: Collection[] }>("/api/v1/admin/collections"),
      ]);
      setItems(achievements.items);
      setCollections(collectionResult.items);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const criteria: Record<string, unknown> = { type: form.type, target: Number(form.target) };
      if (["collection_unique", "collection_complete", "collection_finish_set", "collection_core_set", "first_in_collection"].includes(form.type)) criteria.collection_id = form.collectionId;
      if (form.type === "collection_finish_set") criteria.finish = form.finish;
      await api("/api/v1/admin/achievements", {
        method: "POST",
        body: {
          scope: form.scope,
          key: form.key,
          name: form.name,
          description: form.description,
          criteria,
          reward: { foil: Number(form.foil) },
          visibility: form.visibility,
          artKey: form.artKey,
          category: "collection",
        },
      });
      setNotice("Achievement created. It is active immediately for eligible members.");
      setForm((current) => ({ ...current, key: "", name: "", description: "" }));
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr] xl:items-start">
      <section className="surface-flat p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--ink)] text-[var(--paper)]"><Medal size={20} /></span>
          <div><h2 className="display-sm text-3xl">Achievement library</h2><p className="text-sm text-[var(--muted)]">Versioned criteria, explicit rewards and the same audience rules as the underlying collection.</p></div>
        </div>
        <div className="mt-5 grid gap-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-3 border border-[var(--line)] p-3">
              <div className="min-w-0">
                <p className="font-semibold">{item.name}</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">{item.description}</p>
                <p className="mt-1 font-mono text-[0.54rem] uppercase tracking-[0.08em] text-[var(--muted)]">{item.scope} · {item.key} · {item.visibility}{item.reward_amount ? ` · ✦ ${item.reward_amount}` : ""}</p>
              </div>
              <span className="badge">{item.category}</span>
            </div>
          ))}
          {items.length === 0 ? <p className="text-sm text-[var(--muted)]">No achievements configured yet.</p> : null}
        </div>
      </section>

      <section className="surface p-5">
        <h3 className="display-sm text-2xl">Configure an achievement</h3>
        <p className="mt-1 text-sm text-[var(--muted)]">Adding cards later does not revoke a version already earned.</p>
        <div className="mt-4 grid gap-3">
          <Field label="Authority">
            <Select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>
              {platformAdmin ? <option value="platform">Platform achievement</option> : null}
              <option value="bot">This Bot only</option>
            </Select>
          </Field>
          <Field label="Key" hint="Stable lowercase identifier; a new rule needs a new version.">
            <Input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="nba-opening-five" />
          </Field>
          <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Opening five" /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Collect five subjects from this starter album." /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Criteria">
              <Select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                <option value="collection_unique">Collect unique subjects in a collection</option>
                <option value="collection_complete">Complete a collection roster</option>
                <option value="first_in_collection">First card in a collection</option>
                <option value="collection_finish_set">All of one finish in a collection</option>
                <option value="collection_core_set">All four core finishes for every subject</option>
                <option value="unique_cards">Collect unique subjects overall</option>
                <option value="finish_first">Find a finish</option>
                <option value="finish_set">Complete a core finish set</option>
                <option value="explore_collections">Explore collections</option>
              </Select>
            </Field>
            <Field label="Target"><Input type="number" min={1} value={form.target} onChange={(event) => setForm({ ...form, target: Number(event.target.value) })} /></Field>
          </div>
          {["collection_unique", "collection_complete", "collection_finish_set", "collection_core_set", "first_in_collection"].includes(form.type) ? (
            <Field label="Collection">
              <Select value={form.collectionId} onChange={(event) => setForm({ ...form, collectionId: event.target.value })}>
                <option value="">Choose a collection</option>
                {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {form.type === "collection_finish_set" ? (
            <Field label="Finish">
              <Select value={form.finish} onChange={(event) => setForm({ ...form, finish: event.target.value })}>
                <option value="plain">Plain</option>
                <option value="silver">Silver</option>
                <option value="gold">Gold</option>
                <option value="holographic">Holographic</option>
              </Select>
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Foil reward"><Input type="number" min={0} max={5000} value={form.foil} onChange={(event) => setForm({ ...form, foil: Number(event.target.value) })} /></Field>
            <Field label="Badge family">
              <Select value={form.artKey} onChange={(event) => setForm({ ...form, artKey: event.target.value })}>
                <option value="medal-collection">Collection hex</option>
                <option value="medal-first">First star</option>
                <option value="medal-shelf">Shelf</option>
                <option value="medal-silver">Silver diamond</option>
                <option value="medal-gold">Gold diamond</option>
                <option value="medal-holo">Holographic diamond</option>
                <option value="medal-compass">Compass</option>
                <option value="medal-parcel">Community parcel</option>
              </Select>
            </Field>
          </div>
          <Field label="Visibility">
            <Select value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}>
              <option value="member">Members who can access the collection</option>
              <option value="private">Administrators only</option>
              <option value="public">Public showcase (safe only)</option>
            </Select>
          </Field>
          {error ? <p className="error-box" role="alert">{error}</p> : null}
          {notice ? <p className="success-box" role="status">{notice}</p> : null}
          <Button onClick={create} disabled={busy !== "" || form.name.length < 2 || form.key.length < 2 || form.description.length < 2 || (["collection_unique", "collection_complete", "collection_finish_set", "collection_core_set", "first_in_collection"].includes(form.type) && !form.collectionId)}>
            {busy === "create" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Create achievement
          </Button>
        </div>
      </section>
    </div>
  );
}
