"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

type Summary = { scope: "visible_owned_inventory"; complete: false; visibleCopies: number; exclusions: string };

export default function VisibleInventorySummary() {
  const [summary,setSummary]=useState<Summary|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  async function load() {
    setLoading(true);setError('');setSummary(null);
    try {setSummary(await api<Summary>('/api/v1/admin/backup/visible-summary'));}
    catch (cause) {setError(describeError(cause));} finally {setLoading(false);}
  }
  useEffect(()=>{void load();},[]);
  return <section className="surface max-w-2xl space-y-4 p-5" aria-labelledby="visible-summary-heading">
    <div><p className="eyebrow">Your view · current Bot</p><h3 id="visible-summary-heading" className="display-sm mt-1 text-2xl">Visible card copies</h3></div>
    <p className="text-sm leading-relaxed text-[var(--muted)]">A count of the card copies in your own collection that you can currently see. It changes when your access changes.</p>
    {loading ? <p role="status" className="text-sm">Checking your visible collection…</p> : null}
    {error ? <div className="space-y-3" role="alert"><p className="text-sm">The count could not be loaded. {error}</p><Button size="sm" className="min-h-11" variant="secondary" onClick={load}>Try again</Button></div> : null}
    {summary ? <div className="space-y-3"><p className="font-display text-4xl" aria-label={`${summary.visibleCopies} visible card copies`}>{summary.visibleCopies}</p><p className="text-sm leading-relaxed">{summary.exclusions}</p><Button size="sm" className="min-h-11" variant="secondary" onClick={load}>Refresh count</Button></div> : null}
  </section>;
}
