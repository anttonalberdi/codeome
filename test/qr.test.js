const { test } = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../renderer/js/qr');

const { multiply, divisor, remainder, formatBits, versionBits, alignmentPositions, capacity, codewords } = qr._test;

test('GF(256) and Reed–Solomon match the ISO worked vector', () => {
  assert.equal(multiply(0x80, 2), 0x1d);
  assert.equal(multiply(0x57, 0x83), 0x31);
  assert.deepEqual(divisor(10), [216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(remainder(data, 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  assert.deepEqual(remainder([...data, ...remainder(data, 10)], 10), Array(10).fill(0));
});

test('all 32 standard format strings', () => {
  const table = [
    [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0], // M
    [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976], // L
    [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b], // H
    [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed]  // Q
  ];
  for (let level = 0; level < 4; level++) for (let mask = 0; mask < 8; mask++)
    assert.equal(formatBits(mask, level), table[level][mask], `level ${level}, mask ${mask}`);
});

test('alignment coordinates for versions 2–12', () => {
  const expected = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
    10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58]
  };
  for (const [version, positions] of Object.entries(expected)) assert.deepEqual(alignmentPositions(+version), positions);
});

test('matrix dimensions, finder and alignment patterns, and version information', () => {
  for (let version = 1; version <= 12; version++) {
    const payload = 'x'.repeat(version === 1 ? 1 : capacity(version - 1));
    const matrix = qr.encode(payload);
    const n = 17 + 4 * version;
    assert.equal(matrix.length, n, `version ${version}`);
    assert.ok(matrix.every((row) => row.length === n && row.every((v) => typeof v === 'boolean')));
    assert.equal(matrix[6][8], true, `horizontal timing v${version}`);
    assert.equal(matrix[8][6], true, `vertical timing v${version}`);
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const expected = Math.max(Math.abs(dx), Math.abs(dy)) !== 2;
        assert.equal(matrix[cy + dy][cx + dx], expected, `finder v${version} (${cx + dx},${cy + dy})`);
      }
    }
    for (const x of alignmentPositions(version)) for (const y of alignmentPositions(version)) {
      if ((x === 6 && (y === 6 || y === n - 7)) || (y === 6 && x === n - 7)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        assert.equal(matrix[y + dy][x + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          `alignment v${version} (${x + dx},${y + dy})`);
    }
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = !!((bits >>> i) & 1), x = n - 11 + i % 3, y = Math.floor(i / 3);
        assert.equal(matrix[y][x], bit);
        assert.equal(matrix[x][y], bit);
      }
    }
  }
});

test('HELLO WORLD and URL use byte mode at the expected sizes', () => {
  assert.equal(qr.encode('HELLO WORLD').length, 21);
  assert.deepEqual(codewords(Array.from(Buffer.from('HELLO WORLD')), 1).slice(0, 2), [0x40, 0xb4]);
  assert.equal(qr.encode('https://example.com').length, 25);
  const matrix = qr.encode('https://example.com');
  const n = matrix.length;
  let format = 0;
  for (let i = 0; i < 6; i++) format |= Number(matrix[i][8]) << i;
  format |= Number(matrix[7][8]) << 6;
  format |= Number(matrix[8][8]) << 7;
  format |= Number(matrix[8][7]) << 8;
  for (let i = 9; i < 15; i++) format |= Number(matrix[8][14 - i]) << i;
  assert.ok(Array.from({ length: 8 }, (_, mask) => formatBits(mask)).includes(format));
  assert.equal(matrix[n - 8][8], true);
});

test('encoding is deterministic, handles UTF-8 and rejects excess input', () => {
  const value = 'https://example.com/#pair=é😀';
  assert.deepEqual(qr.encode(value), qr.encode(value));
  assert.throws(() => qr.encode('x'.repeat(2000)), /too long for version 12 \/ ECC M/);
  const svg = qr.toSvg(qr.encode('HELLO WORLD'), { scale: 2, margin: 4 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 58 58"/);
  assert.doesNotMatch(svg, /HELLO WORLD/);
});
