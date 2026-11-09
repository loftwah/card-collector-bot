"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, Heart, Lock, LockOpen, Recycle } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "@/lib/utils";
import { clearRecyclePending, readRecyclePending, reserveRecyclePending } from '@/lib/recycle-pending';

interface Preview {
  credit: number;
  breakdown: { rarity: number; material: number };
  currency_symbol: string;
  warning: string;
}
function validPending(value: unknown): value is {key:string;preview:Preview} {
  if (!value || typeof value!=='object') return false;
  const pending=value as {key?:unknown;preview?:Partial<Preview>};
  return typeof pending.key==='string' && pending.key.startsWith('recycle-') && Boolean(pending.preview && Number.isSafeInteger(pending.preview.credit) &&
    typeof pending.preview.currency_symbol==='string' && typeof pending.preview.warning==='string' && pending.preview.breakdown &&
    Number.isSafeInteger(pending.preview.breakdown.rarity) && Number.isSafeInteger(pending.preview.breakdown.material));
}

export default function CardDetailActions({
  instanceId,
  tenantId,
  userId,
  cardId,
  initialFavourite,
  initialLocked,
  initialWishlist,
  initialWishlistTarget = "",
  wishlistVariants = [],
  reserved,
}: {
  instanceId: string;
  tenantId: string;
  userId: string;
  cardId: string;
  initialFavourite: boolean;
  initialLocked: boolean;
  initialWishlist: boolean;
  initialWishlistTarget?: string;
  wishlistVariants?: Array<{ id: string; label: string }>;
  reserved: boolean;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [locked, setLocked] = useState(initialLocked);
  const [wishlist, setWishlist] = useState(initialWishlist);
  const [wishlistTarget, setWishlistTarget] = useState(initialWishlistTarget);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycleError, setRecycleError] = useState("");
  const [confirmCancel,setConfirmCancel]=useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pendingRecycle,setPendingRecycle]=useState<{key:string;preview:Preview}|null>(null);
  const [recoveryReady,setRecoveryReady]=useState(false);
  const [recoveryError,setRecoveryError]=useState('');
  const recycleInFlight=useRef(false);
  const storageKey=JSON.stringify([tenantId,userId,instanceId]);
  useEffect(()=>{
    let active=true;
    void (async()=>{
      try {
        let saved=await readRecyclePending<Preview>(storageKey);
        if (saved && !validPending(saved)) throw new Error('Invalid recovery record.');
        // Preserve keys created by the earlier same-tab recovery implementation.
        const legacyKey=`foilbury:recycle:${tenantId}:${userId}:${instanceId}`;
        const raw=sessionStorage.getItem(legacyKey);
        if (raw) {
          const legacy=JSON.parse(raw) as {key?:unknown;preview?:Preview};
          if (!validPending(legacy))
            throw new Error('A previous recovery record needs attention.');
          const migrated=await reserveRecyclePending(storageKey,{key:legacy.key,preview:legacy.preview});
          saved=migrated.pending;
          if (saved.key===legacy.key) sessionStorage.removeItem(legacyKey);
        }
        if (active) {setPendingRecycle(saved);setRecoveryReady(true);}
      } catch {if(active){setRecoveryError('Recovery could not be loaded. Check browser storage or contact support before recycling.');setRecoveryReady(false);}}
    })();
    return ()=>{active=false;};
  },[storageKey]);

  async function toggleFavourite() {
    setBusy("favourite");
    setError("");
    const next = !favourite;
    setFavourite(next);
    try {
      await api(`/api/v1/instances/${instanceId}/favourite`, { method: "POST", body: { favourite: next } });
      setNotice(next ? "Marked as a favourite." : "Removed from favourites.");
    } catch (cause) {
      setFavourite(!next);
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function toggleWishlist() {
    setBusy("wishlist");
    setError("");
    setNotice("");
    const next = !wishlist;
    setWishlist(next);
    try {
      await api(`/api/v1/wishlist`, { method: "POST", body: { cardId, wanted: next, targetVariantId: next && wishlistTarget ? wishlistTarget : null } });
      setNotice(next ? (wishlistTarget ? "Wishlist saved with the exact finish you chose." : "Added to your wishlist for any finish.") : "Removed from your wishlist.");
    } catch (cause) {
      setWishlist(!next);
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function updateWishlistTarget(value: string) {
    const previous = wishlistTarget;
    setWishlistTarget(value);
    setError("");
    setNotice("");
    if (!wishlist) return;
    setBusy("wishlist-target");
    try {
      await api("/api/v1/wishlist", { method: "POST", body: { cardId, wanted: true, targetVariantId: value || null } });
      setNotice(value ? "Wishlist target updated to that exact finish." : "Wishlist target updated to any finish.");
    } catch (cause) {
      setWishlistTarget(previous);
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function toggleLock() {
    setBusy("lock");
    setError("");
    const next = !locked;
    setLocked(next);
    try {
      await api(`/api/v1/instances/${instanceId}/lock`, { method: "POST", body: { locked: next } });
      setNotice(next ? "Card locked. It cannot be recycled or traded." : "Card unlocked.");
    } catch (cause) {
      setLocked(!next);
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function openRecycle() {
    setBusy("preview");
    setError("");
    setNotice("");
    setRecycleError("");
    setConfirmCancel(false);
    let existing: {key:string;preview:Preview}|null;
    try {existing=await readRecyclePending<Preview>(storageKey);}
    catch {setRecoveryError('Recovery storage is unavailable. Enable browser storage before recycling.');setBusy('');return;}
    if (existing && !validPending(existing)) {setRecoveryError('The saved recovery request is unreadable. Contact support before recycling.');setBusy('');return;}
    setPendingRecycle(existing);
    if (existing) {
      setPreview(existing.preview);
      setRecycleError('A previous recycle request has an unconfirmed result. Retry this same request to recover its receipt.');
      setRecycleOpen(true);
      setBusy("");
      return;
    }
    try {
      const result = await api<{ credit: number; breakdown: { rarity: number; material: number }; currency_symbol: string; warning: string }>("/api/v1/recycle/preview", {
        method: "POST",
        body: { instanceId },
      });
      setPreview(result);
      setRecycleOpen(true);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function confirmRecycle() {
    if (!preview || recycleInFlight.current) return;
    recycleInFlight.current=true;
    setBusy("recycle");
    setRecycleError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const candidate=pendingRecycle ?? {key:idempotencyKey('recycle'),preview};
      let reservation: {pending:{key:string;preview:Preview};created:boolean};
      try {reservation=await reserveRecyclePending(storageKey,candidate);}
      catch {setRecycleError('This browser cannot save the recovery key. Enable browser storage before recycling.');setBusy('');return;}
      const pending=reservation.pending;
      if (!validPending(pending)) {setRecycleError('The saved recovery request is unreadable. Contact support before recycling.');setBusy('');return;}
      setPendingRecycle(pending);
      if (!reservation.created && pending.key!==candidate.key) {
        setPreview(pending.preview);
        setRecycleError('Another tab has an unconfirmed recycle request. Review it and retry the same request.');
        setBusy('');return;
      }
      const receipt=await api<{receipt_id?:unknown;instance_id?:unknown;credit?:unknown;balance_after?:unknown} | null>("/api/v1/recycle", {
        method: "POST",
        body: { instanceId, expectedCredit: pending.preview.credit },
        idempotencyKey: pending.key,
        signal: controller.signal,
      });
      if (!receipt || typeof receipt.receipt_id!=='string' || !receipt.receipt_id || receipt.instance_id!==instanceId || receipt.credit!==pending.preview.credit || !Number.isSafeInteger(receipt.balance_after))
        throw new Error('The recycle receipt could not be confirmed.');
      try {await clearRecyclePending(storageKey,pending.key);} catch { /* A replay is safe if storage cannot be cleared. */ }
      setPendingRecycle(null);
      window.location.href = "/play/collection";
    } catch (cause) {
      setRecycleError(controller.signal.aborted ? "The request timed out before we could confirm the result." : describeError(cause));
      setBusy("");
    } finally {
      window.clearTimeout(timeout);
      recycleInFlight.current=false;
    }
  }

  async function cancelPendingRecycle() {
    if (!pendingRecycle || recycleInFlight.current) return;
    recycleInFlight.current=true;setBusy('cancel');setRecycleError('');
    const controller=new AbortController(),timeout=window.setTimeout(()=>controller.abort(),15_000);
    try {
      const result=await api<{status?:unknown;receipt?:{receipt_id?:unknown;instance_id?:unknown;credit?:unknown;balance_after?:unknown}} | null>('/api/v1/recycle/cancel',{
        method:'POST',body:{instanceId,expectedCredit:pendingRecycle.preview.credit},idempotencyKey:pendingRecycle.key,signal:controller.signal,
      });
      if (!result || (result.status!=='cancelled' && result.status!=='completed')) throw new Error('The request outcome could not be confirmed.');
      if (result.status==='completed') {
        const receipt=result.receipt;
        if (!receipt || typeof receipt.receipt_id!=='string' || !receipt.receipt_id || receipt.instance_id!==instanceId || receipt.credit!==pendingRecycle.preview.credit || !Number.isSafeInteger(receipt.balance_after))
          throw new Error('The recycle receipt could not be confirmed.');
      }
      await clearRecyclePending(storageKey,pendingRecycle.key);
      setPendingRecycle(null);setConfirmCancel(false);setRecycleOpen(false);setPreview(null);
      if (result.status==='completed') window.location.href='/play/collection';
      else setNotice('Recycle request cancelled. Check your collection for the card’s current status.');
    } catch (cause) {
      setRecycleError(controller.signal.aborted?'The cancellation timed out before its result could be confirmed.':describeError(cause));
    } finally {window.clearTimeout(timeout);recycleInFlight.current=false;setBusy('');}
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={toggleFavourite} disabled={Boolean(busy)} aria-pressed={favourite}>
          <Heart size={15} fill={favourite ? "currentColor" : "none"} className={cn(favourite && "text-[var(--brass)]")} />
          {favourite ? "Favourited" : "Favourite"}
        </Button>
        <Button variant="secondary" size="sm" onClick={toggleWishlist} disabled={Boolean(busy)} aria-pressed={wishlist}>
          <Bookmark size={15} fill={wishlist ? "currentColor" : "none"} className={cn(wishlist && "text-[var(--brass)]")} />
          {wishlist ? "Wishlisted" : "Wishlist"}
        </Button>
        {wishlistVariants.length ? (
          <label className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className="sr-only">Wishlist finish</span>
            <select
              className="select h-8 text-xs"
              value={wishlistTarget}
              aria-label="Wishlist finish or edition"
              disabled={Boolean(busy)}
              onChange={(event) => {
                void updateWishlistTarget(event.target.value);
              }}
            >
              <option value="">Any finish</option>
              {wishlistVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
            </select>
          </label>
        ) : null}
        <Button variant="secondary" size="sm" onClick={toggleLock} disabled={Boolean(busy)} aria-pressed={locked}>
          {locked ? <Lock size={15} /> : <LockOpen size={15} />}
          {locked ? "Locked" : "Lock"}
        </Button>
        <Button variant="danger" size="sm" onClick={openRecycle} disabled={!recoveryReady || Boolean(busy) || (!pendingRecycle && (reserved || locked || favourite))} title={!pendingRecycle && reserved ? "Reserved for a trade" : !pendingRecycle && locked ? "Unlock first" : !pendingRecycle && favourite ? "Remove favourite first" : undefined}>
          <Recycle size={15} /> Recycle
        </Button>
      </div>
      {!wishlist && wishlistVariants.length ? <p className="mt-2 text-xs text-[var(--muted)]">Choose a finish, then select Wishlist to save it.</p> : null}
      {notice ? <p className="mt-2 text-xs green" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--oxblood)]" role="alert">{error}</p> : null}
      {recoveryError ? <p className="mt-2 text-xs text-[var(--oxblood)]" role="alert">{recoveryError}</p> : null}

      <Dialog open={recycleOpen} onOpenChange={(open) => { if (busy !== "recycle" && busy !== 'cancel') setRecycleOpen(open); }}>
        <DialogContent>
          <DialogTitle>{confirmCancel ? 'Cancel this request?' : 'Recycle this card?'}</DialogTitle>
          <DialogDescription>
            {confirmCancel ? 'Cancellation succeeds only if this recycle has not already completed. If it completed first, we’ll recover its receipt instead.' : 'This is permanent. The card leaves your collection; its history and the credit remain recorded.'}
          </DialogDescription>
          {confirmCancel ? <div className="mt-6">
            {recycleError ? <p role="alert" className="mb-4 text-sm text-[var(--oxblood)]">{recycleError}</p> : null}
            <div className="flex flex-wrap gap-2"><Button variant="danger" onClick={cancelPendingRecycle} disabled={Boolean(busy)}>{busy==='cancel'?'Checking…':'Confirm cancellation'}</Button>
            <Button variant="secondary" onClick={()=>{setConfirmCancel(false);setRecycleError('A previous recycle request has an unconfirmed result. Retry this same request to recover its receipt.');}} disabled={Boolean(busy)}>Go back</Button></div>
          </div> : preview ? (
            <div className="mt-5">
              <div className="flex items-end justify-between border-y border-[var(--line)] py-4">
                <div>
                  <p className="eyebrow">Credit</p>
                  <p className="display-sm mt-1 text-3xl text-[var(--brass)]">{preview.currency_symbol} {preview.credit}</p>
                </div>
                <p className="text-right font-mono text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">Rarity {preview.breakdown.rarity} · material {preview.breakdown.material}</p>
              </div>
              <p className="mt-4 text-sm text-[var(--muted)]">{preview.warning}</p>
              {recycleError ? (
                <div className="mt-4 text-sm" role="alert">
                  <p className="text-[var(--oxblood)]">{recycleError}</p>
                  {pendingRecycle ? <><p className="mt-2 text-[var(--muted)]">The result may already have been recorded. Retry this same request to recover its receipt, or check your collection.</p>
                  <a className="mt-2 inline-block underline" href="/play/collection">Check your collection</a></> : null}
                </div>
              ) : null}
              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="danger" onClick={confirmRecycle} disabled={Boolean(busy) || (Boolean(recycleError) && !pendingRecycle)}>{busy === "recycle" ? "Recycling…" : pendingRecycle ? 'Retry same request' : "Recycle permanently"}</Button>
                {pendingRecycle ? <Button variant="secondary" onClick={()=>{setRecycleError('');setConfirmCancel(true);}} disabled={Boolean(busy)}>Cancel pending request</Button> : null}
                <Button variant="secondary" onClick={() => setRecycleOpen(false)} disabled={Boolean(busy)}>{recycleError ? "Close" : "Keep the card"}</Button>
              </div>
            </div>
          ) : <p className="mt-4 text-sm text-[var(--muted)]">Loading the recycle preview…</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
