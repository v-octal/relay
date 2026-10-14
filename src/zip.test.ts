import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32Update, createZip } from './zip.ts';

const encoder = new TextEncoder();
const crcOf = (text: string) => crc32Update(0, encoder.encode(text));

test('crc32 matches the standard check value and chains across chunks', () => {
  assert.equal(crcOf('123456789'), 0xcbf43926);
  assert.equal(crcOf(''), 0);
  const whole = encoder.encode('Hello from Relay, in pieces.');
  let chained = 0;
  for (let index = 0; index < whole.length; index += 5) chained = crc32Update(chained, whole.subarray(index, index + 5));
  assert.equal(chained, crc32Update(0, whole));
});

interface ParsedEntry { name: string; data: Uint8Array; crc: number; flags: number }

function readUint64(view: DataView, offset: number) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

function parseZip(bytes: Uint8Array): { entries: ParsedEntry[]; zip64: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  assert.equal(view.getUint32(endAt, true), 0x06054b50);
  let count = view.getUint16(endAt + 10, true);
  let centralOffset = view.getUint32(endAt + 16, true);
  let zip64 = false;
  if (endAt >= 20 && view.getUint32(endAt - 20, true) === 0x07064b50) {
    zip64 = true;
    const recordAt = readUint64(view, endAt - 12);
    assert.equal(view.getUint32(recordAt, true), 0x06064b50);
    count = readUint64(view, recordAt + 32);
    centralOffset = readUint64(view, recordAt + 48);
  }
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(localAt, true), 0x04034b50);
    assert.equal(view.getUint32(localAt + 14, true), crc);
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    entries.push({ name, data: bytes.subarray(dataAt, dataAt + size), crc, flags });
    at += 46 + nameLength + extraLength;
  }
  return { entries, zip64 };
}

test('zip archives keep folder paths, UTF-8 names, and exact bytes', async () => {
  const files = [
    { name: 'trip/day 1/notes.txt', text: 'first note\n' },
    { name: 'trip/empty.txt', text: '' },
    { name: 'résumé — final.txt', text: 'unicode name' },
  ];
  const zip = createZip(files.map((file) => ({ name: file.name, data: new Blob([file.text]), crc: crcOf(file.text) })));
  assert.equal(zip.type, 'application/zip');
  const { entries, zip64 } = parseZip(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(zip64, false);
  assert.deepEqual(entries.map((entry) => entry.name), files.map((file) => file.name));
  for (const [index, entry] of entries.entries()) {
    assert.equal(new TextDecoder().decode(entry.data), files[index].text);
    assert.equal(crc32Update(0, entry.data), entry.crc);
    assert.equal(entry.flags & 0x0800, 0x0800);
  }
});

test('zip archives switch to ZIP64 when there are very many files', async () => {
  const count = 65536;
  const data = new Blob(['x']);
  const crc = crcOf('x');
  const zip = createZip(Array.from({ length: count }, (_, index) => ({ name: `f/${index}.txt`, data, crc })));
  const { entries, zip64 } = parseZip(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(zip64, true);
  assert.equal(entries.length, count);
  assert.equal(entries[count - 1].name, `f/${count - 1}.txt`);
  assert.equal(new TextDecoder().decode(entries[count - 1].data), 'x');
});
