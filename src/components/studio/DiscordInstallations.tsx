"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

type Collection = { id: string; name: string; enabled: boolean; status: string };
type Installation = { id: string; guild_name: string; guild_id: string; collection_allowlist_json: string | null; configuration_revision: number; selection_state: "available" | "unavailable" | "invalid"; game_enabled?: number };
type Settings = { installations: Installation[]; collections: Collection[]; permissions: {canManageCollections:boolean;canManageAvailability:boolean} };

export default function DiscordInstallations() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  async function load(saved = "") {
    try { setSettings(await api<Settings>("/api/v1/admin/discord-installations")); setError(""); setVersion((v) => v + 1); }
    catch (cause) { setError(saved ? `The save succeeded, but settings could not reload: ${describeError(cause)}` : describeError(cause)); return; }
    setNotice(saved);
  }
  useEffect(() => { void load(); }, []);
  return <div className="grid gap-5">
    {error && <Alert variant="destructive"><AlertTitle>Server settings could not load</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status">{notice}</p>}
    {!settings && !error && <p role="status">Loading server settings…</p>}
    {settings && settings.installations.length === 0 && <p className="empty">No active Discord server is connected to this Bot.</p>}
    {settings?.installations.map((installation) => <div className="grid gap-4" key={`${installation.id}-${version}`}>{settings.permissions.canManageAvailability && <AvailabilityEditor installation={installation} saved={() => load("Server availability saved.")} clearNotice={() => setNotice("")} />}{settings.permissions.canManageCollections && <InstallationEditor installation={installation} collections={settings.collections} reload={() => load()} saved={() => load("Server collections saved.")} clearNotice={() => setNotice("")} />}</div>)}
  </div>;
}

function AvailabilityEditor({installation,saved,clearNotice}:{installation:Installation;saved:()=>Promise<void>;clearNotice:()=>void}) {
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const surfaces = [
    {key:'game',label:'Discord gameplay',enabled:installation.game_enabled},
  ] as const;
  async function change(surface: typeof surfaces[number]) {
    clearNotice();setError("");setBusy(true);
    try { await api(`/api/v1/admin/discord-installations/${encodeURIComponent(installation.id)}/availability`,{method:'PATCH',body:{revision:installation.configuration_revision,surface:surface.key,enabled:!surface.enabled}}); await saved(); }
    catch(cause) {setError(describeError(cause));} finally {setBusy(false);}
  }
  return <section className="surface p-5" aria-label={`Availability for ${installation.guild_name || 'Discord server'}`}>
    <h3 className="display-sm text-2xl">{installation.guild_name || 'Discord server'} availability</h3>
    <p className="mt-2 text-sm text-[var(--muted)]">This controls new Discord gameplay requests. Openings already underway may finish. Changes require a recent passkey or authenticator confirmation; existing cards and history are kept.</p>
    <ul className="mt-4 grid gap-2">{surfaces.map(surface=><li key={surface.key} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] py-2"><span><strong>{surface.label}</strong> · {surface.enabled ? 'Enabled' : 'Disabled'}</span><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>void change(surface)}>{surface.enabled ? 'Disable' : 'Enable'} {surface.label}</Button></li>)}</ul>
    {error && <p className="mt-3 text-sm" role="alert">{error}</p>}
  </section>;
}

function InstallationEditor({ installation, collections, reload, saved, clearNotice }: { installation: Installation; collections: Collection[]; reload: () => Promise<void>; saved: () => Promise<void>; clearNotice: () => void }) {
  let parsed: string[] | null = null;
  let invalid = false;
  if (installation.collection_allowlist_json !== null) {
    try {
      const value: unknown = JSON.parse(installation.collection_allowlist_json);
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) invalid = true;
      else parsed = value;
    } catch { invalid = true; }
  }
  const [mode, setMode] = useState<"inherit" | "selected">(parsed === null && !invalid ? "inherit" : "selected");
  const [selected, setSelected] = useState<string[]>(parsed ?? []);
  const [selectionInitialised, setSelectionInitialised] = useState(parsed !== null || invalid);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const unknown = selected.filter((id) => !collections.some((collection) => collection.id === id));
  async function save() {
    clearNotice(); setBusy(true); setMessage(""); setFailed(false);
    try {
      await api(`/api/v1/admin/discord-installations/${encodeURIComponent(installation.id)}`, { method: "PATCH", body: { revision: installation.configuration_revision, collectionIds: mode === "inherit" ? null : selected } });
      await saved();
    } catch (cause) { setFailed(true); setMessage(describeError(cause)); }
    finally { setBusy(false); }
  }
  if (installation.selection_state !== "available") return <section className="surface p-5">
    <h3 className="display-sm text-2xl">{installation.guild_name || "Discord server"}</h3>
    <p className="mt-1 text-sm text-[var(--muted)]">Server {installation.guild_id} · Revision {installation.configuration_revision}</p>
    <Alert className="mt-4" variant="destructive"><AlertTitle>Server selection unavailable</AlertTitle><AlertDescription>{installation.selection_state === "invalid" ? "The saved selection needs repair. Ask the Bot Owner for help." : "Some saved collections are not available to this account. Ask the Bot Owner to review access before changing this setting."}</AlertDescription></Alert>
    <div className="mt-5"><Button type="button" variant="secondary" onClick={reload}>Reload settings</Button></div>
  </section>;
  return <section className="surface p-5">
    <h3 className="display-sm text-2xl">{installation.guild_name || "Discord server"}</h3>
    <p className="mt-1 text-sm text-[var(--muted)]">Server {installation.guild_id} · Revision {installation.configuration_revision}</p>
    <p className="mt-3 text-sm">Choose which Bot-enabled collections this server can offer. This affects future Discord availability, not owned cards or history.</p>
    {invalid && <Alert variant="destructive"><AlertTitle>Configuration needs repair</AlertTitle><AlertDescription>The saved selection is invalid and Discord currently fails closed. Choose and save a valid setting.</AlertDescription></Alert>}
    <fieldset className="mt-4 grid gap-3"><legend className="font-semibold">Server collection policy</legend>
      <label className="flex items-start gap-3"><input type="radio" name={`mode-${installation.id}`} checked={mode === "inherit"} onChange={() => setMode("inherit")} /><span><strong>Follow Bot availability</strong><br /><span className="text-sm text-[var(--muted)]">Automatically follows collections enabled for this Bot.</span></span></label>
      <label className="flex items-start gap-3"><input type="radio" name={`mode-${installation.id}`} checked={mode === "selected"} onChange={() => { setMode("selected"); if (!selectionInitialised) { setSelected(collections.filter((item) => item.enabled && item.status === "published").map((item) => item.id)); setSelectionInitialised(true); } }} /><span><strong>Choose for this server</strong><br /><span className="text-sm text-[var(--muted)]">Only selected, published and Bot-enabled collections can be offered.</span></span></label>
    </fieldset>
    {mode === "inherit" && <details className="mt-5"><summary className="cursor-pointer font-semibold">Currently enabled for the Bot ({collections.filter((item) => item.enabled && item.status === "published").length})</summary><ul className="mt-2 grid gap-1 pl-5 text-sm text-[var(--muted)]">{collections.filter((item) => item.enabled && item.status === "published").map((item) => <li key={item.id} className="list-disc">{item.name}</li>)}</ul>{!collections.some((item) => item.enabled && item.status === "published") && <p className="mt-2 text-sm text-[var(--muted)]">No published collections are enabled for this Bot.</p>}</details>}
    {mode === "selected" && <fieldset className="mt-5 grid gap-2"><legend className="font-semibold">Collections</legend><p className="text-sm text-[var(--muted)]">Selecting none stops collection draws on this server. Bot-disabled selections remain unavailable until enabled for the Bot.</p>
      <div><Button type="button" variant="secondary" size="sm" onClick={() => setSelected([])} disabled={selected.length === 0}>Clear selection</Button></div>
      {collections.map((collection) => <label key={collection.id} className="flex min-h-11 items-center gap-3 border-b border-[var(--line)] py-2"><input type="checkbox" checked={selected.includes(collection.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, collection.id] : selected.filter((id) => id !== collection.id))} /><span className="min-w-0 flex-1 font-medium">{collection.name}</span><span className="text-sm text-[var(--muted)]">{!collection.enabled ? "Bot disabled" : collection.status !== "published" ? collection.status : "Bot enabled"}</span></label>)}
      {unknown.length > 0 && <p className="text-sm" role="alert">Some previously selected collections are no longer available. Reload or remove them before saving. <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(selected.filter((id) => !unknown.includes(id)))}>Remove unavailable selections</Button></p>}
    </fieldset>}
    {message && <p className="mt-3 text-sm" role={failed ? "alert" : "status"}>{message}</p>}
    <div className="mt-5 flex flex-wrap gap-3"><Button type="button" disabled={busy || (mode === "selected" && unknown.length > 0)} onClick={save}>{busy ? "Saving…" : "Save server collections"}</Button><Button type="button" variant="secondary" disabled={busy} onClick={reload}>Reload settings</Button></div>
  </section>;
}
