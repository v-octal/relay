import assert from 'node:assert/strict';
import test from 'node:test';
import { availableSpaceBytes, createCode, createVisibleClock, escapeHtml, fitsInAvailableSpace, formatBytes, isValidOffer, isValidRelativePath, joinRelativePath, normalizeBinary, normalizeCode, uniquePath, withCopyNumber } from './utils.ts';

test('file sizes use readable binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(513), '513 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2), '1 MB');
  assert.equal(formatBytes(1024 ** 3), '1 GB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('remote text cannot insert HTML or attributes', () => {
  assert.equal(escapeHtml('<img src="x" onerror=\'alert(1)\'>&'), '&lt;img src=&quot;x&quot; onerror=&#039;alert(1)&#039;&gt;&amp;');
  assert.equal(escapeHtml('photo.jpg'), 'photo.jpg');
});

test('binary data accepts buffers and PeerJS typed-array payloads', () => {
  const bytes = new Uint8Array([9, 1, 2, 3, 8]);
  const buffer = normalizeBinary(bytes.buffer);
  assert.equal(buffer, bytes.buffer);
  const subarray = normalizeBinary(bytes.subarray(1, 4));
  assert.deepEqual(Array.from(new Uint8Array(subarray as ArrayBuffer)), [1, 2, 3]);
  assert.equal(subarray?.byteLength, 3);
  const view = normalizeBinary(new DataView(bytes.buffer, 2, 2));
  assert.deepEqual(Array.from(new Uint8Array(view as ArrayBuffer)), [2, 3]);
  assert.equal(normalizeBinary('invalid'), undefined);
  assert.equal(normalizeBinary(null), undefined);
});

test('connection codes accept spaces and lowercase', () => {
  assert.equal(normalizeCode(' abc 123 '), 'ABC123');
  assert.equal(normalizeCode('AB-C123'), 'ABC123');
  assert.equal(normalizeCode(''), '');
});

test('generated codes have six unambiguous characters', () => {
  const codes = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const code = createCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 100);
});

function offer(): { batchId: string; files: { id: string; name: string; size: number; mime: string }[] } {
  return {
    batchId: crypto.randomUUID(),
    files: [{ id: crypto.randomUUID(), name: 'photo.jpg', size: 1024, mime: 'image/jpeg' }],
  };
}

test('offers accept ordinary files and empty files', () => {
  const value = offer();
  assert.equal(isValidOffer(value), true);
  value.files[0].size = 0;
  assert.equal(isValidOffer(value), true);
});

test('offers reject malformed or injected identifiers', () => {
  assert.equal(isValidOffer(null), false);
  assert.equal(isValidOffer({}), false);
  assert.equal(isValidOffer({ ...offer(), batchId: '\"><img src=x onerror=alert(1)>' }), false);
  const value = offer();
  value.files[0].id = 'not-an-id';
  assert.equal(isValidOffer(value), false);
});

test('offers reject duplicate files and unsafe sizes', () => {
  const value = offer();
  value.files.push({ ...value.files[0] });
  assert.equal(isValidOffer(value), false);
  value.files.pop();
  value.files[0].size = -1;
  assert.equal(isValidOffer(value), false);
  value.files[0].size = 1.5;
  assert.equal(isValidOffer(value), false);
  value.files[0].size = 2 ** 53;
  assert.equal(isValidOffer(value), false);
  value.files[0].size = Number.NaN;
  assert.equal(isValidOffer(value), false);
});

test('offers have no fixed total limit, only per-file validity', () => {
  const value = offer();
  // Many files and one file well above the old 2 GB total are allowed by
  // validation; free device space is checked separately at send/receive time.
  const many = Array.from({ length: 500 }, () => ({ ...value.files[0], id: crypto.randomUUID(), size: 5 * 1024 ** 3 }));
  assert.equal(isValidOffer({ ...value, files: many }), true);
  value.files[0].size = 10 * 1024 ** 3;
  assert.equal(isValidOffer(value), true);
});

test('offer paths must be safe relative paths', () => {
  const value = offer();
  (value.files[0] as { path?: string }).path = 'trip/day 1/photo.jpg';
  assert.equal(isValidOffer(value), true);
  value.files[0].name = 'trip/photo.jpg';
  assert.equal(isValidOffer(value), false);
  value.files[0].name = 'photo.jpg';
  (value.files[0] as { path?: string }).path = '../escape.txt';
  assert.equal(isValidOffer(value), false);
  (value.files[0] as { path?: string }).path = '/absolute.txt';
  assert.equal(isValidOffer(value), false);
  (value.files[0] as { path?: string }).path = 'a\\b.txt';
  assert.equal(isValidOffer(value), false);
  (value.files[0] as { path?: string }).path = 'a//b.txt';
  assert.equal(isValidOffer(value), false);
  assert.equal(isValidRelativePath('archive'), true);
  assert.equal(joinRelativePath('trip/day 1', 'photo.jpg'), 'trip/day 1/photo.jpg');
  assert.equal(joinRelativePath('', 'photo.jpg'), 'photo.jpg');
});

test('repeated names get a copy number before the extension', () => {
  assert.equal(withCopyNumber('photo.jpg', 2), 'photo (2).jpg');
  assert.equal(withCopyNumber('README', 3), 'README (3)');
  assert.equal(withCopyNumber('.env', 2), '.env (2)');
  const used = new Set<string>();
  assert.equal(uniquePath('trip/photo.jpg', used), 'trip/photo.jpg');
  assert.equal(uniquePath('trip/Photo.JPG', used), 'trip/Photo (2).JPG');
  assert.equal(uniquePath('trip/photo.jpg', used), 'trip/photo (3).jpg');
  assert.equal(uniquePath('other/photo.jpg', used), 'other/photo.jpg');
  assert.equal(uniquePath('photo.jpg', used), 'photo.jpg');
});

test('available space comes from the storage estimate', () => {
  assert.equal(availableSpaceBytes({ quota: 1000, usage: 250 }), 750);
  assert.equal(availableSpaceBytes({ quota: 1000 }), 1000);
  assert.equal(availableSpaceBytes({ quota: 100, usage: 250 }), 0);
  assert.equal(availableSpaceBytes({}), undefined);
  assert.equal(availableSpaceBytes(undefined), undefined);
  assert.equal(availableSpaceBytes({ quota: 'lots' }), undefined);
  assert.equal(fitsInAvailableSpace(750, 750), true);
  assert.equal(fitsInAvailableSpace(751, 750), false);
  assert.equal(fitsInAvailableSpace(10 * 1024 ** 3, undefined), true);
});

test('offers have bounded file counts and file metadata', () => {
  const value = offer();
  value.files = Array.from({ length: 10001 }, () => ({ ...value.files[0], id: crypto.randomUUID() }));
  assert.equal(isValidOffer(value), false);
  // A count far above the old 100-file cap stays valid.
  value.files = Array.from({ length: 101 }, () => ({ ...value.files[0], id: crypto.randomUUID() }));
  assert.equal(isValidOffer(value), true);
  value.files = [];
  assert.equal(isValidOffer(value), false);
  const invalidName = offer();
  invalidName.files[0].name = 'a'.repeat(256);
  assert.equal(isValidOffer(invalidName), false);
});

test('a hidden page adds no time to the stall clock', () => {
  let now = 1000;
  let visible = true;
  const clock = createVisibleClock(() => visible, () => now);
  now = 2000;
  assert.equal(clock.tick(), 1000);
  visible = false;
  now = 600000;
  assert.equal(clock.tick(), 1000);
  assert.equal(clock.elapsed(), 1000);
  visible = true;
  now = 601000;
  assert.equal(clock.tick(), 2000);
  clock.reset();
  assert.equal(clock.elapsed(), 0);
  now = 620000;
  assert.equal(clock.tick(), 19000);
});

test('the stall clock never runs backwards', () => {
  let now = 5000;
  const clock = createVisibleClock(() => true, () => now);
  now = 4000;
  assert.equal(clock.tick(), 0);
  now = 4500;
  assert.equal(clock.tick(), 500);
});
