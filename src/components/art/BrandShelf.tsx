"use client";

import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { openCardViewer, type CardViewerItem } from "../cards/CardViewer";
import type { BrandAsset, BrandKind, BrandSelections, BrandSlot } from "@/lib/brand-catalogue";

interface BrandCatalogue {
  groups: Array<{
    kind: BrandKind;
    label: string;
    note: string;
    slot: BrandSlot | null;
    assets: BrandAsset[];
  }>;
  selections: BrandSelections;
  can_select: boolean;
}

const SLOT_ACTION: Record<BrandSlot, string> = {
  favicon: "Use as site icon",
  og_image: "Use as default Open Graph",
  banner: "Use as preferred banner",
  card_style: "Use as default style",
};

const SLOT_SELECTED: Record<BrandSlot, string> = {
  favicon: "Live site icon",
  og_image: "Live Open Graph",
  banner: "Preferred banner",
  card_style: "Default style",
};

function styleKeyFor(asset: BrandAsset): string | null {
  return asset.id.startsWith("style-") ? asset.id.slice("style-".length) : null;
}

function selectionMatches(asset: BrandAsset, selections: BrandSelections): boolean {
  if (asset.slot === "card_style") {
    return selections.card_style === styleKeyFor(asset);
  }
  if (asset.slot) return selections[asset.slot] === asset.path;
  return false;
}

export default function BrandShelf({
  kind,
  base,
  onNotice,
  onError,
}: {
  kind: BrandKind;
  base: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<BrandCatalogue | null>(null);
  const [busy, setBusy] = useState("");
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let active = true;
    api<BrandCatalogue>(`${base}/brand`)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause) => {
        if (active) setFailed(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, [base]);

  const group = data?.groups.find((entry) => entry.kind === kind) ?? null;
  const styleGroup = data?.groups.find((entry) => entry.kind === "card_styles") ?? null;
  const showStyles = kind !== "card_styles" && styleGroup;

  const viewerItems = useMemo<CardViewerItem[]>(() => {
    if (!group) return [];
    return group.assets.map((asset) => ({
      id: asset.id,
      name: asset.label,
      subtitle: group.label,
      collection: "Brand art",
      styleKey: styleKeyFor(asset),
      method: asset.kind.replaceAll("_", " "),
      status: selectionMatches(asset, data!.selections)
        ? asset.slot
          ? "Selected"
          : "Available"
        : "Available",
      width: asset.width,
      height: asset.height,
      audience: "Brand",
      provenance: asset.note,
      front: asset.path,
      downloadUrl: asset.path,
    }));
  }, [group, data]);

  async function select(asset: BrandAsset, slot: BrandSlot) {
    setBusy(asset.id);
    try {
      const result = await api<BrandCatalogue>(`${base}/brand/selection`, {
        method: "POST",
        body: { slot, path: asset.path },
      });
      setData(result);
      onNotice(`${asset.label} is now ${SLOT_SELECTED[slot].toLowerCase()}.`);
    } catch (cause) {
      onError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  if (failed) {
    return (
      <p role="alert" className="brand-shelf__error">
        Brand art could not load. {failed}
      </p>
    );
  }
  if (!group) return null;

  return (
    <section className="brand-shelf" aria-label={`${group.label} brand art`}>
      <div className="brand-shelf__head">
        <h3>{group.label}</h3>
        <p>{group.note}</p>
        <span>{group.assets.length} files</span>
      </div>
      {group.assets.length === 0 ? (
        <p className="brand-shelf__empty">
          No {group.label.toLowerCase()} file is published yet. Generate one with a brief.
        </p>
      ) : (
        <div className="brand-grid">
          {group.assets.map((asset, index) => {
            const selected = selectionMatches(asset, data!.selections);
            const wide = (asset.width ?? 1) > (asset.height ?? 1) * 1.25;
            const pixel = (asset.width ?? 0) > 0 && (asset.width ?? 0) <= 64;
            return (
              <article
                key={asset.id}
                className="brand-tile"
                data-selected={selected ? "true" : "false"}
              >
                <button
                  type="button"
                  className={[
                    "brand-tile__view",
                    wide ? "brand-tile__view--wide" : "",
                    pixel ? "brand-tile__view--pixel" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => openCardViewer(viewerItems, index)}
                  aria-label={`Preview ${asset.label}`}
                >
                  <img
                    src={asset.path}
                    alt=""
                    width={asset.width ?? undefined}
                    height={asset.height ?? undefined}
                    loading={index < 4 ? "eager" : "lazy"}
                  />
                  {selected ? <span className="brand-tile__flag">Selected</span> : null}
                </button>
                <div className="brand-tile__body">
                  <p className="brand-tile__name">{asset.label}</p>
                  <p className="brand-tile__meta">
                    {asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}
                    {asset.note}
                  </p>
                  {asset.slot ? (
                    selected ? (
                      <span className="brand-tile__live">{SLOT_SELECTED[asset.slot]}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!data!.can_select || busy === asset.id}
                        onClick={() => void select(asset, asset.slot!)}
                      >
                        {busy === asset.id ? "Applying…" : SLOT_ACTION[asset.slot]}
                      </Button>
                    )
                  ) : (
                    <a className="brand-tile__download" href={asset.path} download>
                      Download
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showStyles ? (
        <div className="brand-styles">
          <div className="brand-shelf__head">
            <h3>Card styles</h3>
            <p>{styleGroup.note}</p>
            <span>{styleGroup.assets.length} directions</span>
          </div>
          <div className="brand-grid brand-grid--styles">
            {styleGroup.assets.map((asset, index) => {
              const selected = selectionMatches(asset, data!.selections);
              return (
                <article
                  key={asset.id}
                  className="brand-tile brand-tile--style"
                  data-selected={selected ? "true" : "false"}
                >
                  <button
                    type="button"
                    className="brand-tile__view"
                    onClick={() =>
                      openCardViewer(
                        styleGroup.assets.map((styleAsset) => ({
                          id: styleAsset.id,
                          name: styleAsset.label,
                          subtitle: "Card style",
                          collection: "Brand art",
                          styleKey: styleKeyFor(styleAsset),
                          method: "Art direction",
                          status: selectionMatches(styleAsset, data!.selections)
                            ? "Default style"
                            : "Available",
                          width: styleAsset.width,
                          height: styleAsset.height,
                          audience: "Brand",
                          provenance: styleAsset.note,
                          front: styleAsset.path,
                          downloadUrl: styleAsset.path,
                        })),
                        index,
                      )
                    }
                    aria-label={`Preview ${asset.label} style`}
                  >
                    <img src={asset.path} alt="" width={480} height={480} loading="lazy" />
                    {selected ? <span className="brand-tile__flag">Default</span> : null}
                  </button>
                  <div className="brand-tile__body">
                    <p className="brand-tile__name">{asset.label}</p>
                    <p className="brand-tile__meta">{asset.note}</p>
                    {selected ? (
                      <span className="brand-tile__live">Default style</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!data!.can_select || busy === asset.id}
                        onClick={() => void select(asset, "card_style")}
                      >
                        {busy === asset.id ? "Applying…" : "Use as default style"}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
