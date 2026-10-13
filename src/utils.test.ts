import assert from 'node:assert/strict';
import test from 'node:test';
import { createCode, escapeHtml, formatBytes, isValidOffer, normalizeBinary, normalizeCode } from './utils.ts';

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
  value.files[0].size = 2 ** 31 + 1;
  assert.equal(isValidOffer(value), false);
  value.files[0].size = Number.NaN;
  assert.equal(isValidOffer(value), false);
});

test('offers have bounded file counts and file metadata', () => {
  const value = offer();
  value.files = Array.from({ length: 101 }, () => ({ ...value.files[0], id: crypto.randomUUID() }));
  assert.equal(isValidOffer(value), false);
  value.files = [];
  assert.equal(isValidOffer(value), false);
  const invalidName = offer();
  invalidName.files[0].name = 'a'.repeat(256);
  assert.equal(isValidOffer(invalidName), false);
});
