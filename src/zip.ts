const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, data: Uint8Array): number {
  let value = (crc ^ 0xffffffff) >>> 0;
  for (let index = 0; index < data.length; index++) value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Blob;
  crc: number;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_FLAG = 0x0800;

function setUint64(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value % 2 ** 32, true);
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(entries: ZipEntry[], now = new Date()): Blob {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const parts: BlobPart[] = [];
  const central: ArrayBuffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    const bigSize = size >= MAX32;
    const localExtra = bigSize ? 20 : 0;
    const local = new DataView(new ArrayBuffer(30 + name.length + localExtra));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, bigSize ? 45 : 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, entry.crc >>> 0, true);
    local.setUint32(18, bigSize ? MAX32 : size, true);
    local.setUint32(22, bigSize ? MAX32 : size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, localExtra, true);
    new Uint8Array(local.buffer).set(name, 30);
    if (bigSize) {
      const at = 30 + name.length;
      local.setUint16(at, 0x0001, true);
      local.setUint16(at + 2, 16, true);
      setUint64(local, at + 4, size);
      setUint64(local, at + 12, size);
    }
    parts.push(local.buffer, entry.data);

    const bigOffset = offset >= MAX32;
    const fields = (bigSize ? 2 : 0) + (bigOffset ? 1 : 0);
    const centralExtra = fields ? 4 + 8 * fields : 0;
    const record = new DataView(new ArrayBuffer(46 + name.length + centralExtra));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 45, true);
    record.setUint16(6, fields ? 45 : 20, true);
    record.setUint16(8, UTF8_FLAG, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, entry.crc >>> 0, true);
    record.setUint32(20, bigSize ? MAX32 : size, true);
    record.setUint32(24, bigSize ? MAX32 : size, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, centralExtra, true);
    record.setUint16(32, 0, true);
    record.setUint16(34, 0, true);
    record.setUint16(36, 0, true);
    record.setUint32(38, 0, true);
    record.setUint32(42, bigOffset ? MAX32 : offset, true);
    new Uint8Array(record.buffer).set(name, 46);
    if (fields) {
      let at = 46 + name.length;
      record.setUint16(at, 0x0001, true);
      record.setUint16(at + 2, 8 * fields, true);
      at += 4;
      if (bigSize) { setUint64(record, at, size); setUint64(record, at + 8, size); at += 16; }
      if (bigOffset) setUint64(record, at, offset);
    }
    central.push(record.buffer);
    offset += local.byteLength + size;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, record) => sum + record.byteLength, 0);
  parts.push(...central);
  if (entries.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32) {
    const zip64 = new DataView(new ArrayBuffer(76));
    zip64.setUint32(0, 0x06064b50, true);
    setUint64(zip64, 4, 44);
    zip64.setUint16(12, 45, true);
    zip64.setUint16(14, 45, true);
    zip64.setUint32(16, 0, true);
    zip64.setUint32(20, 0, true);
    setUint64(zip64, 24, entries.length);
    setUint64(zip64, 32, entries.length);
    setUint64(zip64, 40, centralSize);
    setUint64(zip64, 48, centralOffset);
    zip64.setUint32(56, 0x07064b50, true);
    zip64.setUint32(60, 0, true);
    setUint64(zip64, 64, centralOffset + centralSize);
    zip64.setUint32(72, 1, true);
    parts.push(zip64.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, Math.min(entries.length, MAX16), true);
  end.setUint16(10, Math.min(entries.length, MAX16), true);
  end.setUint32(12, Math.min(centralSize, MAX32), true);
  end.setUint32(16, Math.min(centralOffset, MAX32), true);
  end.setUint16(20, 0, true);
  parts.push(end.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
