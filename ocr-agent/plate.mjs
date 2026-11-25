// Thai licence plate reader: OpenCV.js finds and straightens the plate, Tesseract.js reads it.
// Runs entirely on this computer (no cloud, no quota).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { PROVINCES } from './provinces.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const THAI_CONSONANTS = 'กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ';
const PLATE_CHARS = THAI_CONSONANTS + '0123456789 -';
// Thai plates are 34 × 15 cm (ratio ≈ 2.27). Motorcycle plates are closer to 1.6.
const MIN_RATIO = 1.4;
const MAX_RATIO = 5.5;

let cvPromise;
/** OpenCV.js is a "thenable" that resolves to itself, so poll for readiness instead of awaiting it. */
function loadCv() {
  cvPromise ??= new Promise((resolve, reject) => {
    const cv = require('@techstark/opencv-js');
    const started = Date.now();
    const tick = () => {
      // Wrap it: resolving a promise with a thenable would wait on it forever.
      if (cv.Mat) return resolve({ cv });
      if (Date.now() - started > 60_000) return reject(new Error('OpenCV failed to load'));
      setTimeout(tick, 50);
    };
    tick();
  });
  return cvPromise;
}

let digitWorkerPromise;
/** The English model reads digits far more reliably (and confidently) than the Thai model. */
async function getDigitWorker() {
  digitWorkerPromise ??= (async () => {
    const langPath = join(here, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
    const w = await createWorker('eng', OEM.LSTM_ONLY, { langPath, gzip: true, cachePath: join(here, '.tesscache') });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789', user_defined_dpi: '300' });
    return w;
  })();
  return digitWorkerPromise;
}

let workerPromise;
async function getWorker() {
  workerPromise ??= (async () => {
    const langPath = join(here, 'node_modules', '@tesseract.js-data', 'tha', '4.0.0_best_int');
    const w = await createWorker('tha', OEM.LSTM_ONLY, { langPath, gzip: true, cachePath: join(here, '.tesscache') });
    return w;
  })();
  return workerPromise;
}

/** Decode any image (JPEG/PNG/HEIC where supported) to RGBA, auto-rotated, at most 1400 px wide. */
async function decode(buffer) {
  const { data, info } = await sharp(buffer).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

function orderCorners(pts) {
  // [top-left, top-right, bottom-right, bottom-left]
  const sum = pts.map((p) => p.x + p.y);
  const diff = pts.map((p) => p.y - p.x);
  return [pts[sum.indexOf(Math.min(...sum))], pts[diff.indexOf(Math.min(...diff))], pts[sum.indexOf(Math.max(...sum))], pts[diff.indexOf(Math.max(...diff))]];
}

function rectCorners(rr, grow = 1.06) {
  // Corners of an OpenCV RotatedRect, slightly enlarged so the plate edge is not cut.
  const { center, size, angle } = rr;
  const a = (angle * Math.PI) / 180;
  const w = (size.width * grow) / 2, h = (size.height * grow) / 2;
  const c = Math.cos(a), s = Math.sin(a);
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: center.x + x * c - y * s, y: center.y + x * s + y * c }));
}

function quadSize([tl, tr, br, bl]) {
  const w = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
  const h = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
  return { w, h };
}

/** Candidates from edges: 4-cornered convex shapes with a plate-like ratio. */
function edgeCandidates(cv, gray, imgArea) {
  const out = [];
  const blur = new cv.Mat();
  cv.bilateralFilter(gray, blur, 9, 75, 75);
  const edges = new cv.Mat();
  cv.Canny(blur, edges, 50, 150);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area > imgArea * 0.004 && area < imgArea * 0.95) {
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let k = 0; k < 4; k++) pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
        const corners = orderCorners(pts);
        const { w, h } = quadSize(corners);
        const ratio = w / Math.max(1, h);
        if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) out.push({ corners, w, h, score: area, kind: 'edge' });
      }
      approx.delete();
    }
    c.delete();
  }
  contours.delete();
  hierarchy.delete();
  edges.delete();
  blur.delete();
  kernel.delete();
  return out;
}

/**
 * Candidates from colour: Thai plates have a white, yellow (commercial/trucks) or light
 * background. Light blobs with a plate-like ratio are found even when the frame is hidden
 * by a bumper or a shadow, which edge detection misses.
 */
function colourCandidates(cv, rgb, imgArea) {
  const out = [];
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const ranges = [
    // Yellow plates in shade are dark (V ≈ 40–70) but stay strongly saturated.
    { kind: 'yellow', lo: [10, 90, 35, 0], hi: [40, 255, 255, 255] },
    { kind: 'white', lo: [0, 0, 150, 0], hi: [180, 55, 255, 255] },
  ];
  for (const r of ranges) {
    const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), r.lo);
    const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), r.hi);
    const mask = new cv.Mat();
    cv.inRange(hsv, lo, hi, mask);
    // Close the gaps left by the dark characters so the plate becomes one blob.
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(hsv.cols * 0.025)), Math.max(3, Math.round(hsv.rows * 0.012))));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > imgArea * 0.003 && area < imgArea * 0.9) {
        const rr = cv.minAreaRect(c);
        let { width: w, height: h } = rr.size;
        const long = Math.max(w, h), short = Math.min(w, h);
        const ratio = long / Math.max(1, short);
        const fill = area / Math.max(1, w * h);
        if (ratio >= MIN_RATIO && ratio <= MAX_RATIO && fill > 0.45) {
          // Normalise so the long side is horizontal.
          const rot = w >= h ? rr : { center: rr.center, size: { width: h, height: w }, angle: rr.angle + 90 };
          const corners = orderCorners(rectCorners(rot));
          out.push({ corners, w: long, h: short, score: area * fill * (r.kind === 'yellow' ? 1.3 : 1), kind: r.kind });
        }
      }
      c.delete();
    }
    contours.delete();
    hier.delete();
    k.delete();
    mask.delete();
    lo.delete();
    hi.delete();
  }
  hsv.delete();
  return out;
}

function overlap(a, b) {
  const box = (q) => ({ x0: Math.min(...q.corners.map((p) => p.x)), x1: Math.max(...q.corners.map((p) => p.x)), y0: Math.min(...q.corners.map((p) => p.y)), y1: Math.max(...q.corners.map((p) => p.y)) });
  const A = box(a), B = box(b);
  const iw = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)), ih = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
  const inter = iw * ih;
  return inter / Math.max(1, (A.x1 - A.x0) * (A.y1 - A.y0) + (B.x1 - B.x0) * (B.y1 - B.y0) - inter);
}

/** Straighten a candidate into a flat grey plate image. */
function warp(cv, gray, cand) {
  const W = 680;
  const H = Math.round(W / Math.max(1.4, Math.min(5.5, cand.w / cand.h)));
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, cand.corners.flatMap((p) => [p.x, p.y]));
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const out = new cv.Mat();
  cv.warpPerspective(gray, out, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  srcTri.delete();
  dstTri.delete();
  M.delete();
  return out;
}

/**
 * Find the plate and return up to 3 straightened candidate crops (best first) plus the
 * centre of the photo as a last resort. The capture workflow has a dedicated plate step,
 * so the plate is usually large, but photos taken from further away still work.
 */
function plateCandidates(cv, src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const imgArea = src.rows * src.cols;
  const all = [...colourCandidates(cv, rgb, imgArea), ...edgeCandidates(cv, gray, imgArea)].sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of all) {
    if (picked.length >= 3) break;
    if (!picked.some((p) => overlap(p, c) > 0.5)) picked.push(c);
  }
  const crops = picked.map((c) => ({ mat: warp(cv, gray, c), found: true, kind: c.kind }));
  const r = new cv.Rect(Math.round(gray.cols * 0.1), Math.round(gray.rows * 0.15), Math.round(gray.cols * 0.8), Math.round(gray.rows * 0.7));
  crops.push({ mat: gray.roi(r).clone(), found: false, kind: 'centre' });
  rgb.delete();
  gray.delete();
  return crops;
}

/** Binarise for Tesseract: dark text on white. */
function binarize(cv, mat) {
  const blur = new cv.Mat();
  // Local contrast boost so plates in shade or half in sunlight still separate from their text.
  try {
    const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
    clahe.apply(mat, blur);
    clahe.delete();
    cv.GaussianBlur(blur, blur, new cv.Size(3, 3), 0);
  } catch {
    cv.GaussianBlur(mat, blur, new cv.Size(3, 3), 0);
  }
  const bin = new cv.Mat();
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  if (cv.mean(bin)[0] < 127) cv.bitwise_not(bin, bin);
  blur.delete();
  return bin;
}

/**
 * Keep only character-shaped blobs: drop the plate frame (blobs touching the edge),
 * screws, dirt specks and long bars. Returns a new clean black-on-white image.
 */
function keepCharacters(cv, bin) {
  const inv = new cv.Mat();
  cv.bitwise_not(bin, inv);
  // Break thin bridges between a character and the plate frame / dirt.
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.morphologyEx(inv, inv, cv.MORPH_OPEN, k);
  k.delete();
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
  const H = bin.rows, W = bin.cols;
  const comps = [];
  for (let i = 1; i < n; i++) {
    const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
    const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT);
    comps.push({ i, x, y, w, h, edgeL: x <= 0, edgeR: x + w >= W });
  }
  const charLike = (c) => c.h >= H * 0.35 && c.h < H * 0.97 && c.w >= 2;
  const free = comps.filter((c) => charLike(c) && !c.edgeL && !c.edgeR && c.w <= W * 0.3);
  const ws = free.map((c) => c.w).sort((a, b) => a - b);
  const mw = ws.length ? ws[Math.floor(ws.length / 2)] : H * 0.6;
  // Per component: [xFrom, xTo) of columns to keep, or null to drop.
  // The dash in "72-5239" is dropped on purpose: the blank gap then splits the plate cleanly.
  const clip = new Array(n).fill(null);
  let kept = 0;
  for (const c of comps) {
    if (!charLike(c)) continue;
    if (!c.edgeL && !c.edgeR) {
      if (c.w <= W * 0.3) { clip[c.i] = [c.x, c.x + c.w]; kept++; }
      continue;
    }
    // A character welded to the plate frame at the edge: keep only a character-wide slice
    // on the inner side (or the whole blob if it is no wider than a character).
    if (c.w <= mw * 1.3) clip[c.i] = [c.x, c.x + c.w];
    else if (c.edgeL && !c.edgeR) clip[c.i] = [c.x + c.w - Math.round(mw * 1.1), c.x + c.w];
    else if (c.edgeR && !c.edgeL) clip[c.i] = [c.x, c.x + Math.round(mw * 1.1)];
    if (clip[c.i]) kept++;
  }
  const out = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
  if (kept >= 2) {
    const L = labels.data32S;
    for (let p = 0; p < L.length; p++) {
      const r = clip[L[p]];
      if (r) {
        const x = p % W;
        if (x >= r[0] && x < r[1]) out.data[p] = 0;
      }
    }
  } else bin.copyTo(out);
  for (const m of [inv, labels, stats, cents]) m.delete();
  return out;
}

/** Scale so text is ~140 px tall (Tesseract reads best at that size), binarise, clean, pad. */
function prepareForOcr(cv, mat, targetHeight = 160, clean = false) {
  const scale = Math.max(0.5, Math.min(6, targetHeight / Math.max(1, mat.rows)));
  const up = new cv.Mat();
  cv.resize(mat, up, new cv.Size(0, 0), scale, scale, cv.INTER_CUBIC);
  const raw = binarize(cv, up);
  const bin = clean ? keepCharacters(cv, raw) : raw;
  if (clean) raw.delete();
  const padded = new cv.Mat();
  cv.copyMakeBorder(bin, padded, 24, 24, 24, 24, cv.BORDER_CONSTANT, new cv.Scalar(255));
  up.delete();
  bin.delete();
  return padded;
}

/**
 * Locate the registration line inside the plate: the row band holding the TALLEST
 * characters. This skips small print such as "THAILAND 15" above the number and the
 * province name below it, whatever the plate layout.
 */
function findTextBand(cv, plate) {
  const bin = binarize(cv, plate);
  const inv = new cv.Mat();
  cv.bitwise_not(bin, inv);
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
  const H = plate.rows, W = plate.cols;
  const comps = [];
  for (let i = 1; i < n; i++) {
    const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
    const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT), a = stats.intAt(i, cv.CC_STAT_AREA);
    if (h >= H * 0.15 && h <= H * 0.85 && w <= W * 0.3 && w >= 2 && a >= W * H * 0.0015 && x > 1 && x + w < W - 1) comps.push({ x, y, w, h });
  }
  for (const m of [bin, inv, labels, stats, cents]) m.delete();
  if (comps.length < 2) return null;
  const maxH = Math.max(...comps.map((c) => c.h));
  const tall = comps.filter((c) => c.h >= maxH * 0.65);
  if (tall.length < 2) return null;
  const pad = Math.round(maxH * 0.22);
  const y0 = Math.max(0, Math.min(...tall.map((c) => c.y)) - pad);
  const y1 = Math.min(H, Math.max(...tall.map((c) => c.y + c.h)) + pad);
  // A character stuck to the plate frame is filtered out above, so the tall characters'
  // own x-range could cut it off — use the whole width instead.
  // Full plate width; keepCharacters() removes the frame pieces at the edges afterwards.
  const x0 = Math.round(W * 0.02), x1 = Math.round(W * 0.98);
  return { reg: new cv.Rect(x0, y0, x1 - x0, y1 - y0), provinceTop: y1 };
}

/**
 * Split the registration line at its widest blank gap: "[digit]letters | digits" or
 * "NN | NNNN" (trucks), so each part is read with its own character set.
 */
function splitAtGap(cv, bin) {
  const cols = bin.cols, rows = bin.rows;
  const ink = new Array(cols).fill(0);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (bin.data[y * cols + x] < 128) ink[x]++;
  const isInk = ink.map((n) => n > rows * 0.02);
  const first = isInk.indexOf(true), last = isInk.lastIndexOf(true);
  if (first < 0) return null;
  let best = null, start = -1;
  for (let x = first; x <= last; x++) {
    if (!isInk[x] && start < 0) start = x;
    if (isInk[x] && start >= 0) {
      if (!best || x - start > best.w) best = { x: start, w: x - start };
      start = -1;
    }
  }
  if (!best || best.w < (last - first) * 0.04) return null;
  const mid = best.x + Math.round(best.w / 2);
  const pad = (m) => {
    const out = new cv.Mat();
    cv.copyMakeBorder(m, out, 0, 0, 24, 24, cv.BORDER_CONSTANT, new cv.Scalar(255));
    m.delete();
    return out;
  };
  return { left: pad(bin.roi(new cv.Rect(0, 0, mid, rows)).clone()), right: pad(bin.roi(new cv.Rect(mid, 0, cols - mid, rows)).clone()) };
}

async function matToPng(mat) {
  return sharp(Buffer.from(mat.data), { raw: { width: mat.cols, height: mat.rows, channels: 1 } }).png().toBuffer();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Closest of the 77 provinces, if the OCR text is reasonably close to one. */
export function matchProvince(text) {
  const t = (text || '').replace(/[^฀-๿]/g, '');
  if (t.length < 3) return null;
  let best = null;
  for (const p of PROVINCES) {
    const dist = levenshtein(t, p) / Math.max(t.length, p.length);
    if (!best || dist < best.dist) best = { name: p, dist };
  }
  return best && best.dist <= 0.45 ? best.name : null;
}

/** Pick the plate from OCR text: "[digit]letters digits" or the truck format "NN-NNNN". */
export function parseRegistration(text) {
  const t = (text || '').replace(/[^0-9ก-ฮ\s-]/g, ' ');
  const m = /([0-9]?\s?[ก-ฮ]{1,3})\s*-?\s*([0-9]{1,4})(?![0-9])/.exec(t);
  if (m) return `${m[1].replace(/\s/g, '')} ${m[2]}`;
  const n = /(?:^|\D)(\d{2})\s*-?\s*(\d{4})(?!\d)/.exec(t);
  return n ? `${n[1]}-${n[2]}` : null;
}

const DIGITS = '0123456789';

/** Read one candidate plate crop. Returns { plate, confidence, text, province } or plate=null. */
async function readCandidate(cv, worker, plate, debug) {
  const line = async (png, whitelist) => {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: whitelist, user_defined_dpi: '300', preserve_interword_spaces: '1' });
    return (await worker.recognize(png)).data;
  };
  const digitWorker = await getDigitWorker();
  const digitsLine = async (png) => (await digitWorker.recognize(png)).data;
  const band = findTextBand(cv, plate);
  const regMat = band ? plate.roi(band.reg) : plate.roi(new cv.Rect(0, 0, plate.cols, Math.round(plate.rows * 0.62)));
  const provTop = band ? band.provinceTop : Math.round(plate.rows * 0.62);
  const provMat = plate.roi(new cv.Rect(0, Math.min(plate.rows - 2, provTop), plate.cols, Math.max(2, plate.rows - provTop)));
  const regBin = prepareForOcr(cv, regMat, 160, true);
  const provBin = prepareForOcr(cv, provMat, 90);
  regMat.delete();
  provMat.delete();
  const parts = splitAtGap(cv, regBin);
  const regPng = await matToPng(regBin);
  if (debug) debug.push(['reg', regPng]);
  let best = { plate: null, confidence: 0, text: '' };
  if (parts) {
    const [lp, rp] = await Promise.all([matToPng(parts.left), matToPng(parts.right)]);
    parts.left.delete();
    parts.right.delete();
    const R = await digitsLine(rp);
    const digits = R.text.replace(/\D/g, '');
    const L = await line(lp, THAI_CONSONANTS + DIGITS);
    const letters = L.text.replace(/[^0-9ก-ฮ]/g, '');
    if (process.env.DEBUG_OCR) console.error('[ocr] left(th)=%j right(digits)=%j conf=%d/%d', L.text, R.text, L.confidence, R.confidence);
    // Confidence = per-character weighted average of the two parts.
    const wconf = (a, na, b, nb) => (a * na + b * nb) / Math.max(1, na + nb) / 100;
    if (/^[0-9]?[ก-ฮ]{1,3}$/.test(letters) && /^\d{1,4}$/.test(digits)) {
      let conf = wconf(L.confidence, letters.length, R.confidence, digits.length);
      // Current plates have at most 2 consonants (optionally after a digit): 3 means a misread digit.
      if (/^[ก-ฮ]{3}$/.test(letters)) conf *= 0.5;
      best = { plate: `${letters} ${digits}`, confidence: conf, text: `${L.text.trim()} ${R.text.trim()}` };
    } else {
      // Truck / numeric plates: "NN-NNNN".
      // Truck / numeric plates "NN-NNNN": accept the prefix from whichever model reads exactly 2 digits.
      const Ld = await digitsLine(lp);
      const fromThai = letters.replace(/\D/g, '');
      const engLeft = Ld.text.replace(/\D/g, '');
      const useEng = /^\d{2}$/.test(engLeft) && (Ld.confidence >= L.confidence || !/^\d{2}$/.test(fromThai));
      const left = useEng ? engLeft : /^\d{2}$/.test(fromThai) && letters === fromThai ? fromThai : engLeft;
      const leftConf = useEng ? Ld.confidence : L.confidence;
      if (process.env.DEBUG_OCR) console.error('[ocr] left(digits)=%j conf=%d', Ld.text, Ld.confidence);
      if (/^\d{2}$/.test(left) && /^\d{4}$/.test(digits)) {
        best = { plate: `${left}-${digits}`, confidence: wconf(leftConf, 2, R.confidence, 4), text: `${left} ${R.text.trim()}` };
      } else best.text = `${L.text.trim()} ${R.text.trim()}`;
    }
  }
  if (!best.plate) {
    const reg = await line(regPng, PLATE_CHARS);
    const p = parseRegistration(reg.text);
    if (p) best = { plate: p, confidence: (reg.confidence / 100) * 0.9, text: reg.text.trim() };
    else if (!best.text) best.text = reg.text.trim();
  }
  regBin.delete();
  const prov = await line(await matToPng(provBin), '');
  provBin.delete();
  return { ...best, province: matchProvince(prov.text), provinceText: prov.text.trim() };
}

/**
 * Read a plate photo. Tries the best few plate candidates (colour and edge based) and keeps
 * the most confident valid reading. Returns { plate, province, text, confidence, plateFound, timings }.
 */
export async function readPlate(buffer, { debugDir } = {}) {
  const t0 = Date.now();
  const { cv } = await loadCv();
  const worker = await getWorker();
  const img = await decode(buffer);
  const src = cv.matFromImageData(img);
  const crops = plateCandidates(cv, src);
  src.delete();
  const tFind = Date.now();
  const debug = debugDir ? [] : null;
  let best = null;
  for (let i = 0; i < crops.length; i++) {
    const c = crops[i];
    if (debug) debug.push([`candidate-${i}-${c.kind}`, await matToPng(c.mat)]);
    // Stop early once a confident reading is found.
    if (best && best.plate && best.confidence >= 0.8) break;
    const r = await readCandidate(cv, worker, c.mat, debug);
    const score = (r.plate ? 1 : 0) + r.confidence + (c.found ? 0.05 : 0);
    if (!best || score > best.score) best = { ...r, score, found: c.found };
  }
  for (const c of crops) c.mat.delete();
  if (debugDir && debug) {
    const fs = await import('node:fs/promises');
    await fs.mkdir(debugDir, { recursive: true });
    await Promise.all(debug.map(([name, png], i) => fs.writeFile(join(debugDir, `${String(i).padStart(2, '0')}-${name}.png`), png)));
  }
  const text = [best.text, best.provinceText].filter(Boolean).join('\n');
  return {
    plate: best.plate,
    province: best.province,
    text: best.province ? `${text}\n[จังหวัด] ${best.province}` : text,
    confidence: best.plate ? Math.max(0, Math.min(1, best.confidence)) : 0,
    plateFound: best.found,
    timings: { findMs: tFind - t0, totalMs: Date.now() - t0 },
  };
}

/** "บร7865(เพชรบุรี)" → { plate: 'บร 7865', province } — the pattern printed on dispatch slips. */
export function parseSlip(text) {
  // Same rules as the server (src/shared/plate.ts extractSlipPlate): everything printed before
  // "(province)" that belongs to the registration, e.g. "บร7865(เพชรบุรี)", "กท12-345(…)",
  // "725067723224(พระนครศรีอยุธยา)". The server keeps the whole ID + province.
  const t = (text || '').normalize('NFC').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  for (const m of t.matchAll(/[(（]\s*([\u0E00-\u0E7F ]{2,30}?)\s*[)）]/g)) {
    const id = slipIdBefore(t.slice(0, m.index));
    if (!id) continue;
    const province = matchProvince(m[1]);
    const classic = /^[0-9]?[ก-ฮ]{1,3} ?-?\d{1,4}$/.test(id) || /^\d{2}-\d{4}$/.test(id);
    const cleaned = m[1].replace(/\s/g, '');
    if (province || (classic && cleaned.length >= 3)) return { plate: id.replace(/([ก-ฮ])(?=\d)/g, '$1 '), province, provinceText: cleaned };
  }
  return null;
}

function slipIdBefore(before) {
  const tokens = before.trimEnd().split(' ');
  const picked = [];
  for (let i = tokens.length - 1; i >= 0 && picked.length < 5; i--) {
    const tok = tokens[i];
    if (!/^[0-9A-Za-zก-ฮ./-]+$/.test(tok)) break;
    if (!/\d/.test(tok) && !/^[ก-ฮ]{1,3}$/.test(tok)) break;
    if (picked.length && /^[ก-ฮ]+\d/.test(picked[0]) && /^\d+$/.test(tok)) break;
    picked.unshift(tok);
  }
  const id = picked.join('').replace(/^[-./]+|[-./]+$/g, '');
  if (id.length < 2 || id.length > 24) return null;
  const digits = id.match(/\d/g)?.length ?? 0;
  if (digits < 1 || (digits < 3 && !/[ก-ฮ]/.test(id))) return null;
  return id;
}

/**
 * Read the plate printed on a document such as the dispatch slip ("ใบบาร์รถ"). The photo
 * may be taken sideways, so each rotation is tried until the "plate(province)" pattern is
 * found. A province that matches one of the 77 provinces makes the reading trustworthy.
 */
export async function readDocument(buffer, { debugDir } = {}) {
  const t0 = Date.now();
  const worker = await getWorker();
  const base = await sharp(buffer).rotate().toBuffer(); // apply EXIF orientation first
  const attempts = [
    [0, PSM.AUTO], [270, PSM.AUTO], [90, PSM.AUTO], [180, PSM.AUTO],
    [270, PSM.SPARSE_TEXT], [90, PSM.SPARSE_TEXT],
  ];
  let lastText = '';
  for (const [rot, psm] of attempts) {
    const img = await sharp(base).rotate(rot).resize({ width: 1800, height: 1800, fit: 'inside' }).grayscale().normalize().png().toBuffer();
    if (debugDir) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(join(debugDir, `doc-${rot}-${psm}.png`), img);
    }
    await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: '', user_defined_dpi: '300' });
    const { data } = await worker.recognize(img);
    lastText = data.text;
    const slip = parseSlip(data.text);
    if (slip) {
      const line = data.text.split('\n').find((l) => l.includes('(') || l.includes('（')) ?? '';
      return {
        plate: slip.plate,
        province: slip.province,
        // Structure + a real province name is strong evidence; without it, stay below the cut-off.
        confidence: slip.province ? 0.9 : 0.6,
        text: `${line.trim()}${slip.province ? `\n[จังหวัด] ${slip.province}` : ''}`.slice(0, 1500),
        plateFound: true,
        timings: { totalMs: Date.now() - t0, rotation: rot },
      };
    }
  }
  return { plate: null, province: null, confidence: 0, text: lastText.replace(/\s+/g, ' ').slice(0, 500), plateFound: false, timings: { totalMs: Date.now() - t0 } };
}

export async function shutdown() {
  if (workerPromise) await (await workerPromise).terminate();
  if (digitWorkerPromise) await (await digitWorkerPromise).terminate();
}
