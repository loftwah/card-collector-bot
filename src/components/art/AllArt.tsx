"use client";

import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "@/lib/client";
import CardViewer, { openCardViewer, type CardViewerItem } from "../cards/CardViewer";
import type { BrandAsset, BrandKind } from "@/lib/brand-catalogue";

interface ArtPin {
  candidate_id: string;
  brief_id: string;
  brief_title: string;
  category: string;
  collection_name: string | null;
  card_name: string | null;
  label: string;
  method: string;
  style_key: string | null;
  status: string;
  width: number;
  height: number;
  audience: string;
  image_url: string;
}

interface Style {
  key: string;
  label: string;
  note: string;
  thumb: string;
}

type Filter =
  | "all"
  | "cards"
  | "icons"
  | "mascots"
  | "logos"
  | "og_images"
  | "banners"
  | "shareables"
  | "styles"
  | "other";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "cards", label: "Cards" },
  { key: "icons", label: "Icons" },
  { key: "mascots", label: "Mascots" },
  { key: "styles", label: "Styles" },
  { key: "logos", label: "Logos" },
  { key: "og_images", label: "OG" },
  { key: "banners", label: "Banners" },
  { key: "shareables", label: "Shareables" },
  { key: "other", label: "Other" },
];

const KIND_LABEL: Record<string, string> = {
  cards: "Card",
  icons: "Icon",
  mascots: "Mascot",
  logos: "Logo",
  og_images: "OG",
  banners: "Banner",
  shareables: "Shareable",
  styles: "Style",
  other: "Brand",
};

export default function AllArt({
  assets,
  styles,
}: {
  assets: BrandAsset[];
  styles: readonly Style[];
}) {
  const [pins, setPins] = useState<ArtPin[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api<{ pins: ArtPin[] }>("/api/v1/studio/art")
      .then((data) => {
        if (active) setPins(data.pins ?? []);
      })
      .catch((cause) => {
        if (active) setError(describeError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const brandAssets = useMemo(
    () => assets.filter((asset) => asset.kind !== "card_styles"),
    [assets],
  );

  const items = useMemo<CardViewerItem[]>(() => {
    const cardItems: CardViewerItem[] = pins.map((pin) => ({
      id: pin.candidate_id,
      name: pin.card_name ?? pin.brief_title,
      subtitle: pin.brief_title,
      collection: pin.collection_name,
      styleKey: pin.style_key,
      method: pin.method === "whole_card" ? "Whole-card AI" : "Composed card",
      status: pin.status,
      width: pin.width,
      height: pin.height,
      audience: pin.audience,
      front: pin.image_url,
    }));
    const brandItems: CardViewerItem[] = brandAssets.map((asset) => ({
      id: asset.id,
      name: asset.label,
      subtitle: KIND_LABEL[asset.kind] ?? asset.kind,
      collection: "Brand art",
      method: asset.kind.replaceAll("_", " "),
      status: asset.slot ? "Selectable" : "Brand file",
      width: asset.width,
      height: asset.height,
      audience: "Brand",
      provenance: asset.note,
      front: asset.path,
      downloadUrl: asset.path,
    }));
    const styleItems: CardViewerItem[] = styles.map((style) => ({
      id: `style-${style.key}`,
      name: style.label,
      subtitle: "Card style",
      collection: "Brand art",
      styleKey: style.key,
      styleLabel: style.label,
      method: "Art direction",
      status: "Available",
      width: 480,
      height: 480,
      audience: "Brand",
      provenance: style.note,
      front: style.thumb,
      downloadUrl: style.thumb,
    }));
    return [...cardItems, ...brandItems, ...styleItems];
  }, [pins, brandAssets, styles]);

  const visible = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "cards") return items.slice(0, pins.length);
    if (filter === "styles") return items.slice(items.length - styles.length);
    const brandStart = pins.length;
    const brandEnd = brandStart + brandAssets.length;
    const brand = items.slice(brandStart, brandEnd);
    // The catalogue order is stable, so the filtered slice preserves the
    // existing order for arrow-key paging inside the viewer.
    return brand.filter((item) => {
      const asset = brandAssets.find((entry) => entry.id === item.id);
      return asset ? asset.kind === (filter as BrandKind) : false;
    });
  }, [filter, items, pins.length, brandAssets, styles.length]);

  function openAt(index: number) {
    openCardViewer(visible, index);
  }

  const countFor = (key: Filter) => {
    if (key === "all") return items.length;
    if (key === "cards") return pins.length;
    if (key === "styles") return styles.length;
    return brandAssets.filter((asset) => asset.kind === key).length;
  };

  return (
    <div className="min-w-0">
      <CardViewer />
      <header className="all-art-bar">
        <div>
          <h2>All art</h2>
          <p>
            {items.length} pieces · {pins.length} card{pins.length === 1 ? "" : "s"} ·{" "}
            {styles.length} styles
          </p>
        </div>
        <a className="btn btn-secondary btn-sm" href="/studio/art">
          Art Lab
        </a>
      </header>

      <nav className="all-art-filters" aria-label="All art filters">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="chip"
            data-active={filter === entry.key}
            aria-pressed={filter === entry.key}
            onClick={() => setFilter(entry.key)}
          >
            {entry.label}
            <span>{countFor(entry.key)}</span>
          </button>
        ))}
      </nav>

      {error ? (
        <p role="status" className="notice mt-3">
          Card candidates could not load. Brand art is still available. {error}
        </p>
      ) : null}

      {loading && filter === "cards" ? (
        <div className="all-art-grid mt-3" aria-busy="true">
          <div className="skeleton h-64 rounded-[3px]" />
          <div className="skeleton h-64 rounded-[3px]" />
          <div className="skeleton h-64 rounded-[3px]" />
        </div>
      ) : visible.length ? (
        <div
          className={`all-art-grid mt-3 ${
            filter === "all"
              ? "all-art-grid--mixed"
              : filter === "og_images" || filter === "banners" || filter === "shareables"
                ? "all-art-grid--wide"
                : `all-art-grid--${filter}`
          }`}
        >
          {visible.map((item, index) => {
            const asset = brandAssets.find((entry) => entry.id === item.id);
            const style = styles.find((entry) => `style-${entry.key}` === item.id);
            const kindLabel = asset
              ? (KIND_LABEL[asset.kind] ?? asset.kind)
              : style
                ? "Style"
                : "Card";
            return (
              <button
                key={item.id}
                type="button"
                className="all-art-tile"
                onClick={() => openAt(index)}
                aria-label={`Open ${item.name} full size`}
              >
                <span className="all-art-tile__object">
                  <img
                    src={item.front}
                    alt=""
                    width={item.width ?? undefined}
                    height={item.height ?? undefined}
                    loading={index < 6 ? "eager" : "lazy"}
                  />
                  <span className="all-art-tile__kind">{kindLabel}</span>
                </span>
                <span className="all-art-tile__name">{item.name}</span>
                <span className="all-art-tile__meta">
                  {[item.collection, item.styleLabel, item.finish].filter(Boolean).join(" · ") ||
                    item.subtitle}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty mt-3">
          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.12em] uppercase">
              No {FILTERS.find((entry) => entry.key === filter)?.label.toLowerCase()} yet
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Create a brief or select another shelf.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
