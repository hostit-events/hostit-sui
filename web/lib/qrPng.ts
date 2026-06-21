// Client-only helpers to export a rendered ticket QR (an inline <svg>, from
// qrcode.react's QRCodeSVG) as a PNG — for download and native share. We
// rasterize the already-on-screen SVG rather than re-render a canvas QR, so the
// component tree stays SSR/jsdom-safe (no canvas at render time).

/** Rasterize a QR <svg> element to a square PNG blob at `px` device pixels. */
export async function svgQrToPngBlob(svg: SVGSVGElement, px = 720): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const svgText = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("QR rasterize failed"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.drawImage(img, 0, 0, px, px);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Share a PNG via the Web Share API when the platform can share files, else
 * fall back to a download. Returns how it was handled ("shared" | "downloaded"),
 * or "cancelled" if the user dismissed the native share sheet.
 */
export async function shareOrDownloadPng(
  blob: Blob,
  filename: string,
  title: string,
): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], filename, { type: "image/png" });
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (nav?.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title });
      return "shared";
    } catch (e) {
      // AbortError = user dismissed the sheet; treat as a no-op, not a failure.
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // Any other share failure (e.g. NotAllowedError) — fall back to download.
    }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}
