"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, RotateCcw, Trash2, Upload, UserRound } from "lucide-react";
import { ApiClientError, api, describeError } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { AccountAvatarView, AccountBannerView, DefaultAvatar } from "@/server/modules/account-avatar";
import { Button } from "../ui/button";

interface DiscordState {
  linked: boolean;
  name: string | null;
  hasAvatar: boolean;
}

interface AvatarResponse {
  avatar: AccountAvatarView;
}

interface BannerResponse {
  banner: AccountBannerView | null;
}

const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  URL.revokeObjectURL(url);
  return image;
}

function drawCropped(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  width: number,
  height: number,
  zoom: number,
  offset: { x: number; y: number },
) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const maxX = Math.max(0, (drawWidth - width) / 2);
  const maxY = Math.max(0, (drawHeight - height) / 2);
  const x = (width - drawWidth) / 2 + offset.x * maxX;
  const y = (height - drawHeight) / 2 + offset.y * maxY;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, x, y, drawWidth, drawHeight);
}

async function canvasRendition(
  image: HTMLImageElement,
  width: number,
  height: number,
  zoom: number,
  offset: { x: number; y: number },
): Promise<{ size: number; data: string; mime: string }> {
  const canvas = document.createElement("canvas");
  drawCropped(canvas, image, width, height, zoom, offset);
  let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  let mime = "image/webp";
  if (!blob || blob.type !== "image/webp") {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    mime = "image/jpeg";
  }
  if (!blob) throw new Error("The browser could not prepare that image.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The browser could not read the prepared image."));
    reader.readAsDataURL(blob);
  });
  return { size: width, data, mime };
}

function AvatarCropper({
  file,
  onFile,
  onUse,
  busy,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  onUse: (renditions: Array<{ size: number; data: string; mime: string }>) => Promise<void>;
  busy: boolean;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) {
      setImage(null);
      return;
    }
    if (!AVATAR_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP photo.");
      setImage(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That photo is over 12 MB. Choose a smaller file.");
      setImage(null);
      return;
    }
    setError("");
    loadImage(file)
      .then((next) => {
        setImage(next);
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      })
      .catch(() => setError("That photo could not be opened. Try another file."));
  }, [file]);

  useEffect(() => {
    if (!image || !canvasRef.current) return;
    drawCropped(canvasRef.current, image, 512, 512, zoom, offset);
  }, [image, zoom, offset]);

  function movePointer(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag.current || !image) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - drag.current.x) / rect.width) * 2;
    const dy = ((event.clientY - drag.current.y) / rect.height) * 2;
    setOffset({
      x: clamp(drag.current.ox + dx, -1, 1),
      y: clamp(drag.current.oy + dy, -1, 1),
    });
  }

  async function usePhoto() {
    if (!image) return;
    setError("");
    try {
      const renditions = await Promise.all([
        canvasRendition(image, 256, 256, zoom, offset),
        canvasRendition(image, 128, 128, zoom, offset),
        canvasRendition(image, 64, 64, zoom, offset),
      ]);
      await onUse(renditions);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <div className="avatar-crop">
      <label className={cn("avatar-drop", image && "has-image")}>
        <input
          type="file"
          accept={AVATAR_TYPES.join(",")}
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        {image ? (
          <canvas
            ref={canvasRef}
            className="avatar-crop__canvas"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            }}
            onPointerMove={movePointer}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            aria-label="Crop preview. Drag to reposition the square crop."
          />
        ) : (
          <span className="avatar-drop__prompt">
            <ImagePlus size={24} aria-hidden="true" />
            <strong>Choose a photo</strong>
            <small>PNG, JPEG or WebP. You can position the square crop next.</small>
          </span>
        )}
      </label>
      {image ? (
        <div className="avatar-crop__controls">
          <label className="field">
            <span>Zoom</span>
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              onChange={(event) => {
                setZoom(Number(event.target.value));
                setOffset({ x: 0, y: 0 });
              }}
            />
          </label>
          <div className="avatar-crop__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => onFile(null)} disabled={busy}>
              Choose another
            </Button>
            <Button type="button" size="sm" onClick={usePhoto} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {busy ? "Saving" : "Use this crop"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BannerCropper({
  file,
  onFile,
  onUse,
  busy,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  onUse: (renditions: Array<{ size: number; data: string; mime: string }>) => Promise<void>;
  busy: boolean;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) {
      setImage(null);
      return;
    }
    if (!AVATAR_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      setImage(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That image is over 12 MB. Choose a smaller file.");
      setImage(null);
      return;
    }
    setError("");
    loadImage(file)
      .then((next) => {
        setImage(next);
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      })
      .catch(() => setError("That image could not be opened. Try another file."));
  }, [file]);

  useEffect(() => {
    if (!image || !canvasRef.current) return;
    drawCropped(canvasRef.current, image, 800, 300, zoom, offset);
  }, [image, zoom, offset]);

  function movePointer(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag.current || !image) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - drag.current.x) / rect.width) * 2;
    const dy = ((event.clientY - drag.current.y) / rect.height) * 2;
    setOffset({
      x: clamp(drag.current.ox + dx, -1, 1),
      y: clamp(drag.current.oy + dy, -1, 1),
    });
  }

  async function useImage() {
    if (!image) return;
    setError("");
    try {
      const renditions = await Promise.all([
        canvasRendition(image, 1600, 600, zoom, offset),
        canvasRendition(image, 800, 300, zoom, offset),
      ]);
      await onUse(renditions);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <div className="avatar-crop avatar-crop--banner">
      <label className={cn("avatar-drop", image && "has-image")}>
        <input
          type="file"
          accept={AVATAR_TYPES.join(",")}
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        {image ? (
          <canvas
            ref={canvasRef}
            className="avatar-crop__canvas avatar-crop__canvas--banner"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            }}
            onPointerMove={movePointer}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            aria-label="Banner crop preview. Drag to reposition the 8:3 crop."
          />
        ) : (
          <span className="avatar-drop__prompt">
            <ImagePlus size={24} aria-hidden="true" />
            <strong>Choose a banner image</strong>
            <small>PNG, JPEG or WebP. The crop is 8:3 and stays private.</small>
          </span>
        )}
      </label>
      {image ? (
        <div className="avatar-crop__controls">
          <label className="field">
            <span>Zoom</span>
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              onChange={(event) => {
                setZoom(Number(event.target.value));
                setOffset({ x: 0, y: 0 });
              }}
            />
          </label>
          <div className="avatar-crop__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => onFile(null)} disabled={busy}>
              Choose another
            </Button>
            <Button type="button" size="sm" onClick={useImage} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {busy ? "Saving" : "Use this banner"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function AccountAvatarPicker({
  initialAvatar,
  initialBanner,
  defaults,
  discord,
  displayName,
}: {
  initialAvatar: AccountAvatarView;
  initialBanner: AccountBannerView | null;
  defaults: DefaultAvatar[];
  discord: DiscordState;
  displayName: string;
}) {
  const [avatar, setAvatar] = useState(initialAvatar);
  const [banner, setBanner] = useState(initialBanner);
  const [tab, setTab] = useState<"discord" | "upload" | "default">(
    initialAvatar.kind === "upload" ? "upload" : initialAvatar.kind === "discord" ? "discord" : "default",
  );
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function acceptAvatar(next: AccountAvatarView, message: string) {
    setAvatar(next);
    setNotice(message);
    setError("");
    setAvatarFile(null);
  }

  async function chooseDefault(key: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ avatar: AccountAvatarView }>("/api/v1/me/avatar/default", {
        method: "POST",
        body: { key },
      });
      acceptAvatar(result.avatar, `Avatar updated to ${result.avatar.label}.`);
      setTab("default");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function useDiscord() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ avatar: AccountAvatarView }>("/api/v1/me/avatar/discord", {
        method: "POST",
        body: {},
      });
      acceptAvatar(result.avatar, result.avatar.note);
      setTab("discord");
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "discord_avatar_unavailable") {
        setError(cause.message);
      } else {
        setError(describeError(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(renditions: Array<{ size: number; data: string; mime: string }>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ avatar: AccountAvatarView }>("/api/v1/me/avatar/upload", {
        method: "POST",
        body: { renditions },
      });
      acceptAvatar(result.avatar, "Photo saved as a private account asset.");
      setTab("upload");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeAvatar() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ avatar: AccountAvatarView }>("/api/v1/me/avatar", { method: "DELETE" });
      acceptAvatar(result.avatar, "Avatar removed. The Keeper is showing.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function uploadBanner(renditions: Array<{ size: number; data: string; mime: string }>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ banner: AccountBannerView }>("/api/v1/me/banner/upload", {
        method: "POST",
        body: { renditions },
      });
      setBanner(result.banner);
      setBannerFile(null);
      setNotice("Banner saved. Choose “Uploaded banner” in your profile composition to use it.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeBanner() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/v1/me/banner", { method: "DELETE" });
      setBanner(null);
      setNotice("Uploaded banner removed. Your profile returns to the plain surface or its collection banner.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-avatar">
      {error ? (
        <div className="error-box" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      {notice ? (
        <div className="success-box" role="status">
          {notice}
        </div>
      ) : null}

      <section className="account-avatar__current" aria-label="Current account avatar">
        <div className="account-avatar__preview">
          <span className="profile-avatar profile-avatar--image">
            <img
              src={avatar.src}
              srcSet={avatar.srcSet ?? undefined}
              sizes="96px"
              alt={`${displayName}'s account avatar`}
              width="96"
              height="96"
              data-avatar-img
              data-fallback-src="/avatars/default/keeper-256.png"
            />
          </span>
          <div>
            <p className="eyebrow">Account avatar</p>
            <p className="account-avatar__title">{avatar.label}</p>
            <p className="account-avatar__note">{avatar.note}</p>
            <p className="account-avatar__meta">
              {avatar.kind === "upload" ? "Private photo" : avatar.kind === "discord" ? "Cached from Discord" : "Illustrated default"}
              {avatar.updatedAt ? ` · updated ${new Date(avatar.updatedAt).toLocaleDateString("en-AU")}` : ""}
            </p>
            {avatar.kind !== "default" ? (
              <Button type="button" variant="secondary" size="sm" onClick={removeAvatar} disabled={busy}>
                <Trash2 size={15} aria-hidden="true" /> Remove and use the Keeper
              </Button>
            ) : null}
          </div>
        </div>
        <div className="account-avatar__sizes" aria-label="Real size previews">
          {[256, 128, 64, 32].map((size) => (
            <figure key={size}>
              <span className={cn("account-avatar__size", size <= 64 && "is-round")}>
                <img
                  src={avatar.src}
                  srcSet={avatar.srcSet ?? undefined}
                  sizes={`${size}px`}
                  alt=""
                  width={size}
                  height={size}
                  data-avatar-img
                  data-fallback-src="/avatars/default/keeper-256.png"
                />
              </span>
              <figcaption>{size}px{size <= 64 ? " · Discord crop" : ""}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <div className="account-avatar__tabs" role="tablist" aria-label="Choose an avatar source">
        <button type="button" role="tab" aria-selected={tab === "default"} className="profile-option" data-selected={tab === "default"} onClick={() => setTab("default")}>
          <UserRound size={15} aria-hidden="true" /> Default collection
        </button>
        <button type="button" role="tab" aria-selected={tab === "discord"} className="profile-option" data-selected={tab === "discord"} onClick={() => setTab("discord")}>
          <Upload size={15} aria-hidden="true" /> Discord avatar
        </button>
        <button type="button" role="tab" aria-selected={tab === "upload"} className="profile-option" data-selected={tab === "upload"} onClick={() => setTab("upload")}>
          <ImagePlus size={15} aria-hidden="true" /> Upload a photo
        </button>
      </div>

      {tab === "default" ? (
        <section className="account-avatar__panel" aria-label="Illustrated default avatars">
          <div className="account-avatar__grid">
            {defaults.map((option) => (
              <button
                key={option.key}
                type="button"
                className={cn("account-avatar__option", avatar.kind === "default" && avatar.defaultKey === option.key && "is-selected")}
                onClick={() => chooseDefault(option.key)}
                disabled={busy}
                aria-pressed={avatar.kind === "default" && avatar.defaultKey === option.key}
              >
                <img src={`/avatars/default/${option.key}-256.png`} alt="" width="96" height="96" loading="lazy" />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.note}</small>
                </span>
                {avatar.kind === "default" && avatar.defaultKey === option.key ? <Check size={16} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          <p className="account-avatar__hint">
            The default is ready to use. Every option is an original Foilbury illustration, rendered at real avatar
            sizes and reviewed in a circular Discord crop.
          </p>
        </section>
      ) : null}

      {tab === "discord" ? (
        <section className="account-avatar__panel" aria-label="Discord avatar">
          {discord.linked ? (
            <div className="account-avatar__discord">
              <div>
                <p className="eyebrow">Linked Discord</p>
                <p className="account-avatar__title">{discord.name ? `@${discord.name}` : "Discord account"}</p>
                <p className="account-avatar__note">
                  {discord.hasAvatar
                    ? "Foilbury fetches the image once, stores it as a private asset, and refreshes it when your Discord avatar changes."
                    : "Your Discord account has no avatar set. The Keeper will stay as the fallback."}
                </p>
              </div>
              <Button type="button" onClick={useDiscord} disabled={busy || !discord.hasAvatar}>
                {busy ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                Use my Discord avatar
              </Button>
            </div>
          ) : (
            <div className="account-avatar__discord">
              <div>
                <p className="eyebrow">Discord</p>
                <p className="account-avatar__title">No Discord identity linked</p>
                <p className="account-avatar__note">
                  Link Discord with the same Foilbury account, then come back here to use its avatar.
                </p>
              </div>
              <a className="btn btn-primary btn-sm" href="/auth/discord/start?next=/account/avatar">
                Link Discord
              </a>
            </div>
          )}
        </section>
      ) : null}

      {tab === "upload" ? (
        <section className="account-avatar__panel" aria-label="Upload a photo">
          <AvatarCropper file={avatarFile} onFile={setAvatarFile} onUse={uploadAvatar} busy={busy} />
          <p className="account-avatar__hint">
            Your photo is cropped square, prepared at 64, 128 and 256 pixels and stored as a private member asset. It is
            served through the signed-in media path and only appears on a profile share when you explicitly create one.
          </p>
        </section>
      ) : null}

      <section id="banner" className="account-avatar__panel account-avatar__banner" aria-label="Profile banner">
        <div className="account-avatar__section-head">
          <div>
            <p className="eyebrow">Profile banner</p>
            <h2 className="profile-section__title">An optional 8:3 banner</h2>
            <p className="account-avatar__note">
              Use a collection banner in your composition, or upload one here. Uploads follow the same private asset rules
              as an avatar photo.
            </p>
          </div>
          {banner ? (
            <Button type="button" variant="secondary" size="sm" onClick={removeBanner} disabled={busy}>
              <Trash2 size={15} aria-hidden="true" /> Remove banner
            </Button>
          ) : null}
        </div>
        {banner ? (
          <figure className="account-avatar__banner-preview">
            <img
              src={banner.src}
              srcSet={banner.srcSet ?? undefined}
              sizes="(max-width: 720px) 100vw, 720px"
              alt="Current uploaded profile banner"
              width="720"
              height="270"
            />
            <figcaption>Private uploaded banner · choose “Uploaded banner” in the profile composition.</figcaption>
          </figure>
        ) : null}
        <BannerCropper file={bannerFile} onFile={setBannerFile} onUse={uploadBanner} busy={busy} />
      </section>

      <p className="account-avatar__hint">
        <RotateCcw size={14} aria-hidden="true" /> Changes are audited as account identity events. Removing an upload
        deletes its private renditions; a missed image always falls back to the Keeper, never your initials.
      </p>
    </div>
  );
}
