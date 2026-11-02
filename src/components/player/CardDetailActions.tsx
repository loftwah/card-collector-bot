"use client";

import { useState } from "react";
import { Bookmark, Heart, Lock, LockOpen, Recycle } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "@/lib/utils";

interface Preview {
  credit: number;
  breakdown: { rarity: number; material: number };
  currency_symbol: string;
  warning: string;
}

export default function CardDetailActions({
  instanceId,
  cardId,
  initialFavourite,
  initialLocked,
  initialWishlist,
  reserved,
}: {
  instanceId: string;
  cardId: string;
  initialFavourite: boolean;
  initialLocked: boolean;
  initialWishlist: boolean;
  reserved: boolean;
}) {
  const [favourite, setFavourite] = useState(initialFavourite);
  const [locked, setLocked] = useState(initialLocked);
  const [wishlist, setWishlist] = useState(initialWishlist);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

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
    const next = !wishlist;
    setWishlist(next);
    try {
      await api(`/api/v1/wishlist`, { method: "POST", body: { cardId, wanted: next } });
      setNotice(next ? "Added to your wishlist." : "Removed from your wishlist.");
    } catch (cause) {
      setWishlist(!next);
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
    if (!preview) return;
    setBusy("recycle");
    try {
      await api("/api/v1/recycle", {
        method: "POST",
        body: { instanceId, expectedCredit: preview.credit },
        idempotencyKey: idempotencyKey("recycle"),
      });
      window.location.href = "/play/collection";
    } catch (cause) {
      setError(describeError(cause));
      setBusy("");
    }
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
        <Button variant="secondary" size="sm" onClick={toggleLock} disabled={Boolean(busy)} aria-pressed={locked}>
          {locked ? <Lock size={15} /> : <LockOpen size={15} />}
          {locked ? "Locked" : "Lock"}
        </Button>
        <Button variant="danger" size="sm" onClick={openRecycle} disabled={Boolean(busy) || reserved || locked || favourite} title={reserved ? "Reserved for a trade" : locked ? "Unlock first" : favourite ? "Remove favourite first" : undefined}>
          <Recycle size={15} /> Recycle
        </Button>
      </div>
      {notice ? <p className="mt-2 text-xs green" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--oxblood)]" role="alert">{error}</p> : null}

      <Dialog open={recycleOpen} onOpenChange={setRecycleOpen}>
        <DialogContent>
          <DialogTitle>Recycle this card?</DialogTitle>
          <DialogDescription>
            This is permanent. The card leaves your collection; the acquisition history and the compensating ledger entry remain.
          </DialogDescription>
          {preview ? (
            <div className="mt-5">
              <div className="flex items-end justify-between border-y border-[var(--line)] py-4">
                <div>
                  <p className="eyebrow">Credit</p>
                  <p className="display-sm mt-1 text-3xl text-[var(--brass)]">{preview.currency_symbol} {preview.credit}</p>
                </div>
                <p className="text-right font-mono text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">Rarity {preview.breakdown.rarity} · material {preview.breakdown.material}</p>
              </div>
              <p className="mt-4 text-sm text-[var(--muted)]">{preview.warning}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="danger" onClick={confirmRecycle} disabled={busy === "recycle"}>{busy === "recycle" ? "Recycling…" : "Recycle permanently"}</Button>
                <Button variant="secondary" onClick={() => setRecycleOpen(false)}>Keep the card</Button>
              </div>
            </div>
          ) : <p className="mt-4 text-sm text-[var(--muted)]">Loading the recycle preview…</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
