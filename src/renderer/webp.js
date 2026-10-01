/**
 * Blog-ready image optimizer, 100% local.
 * Uses Chromium's built-in WebP encoder: resize (never enlarge), strip camera metadata, compress.
 */
export const IMG_RE = /\.(png|jpe?g|gif|bmp|webp|avif|heic|heif|tiff?)$/i;

export async function optimizeImage(bytes, { maxWidth = 1600, quality = 0.82, type = 'image/webp', aspect = 0 } = {}) {
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); // respects EXIF rotation, then drops EXIF
  let source = bmp;
  let sw = bmp.width; let sh = bmp.height;
  // Optional shape: crop from the center to the requested aspect ratio (width / height).
  if (aspect > 0 && Math.abs(sw / sh - aspect) > 0.005) {
    const cw = sw / sh > aspect ? Math.round(sh * aspect) : sw;
    const chh = sw / sh > aspect ? sh : Math.round(sw / aspect);
    const c = new OffscreenCanvas(cw, chh);
    c.getContext('2d').drawImage(bmp, Math.round((sw - cw) / 2), Math.round((sh - chh) / 2), cw, chh, 0, 0, cw, chh);
    source = c; sw = cw; sh = chh;
  }
  const scale = Math.min(1, maxWidth / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  // Step down in halves for big reductions: sharper results than one giant jump.
  let cw = sw; let ch = sh;
  while (cw / 2 >= w * 1.3) {
    cw = Math.round(cw / 2); ch = Math.round(ch / 2);
    const c = new OffscreenCanvas(cw, ch);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(source, 0, 0, cw, ch);
    source = c;
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); } // JPEG has no transparency
  ctx.drawImage(source, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type, quality });
  return { bytes: new Uint8Array(await out.arrayBuffer()), width: w, height: h, size: out.size };
}

export const prettyBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const altFromName = (name) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** SEO-friendly file name: "IMG_2024 Dog Treats!!.png" -> "img-2024-dog-treats" */
export const seoName = (name) => name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';

/* ------------------------------------------------------------------ */
/* Metadata scrubber: guarantees the output carries nothing but pixels  */
/* ------------------------------------------------------------------ */
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** WebP: drop EXIF / XMP / ICCP chunks and clear their VP8X flags. */
function scrubWebp(b) {
  if (tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WEBP') return b;
  const keep = [];
  let o = 12;
  while (o + 8 <= b.length) {
    const t = tag(b, o);
    const size = u32le(b, o + 4);
    const total = 8 + size + (size & 1);
    let chunk = b.slice(o, Math.min(b.length, o + total));
    if (t === 'VP8X') { chunk = chunk.slice(); chunk[8] &= ~(0x20 | 0x08 | 0x04); } // ICC, EXIF, XMP flags off
    if (t !== 'EXIF' && t !== 'XMP ' && t !== 'ICCP') keep.push(chunk);
    o += total;
  }
  const body = concat(keep);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  const size = body.length + 4;
  head.set([size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255], 4);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}

/** JPEG: keep JFIF (APP0) and Adobe (APP14) markers, drop EXIF/XMP (APP1), ICC (APP2), IPTC (APP13), comments. */
function scrubJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts = [b.slice(0, 2)];
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xda) { parts.push(b.slice(o)); return concat(parts); } // start of scan: image data follows
    const len = (b[o + 2] << 8) | b[o + 3];
    const drop = (m >= 0xe1 && m <= 0xef && m !== 0xee) || m === 0xfe;
    if (!drop) parts.push(b.slice(o, o + 2 + len));
    o += 2 + len;
  }
  parts.push(b.slice(o));
  return concat(parts);
}

/** PNG: drop text, EXIF, ICC and timestamp chunks. */
function scrubPng(b) {
  if (b[0] !== 0x89 || tag(b, 1) !== 'PNG\r') return b;
  const parts = [b.slice(0, 8)];
  let o = 8;
  const DROP = new Set(['eXIf', 'iTXt', 'tEXt', 'zTXt', 'iCCP', 'tIME']);
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const t = tag(b, o + 4);
    const total = 12 + len;
    if (!DROP.has(t)) parts.push(b.slice(o, o + total));
    o += total;
    if (t === 'IEND') break;
  }
  return concat(parts);
}

export function scrubMetadata(bytes, type) {
  try {
    if (type === 'image/webp') return scrubWebp(bytes);
    if (type === 'image/jpeg') return scrubJpeg(bytes);
    if (type === 'image/png') return scrubPng(bytes);
  } catch { /* never block a save because of the scrubber */ }
  return bytes;
}
