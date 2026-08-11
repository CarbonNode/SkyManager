/* icon_knockout.js — strip the baked dark badge plate from a generated deck icon,
 * leaving the gold emblem on full transparency (the deck's .hk-ico row plate is
 * the only plate an icon should have).
 *
 * Companion to the Forge saved prompt `skyrim-deck-gold-glyph` (the approved
 * gold-linework favicon/SVG icon style, Rober 2026-08-03/04). The generators
 * always bake a dark badge behind the glyph; this removes it deterministically —
 * do NOT reach for AI background removal, line art survives keying better.
 *
 * Usage:
 *   node icon_knockout.js <srcDir> <outDir> [--sheet <sheet.png>] [--tune name.png=95 ...]
 *
 * Needs `sharp` (npm install sharp anywhere, e.g. /tmp). Verified on the 29-icon
 * hk-* set 2026-08-04 (commit 03d90e5); review your output on a mock row plate
 * before shipping — pass --sheet to get that contact sheet.
 *
 * How it works, per image:
 *  1. KEY: alpha ramps on max(R,G,B) between a per-image plate level (p95 of the
 *     outer 12px border ring, +8, clamped 30..110) and plate+75, smoothstepped.
 *  2. CLASSIFY connected components of what survived:
 *       - bbox hugs ALL FOUR canvas edges (<8% inset) AND >40% of its pixels lie
 *         in the outer 12% zone  -> badge rim frame, drop. (The edge-zone test is
 *         what saves full-canvas ART like a scroll from being called a frame.)
 *       - never overlaps the central 40% box -> glossy corner sheen / vignette
 *         junk, drop.
 *       - everything else is art, keep — even if it reaches the edge band
 *         (sun rays, guard spears, oval frames all legitimately do).
 *  3. ESCAPE HATCH: if >40% of the canvas survived, the plate fill itself was
 *     keyed in (dark inset badge) — redo once with the strict lo=110.
 *  4. CROP: square re-crop around the art bbox +8% margin, resized to 256, so
 *     emblems fill their tiles evenly.
 *
 * --tune overrides the keying floor per file for the two failure shapes the
 * auto rule gets wrong: a bright badge rim next to DIM art (border p95 forces
 * lo=110 and eats the art -> tune DOWN to plate-p85+12), and a glossy sheen the
 * component filter keeps (tune UP past the sheen). The hk-* set needed
 * hk-full-save.png=70 and hk-bed.png=95.
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SRC = args[0];
const OUT = args[1];
if (!SRC || !OUT) { console.error('usage: node icon_knockout.js <srcDir> <outDir> [--sheet out.png] [--tune f.png=95 ...]'); process.exit(1); }
const TUNED = {};
let SHEET = null;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--sheet') SHEET = args[++i];
  else if (args[i] === '--tune') { const [k, v] = args[++i].split('='); TUNED[k] = +v; }
}
fs.mkdirSync(OUT, { recursive: true });

async function processOne(file, forceLo) {
  const { data, info } = await sharp(path.join(SRC, file))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;

  // plate level from the border ring (outer 12px)
  const borderV = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (x < 12 || x >= w - 12 || y < 12 || y >= h - 12) {
      const i = (y * w + x) * c;
      borderV.push(Math.max(data[i], data[i + 1], data[i + 2]));
    }
  borderV.sort((a, b) => a - b);
  const p95 = borderV[Math.floor(borderV.length * 0.95)];
  const lo = forceLo || TUNED[file] || Math.min(110, Math.max(30, p95 + 8));
  const hi = Math.min(235, lo + 75);

  // 1. key
  for (let p = 0; p < w * h; p++) {
    const i = p * c;
    const v = Math.max(data[i], data[i + 1], data[i + 2]);
    let t = (v - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t);
    data[i + 3] = Math.round(Math.min(data[i + 3], t * 255));
  }

  // 2. classify components
  const kept = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (data[p * c + 3] > 25) kept[p] = 1;
  const label = new Int32Array(w * h).fill(-1);
  const boxes = [];
  let nLabels = 0;
  const stack = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!kept[p0] || label[p0] !== -1) continue;
    const L = nLabels++;
    boxes.push([w, h, 0, 0]);
    stack.push(p0); label[p0] = L;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      const b = boxes[L];
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      if (x > 0     && kept[p - 1] && label[p - 1] === -1) { label[p - 1] = L; stack.push(p - 1); }
      if (x < w - 1 && kept[p + 1] && label[p + 1] === -1) { label[p + 1] = L; stack.push(p + 1); }
      if (y > 0     && kept[p - w] && label[p - w] === -1) { label[p - w] = L; stack.push(p - w); }
      if (y < h - 1 && kept[p + w] && label[p + w] === -1) { label[p + w] = L; stack.push(p + w); }
    }
  }
  const inset = 0.08 * w, c0 = 0.30 * w, c1 = 0.70 * w, zone = 0.12 * w;
  const pxTotal = new Float64Array(nLabels), pxEdge = new Float64Array(nLabels);
  for (let p = 0; p < w * h; p++) {
    if (!kept[p]) continue;
    const L = label[p], x = p % w, y = (p / w) | 0;
    pxTotal[L]++;
    if (x < zone || x >= w - zone || y < zone || y >= h - zone) pxEdge[L]++;
  }
  const drop = boxes.map((b, L) => {
    const hugsBBox = b[0] < inset && b[1] < inset && b[2] > w - 1 - inset && b[3] > h - 1 - inset;
    const isFrame = hugsBBox && pxEdge[L] / pxTotal[L] > 0.4;
    const hitsCenter = b[0] < c1 && b[2] > c0 && b[1] < c1 && b[3] > c0;
    return isFrame || !hitsCenter;
  });
  let dropped = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let p = 0; p < w * h; p++) {
    if (!kept[p]) continue;
    if (drop[label[p]]) { data[p * c + 3] = 0; dropped++; continue; }
    const x = p % w, y = (p / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  // 3. solid-badge escape hatch
  let keptAfter = 0;
  for (let p = 0; p < w * h; p++) if (data[p * c + 3] > 25) keptAfter++;
  if (!forceLo && keptAfter > 0.4 * w * h) return processOne(file, 110);

  // 4. crop
  let img = sharp(data, { raw: { width: w, height: h, channels: c } });
  const bw = maxX - minX, bh = maxY - minY;
  if (bw > 40 && bh > 40) {
    const side = Math.min(Math.max(bw, bh) * 1.16, Math.min(w, h));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const left = Math.round(Math.min(Math.max(0, cx - side / 2), w - side));
    const top = Math.round(Math.min(Math.max(0, cy - side / 2), h - side));
    img = img.extract({ left, top, width: Math.round(side), height: Math.round(side) })
             .resize(256, 256);
  }
  await img.png().toFile(path.join(OUT, file));
  return { file, p95, lo, dropped, bbox: `${bw}x${bh}` };
}

async function sheet(dir, outFile) {
  // contact sheet on a mock .hk-ico row plate — review THIS, not bare files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  const COLS = 6, CELL = 150, PAD = 10;
  const W = COLS * CELL, H = Math.ceil(files.length / COLS) * CELL;
  const plate = Buffer.from(
    '<svg width="96" height="96"><rect x="1" y="1" width="94" height="94" rx="14" fill="#0c0c10" stroke="#30303a" stroke-width="2"/></svg>');
  const comps = [];
  for (let i = 0; i < files.length; i++) {
    const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
    comps.push({ input: plate, left: x + 27, top: y + PAD });
    comps.push({ input: await sharp(path.join(dir, files[i])).resize(84, 84).png().toBuffer(), left: x + 33, top: y + PAD + 6 });
    comps.push({
      input: Buffer.from('<svg width="' + CELL + '" height="24"><text x="' + CELL / 2 + '" y="16" font-family="sans-serif" font-size="13" fill="#b8b4aa" text-anchor="middle">' + files[i].replace('.png', '') + '</text></svg>'),
      left: x, top: y + PAD + 100,
    });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: '#17171d' } })
    .composite(comps).png().toFile(outFile);
  console.log('sheet:', outFile);
}

(async () => {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.png'));
  for (const f of files) console.log(JSON.stringify(await processOne(f)));
  if (SHEET) await sheet(OUT, SHEET);
})();
