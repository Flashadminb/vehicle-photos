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

/**
 * Find the plate: edges → contours → 4-cornered shapes with a plate-like aspect ratio and a
 * light interior → the largest such shape, straightened with a perspective warp.
 * Our capture workflow has a dedicated "licence plate" step, so the plate is normally large
 * in the frame; if nothing is found, the whole photo (centre) is used instead.
 */
function findPlate(cv, src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.bilateralFilter(gray, blur, 9, 75, 75);
  const edges = new cv.Mat();
  cv.Canny(blur, edges, 50, 150);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const imgArea = src.rows * src.cols;
  let best = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < imgArea * 0.01 || area > imgArea * 0.95) {
      c.delete();
      continue;
    }
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts = [];
      for (let k = 0; k < 4; k++) pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
      const [tl, tr, br, bl] = orderCorners(pts);
      const w = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
      const h = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
      const ratio = w / Math.max(1, h);
      if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
        // Plates have a light background: check mean brightness inside the bounding box.
        const r = cv.boundingRect(approx);
        const roi = gray.roi(r);
        const mean = cv.mean(roi)[0];
        roi.delete();
        const score = area * (mean > 110 ? 1 : 0.3);
        if (!best || score > best.score) best = { corners: [tl, tr, br, bl], w, h, score, mean };
      }
    }
    approx.delete();
    c.delete();
  }
  contours.delete();
  hierarchy.delete();
  edges.delete();
  blur.delete();
  kernel.delete();

  let plate;
  let found = false;
  if (best) {
    found = true;
    const W = 680;
    const H = Math.round(W / Math.max(1.4, Math.min(5.5, best.w / best.h)));
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, best.corners.flatMap((p) => [p.x, p.y]));
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    plate = new cv.Mat();
    cv.warpPerspective(gray, plate, M, new cv.Size(W, H), cv.INTER_CUBIC);
    srcTri.delete();
    dstTri.delete();
    M.delete();
    // Trim the plate's own border frame.
    const inset = Math.round(H * 0.06);
    const inner = plate.roi(new cv.Rect(inset, inset, W - inset * 2, H - inset * 2));
    const copy = inner.clone();
    inner.delete();
    plate.delete();
    plate = copy;
  } else {
    // Fallback: the central 80 % of the photo.
    const r = new cv.Rect(Math.round(gray.cols * 0.1), Math.round(gray.rows * 0.15), Math.round(gray.cols * 0.8), Math.round(gray.rows * 0.7));
    plate = gray.roi(r).clone();
  }
  gray.delete();
  return { plate, found };
}

/** Binarise for Tesseract: upscale, Otsu threshold, dark text on white, white padding. */
function prepareForOcr(cv, mat) {
  const up = new cv.Mat();
  cv.resize(mat, up, new cv.Size(0, 0), 2, 2, cv.INTER_CUBIC);
  const bin = new cv.Mat();
  cv.GaussianBlur(up, up, new cv.Size(3, 3), 0);
  cv.threshold(up, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  if (cv.mean(bin)[0] < 127) cv.bitwise_not(bin, bin);
  const padded = new cv.Mat();
  const pad = 20;
  cv.copyMakeBorder(bin, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(255));
  up.delete();
  bin.delete();
  return padded;
}

/**
 * Split the registration line at its widest blank gap: Thai plates are
 * "[digit]letters  digits", so the left part holds the letters and the right part the
 * serial number. Each part is then read with its own character set, which avoids
 * errors like "789" being read as "7689".
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
  // Need a real word gap (not the space between two characters).
  if (!best || best.w < (last - first) * 0.04) return null;
  const mid = best.x + Math.round(best.w / 2);
  const left = bin.roi(new cv.Rect(0, 0, mid, rows)).clone();
  const right = bin.roi(new cv.Rect(mid, 0, cols - mid, rows)).clone();
  const pad = (m) => {
    const out = new cv.Mat();
    cv.copyMakeBorder(m, out, 0, 0, 20, 20, cv.BORDER_CONSTANT, new cv.Scalar(255));
    m.delete();
    return out;
  };
  return { left: pad(left), right: pad(right) };
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

/** Pick the plate number from OCR text: [digit]? + 1–3 Thai consonants + 1–4 digits. */
export function parseRegistration(text) {
  const t = (text || '').replace(/[^0-9ก-ฮ\s-]/g, ' ');
  const m = /([0-9]?\s?[ก-ฮ]{1,3})\s*-?\s*([0-9]{1,4})(?![0-9])/.exec(t);
  if (m) return `${m[1].replace(/\s/g, '')} ${m[2]}`;
  const n = /(\d{2})\s*-\s*(\d{4})/.exec(t);
  return n ? `${n[1]}-${n[2]}` : null;
}

/**
 * Read a plate photo. Returns { plate, province, text, confidence, plateFound, timings }.
 * `debugDir` (optional) saves the intermediate images for checking.
 */
export async function readPlate(buffer, { debugDir } = {}) {
  const t0 = Date.now();
  const { cv } = await loadCv();
  const worker = await getWorker();
  const img = await decode(buffer);
  const src = cv.matFromImageData(img);
  const { plate, found } = findPlate(cv, src);
  src.delete();
  const tFind = Date.now();

  // Registration = upper ~62 % of the plate; province = the lower part.
  const split = Math.round(plate.rows * 0.62);
  const top = plate.roi(new cv.Rect(0, 0, plate.cols, split));
  const bottom = plate.roi(new cv.Rect(0, split, plate.cols, plate.rows - split));
  const topBin = prepareForOcr(cv, top);
  const bottomBin = prepareForOcr(cv, bottom);
  const wholeBin = prepareForOcr(cv, plate);
  const parts = splitAtGap(cv, topBin);
  const [topPng, bottomPng, wholePng] = await Promise.all([matToPng(topBin), matToPng(bottomBin), matToPng(wholeBin)]);
  if (debugDir) {
    const fs = await import('node:fs/promises');
    await fs.mkdir(debugDir, { recursive: true });
    await Promise.all([
      fs.writeFile(join(debugDir, 'plate-top.png'), topPng),
      fs.writeFile(join(debugDir, 'plate-bottom.png'), bottomPng),
      fs.writeFile(join(debugDir, 'plate-whole.png'), wholePng),
    ]);
  }
  for (const m of [top, bottom, topBin, bottomBin, wholeBin, plate]) m.delete();

  const line = async (png, whitelist) => {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: whitelist, user_defined_dpi: '300', preserve_interword_spaces: '1' });
    return (await worker.recognize(png)).data;
  };
  let plateText = null;
  let confidence = 0;
  let text = '';
  // 1) Letters and number read separately (most accurate when the gap is found).
  if (parts) {
    const [lp, rp] = await Promise.all([matToPng(parts.left), matToPng(parts.right)]);
    parts.left.delete();
    parts.right.delete();
    const L = await line(lp, THAI_CONSONANTS + '0123456789');
    const R = await line(rp, '0123456789');
    const letters = L.text.replace(/[^0-9ก-ฮ]/g, '');
    const digits = R.text.replace(/\D/g, '');
    if (/^[0-9]?[ก-ฮ]{1,3}$/.test(letters) && /^\d{1,4}$/.test(digits)) {
      plateText = `${letters} ${digits}`;
      confidence = Math.min(L.confidence, R.confidence) / 100;
      // Current Thai plates have at most 2 consonants (optionally after a digit). Three
      // consonants usually means the leading digit was misread — flag it as unsure.
      if (/^[ก-ฮ]{3}$/.test(letters)) confidence *= 0.5;
    }
    text = `${L.text.trim()} ${R.text.trim()}`;
  }
  // 2) Whole registration line.
  if (!plateText) {
    const reg = await line(topPng, PLATE_CHARS);
    plateText = parseRegistration(reg.text);
    confidence = reg.confidence / 100;
    text = reg.text.trim();
  }
  // 3) Whole plate as a block.
  if (!plateText) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: PLATE_CHARS, user_defined_dpi: '300' });
    const whole = (await worker.recognize(wholePng)).data;
    plateText = parseRegistration(whole.text);
    confidence = whole.confidence / 100;
    text = whole.text.trim();
  }
  const prov = await line(bottomPng, '');
  text = `${text}\n${prov.text.trim()}`;
  const province = matchProvince(prov.text);
  return {
    plate: plateText,
    province,
    text: province ? `${text}\n[จังหวัด] ${province}` : text,
    confidence: plateText ? Math.max(0, Math.min(1, confidence)) : 0,
    plateFound: found,
    timings: { findMs: tFind - t0, totalMs: Date.now() - t0 },
  };
}

export async function shutdown() {
  if (workerPromise) await (await workerPromise).terminate();
}
