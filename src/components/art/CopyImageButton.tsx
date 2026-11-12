import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";

async function readPng(src: string): Promise<Blob> {
  const response = await fetch(src, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Image unavailable");
  const image = await response.blob();
  if (image.type === "image/png") return image;
  if (!image.type.startsWith("image/")) throw new Error("Response is not an image");

  const url = URL.createObjectURL(image);
  try {
    const bitmap = new Image();
    bitmap.src = url;
    await bitmap.decode();
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.naturalWidth;
    canvas.height = bitmap.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG conversion failed"))));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function CopyImageButton({ src, name }: { src: string; name: string }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const copying = useRef(false);

  useEffect(() => setReady(true), []);

  async function copyImage() {
    if (copying.current) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      setStatus("Image copying is unavailable here. Use Download.");
      return;
    }
    copying.current = true;
    setStatus("Copying image…");
    try {
      // Pass a promise so Safari can start the clipboard write during the click.
      const png = readPng(src);
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setStatus("Image copied");
    } catch {
      setStatus("Couldn’t copy the image. Use Download.");
    } finally {
      copying.current = false;
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className="btn btn-secondary min-h-11 gap-2 disabled:opacity-50"
        disabled={!ready}
        aria-label={`Copy image: ${name}`}
        aria-disabled={copying.current}
        onClick={copyImage}
      >
        <Copy size={15} aria-hidden="true" /> Copy image
      </button>
      <span role="status" className="max-w-56 text-xs text-[var(--muted)]">
        {status}
      </span>
    </div>
  );
}
