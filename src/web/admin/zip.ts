/**
 * Minimal ZIP editing in the browser: copy every entry of an existing zip unchanged and add
 * one extra file (stored, uncompressed). Used to hand out the Local OCR program with this
 * computer's config.json (server + token) already inside, so nothing has to be typed.
 */
const enc = new TextEncoder();

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function addFileToZip(zip: ArrayBuffer, name: string, content: string): Uint8Array<ArrayBuffer> {
  const src = new Uint8Array(zip);
  const view = new DataView(zip);
  // End of central directory record (no zip comment expected, but scan back to be safe).
  let eocd = -1;
  for (let i = src.length - 22; i >= Math.max(0, src.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  // Keep all entries except an existing file with the same name.
  const entries: { local: Uint8Array; central: Uint8Array }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Bad central directory');
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const compSize = view.getUint32(p + 20, true);
    const localOff = view.getUint32(p + 42, true);
    const entryName = new TextDecoder().decode(src.subarray(p + 46, p + 46 + nameLen));
    const central = src.slice(p, p + 46 + nameLen + extraLen + commentLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName === name) continue;
    const lNameLen = view.getUint16(localOff + 26, true), lExtraLen = view.getUint16(localOff + 28, true);
    let localEnd = localOff + 30 + lNameLen + lExtraLen + compSize;
    if (view.getUint16(localOff + 6, true) & 0x08) localEnd += view.getUint32(localEnd, true) === 0x08074b50 ? 16 : 12; // data descriptor
    entries.push({ local: src.slice(localOff, localEnd), central });
  }
  void cdSize;

  const data = enc.encode(content);
  const nameBytes = enc.encode(name);
  const crc = crc32(data);
  const { time, date } = dosTime(new Date());
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true); // UTF-8 names
  lv.setUint16(8, 0, true); // stored
  lv.setUint16(10, time, true);
  lv.setUint16(12, date, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, time, true);
  cv.setUint16(14, date, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  entries.push({ local, central });

  // Re-assemble with corrected local header offsets.
  const localsSize = entries.reduce((n, e) => n + e.local.length, 0);
  const centralSize = entries.reduce((n, e) => n + e.central.length, 0);
  const out = new Uint8Array(localsSize + centralSize + 22);
  const ov = new DataView(out.buffer);
  let off = 0;
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(off);
    out.set(e.local, off);
    off += e.local.length;
  }
  const cdStart = off;
  entries.forEach((e, i) => {
    out.set(e.central, off);
    ov.setUint32(off + 42, offsets[i], true);
    off += e.central.length;
  });
  ov.setUint32(off, 0x06054b50, true);
  ov.setUint16(off + 8, entries.length, true);
  ov.setUint16(off + 10, entries.length, true);
  ov.setUint32(off + 12, centralSize, true);
  ov.setUint32(off + 16, cdStart, true);
  return out;
}
