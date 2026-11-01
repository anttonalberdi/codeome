// QR Code Model 2, byte mode, error correction M (ISO/IEC 18004).
// Kept independent of the renderer so the encoder can be tested with Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodeomeQR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22];
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8];

  function multiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function divisor(degree) {
    const result = Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = multiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = multiply(root, 2);
    }
    return result;
  }
  function remainder(data, degree) {
    const poly = divisor(degree);
    const result = Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i++) result[i] ^= multiply(poly[i], factor);
    }
    return result;
  }
  function rawModules(version) {
    let count = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const aligns = Math.floor(version / 7) + 2;
      count -= (25 * aligns - 10) * aligns - 55;
      if (version >= 7) count -= 36;
    }
    return count;
  }
  function capacity(version) { return Math.floor(rawModules(version) / 8) - ECC[version] * BLOCKS[version]; }
  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const size = 17 + 4 * version;
    const step = Math.ceil((size - 13) / (2 * count - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }
  function formatBits(mask, level = 0) {
    const data = level << 3 | mask; // Level M has format bits 00.
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }
  function codewords(bytes, version) {
    const bits = [];
    function append(value, length) { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    append(4, 4);
    append(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) append(byte, 8);
    const dataLength = capacity(version) * 8;
    append(0, Math.min(4, dataLength - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    let pad = 0;
    while (data.length < capacity(version)) data.push((pad++ & 1) ? 0x11 : 0xec);

    const blocks = BLOCKS[version], ecc = ECC[version], raw = Math.floor(rawModules(version) / 8);
    const shortCount = blocks - raw % blocks;
    const shortDataLength = Math.floor(raw / blocks) - ecc;
    const dataBlocks = [], eccBlocks = [];
    let offset = 0;
    for (let i = 0; i < blocks; i++) {
      const length = shortDataLength + (i >= shortCount ? 1 : 0);
      const chunk = data.slice(offset, offset + length);
      dataBlocks.push(chunk);
      eccBlocks.push(remainder(chunk, ecc));
      offset += length;
    }
    const result = [];
    for (let j = 0; j <= shortDataLength; j++)
      for (const block of dataBlocks) if (j < block.length) result.push(block[j]);
    for (let j = 0; j < ecc; j++) for (const block of eccBlocks) result.push(block[j]);
    return result;
  }
  function makeMatrix(version, words) {
    const size = 17 + 4 * version;
    const matrix = Array.from({ length: size }, () => Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => Array(size).fill(false));
    function set(x, y, dark) {
      if (x >= 0 && y >= 0 && x < size && y < size) { matrix[y][x] = !!dark; fixed[y][x] = true; }
    }
    // Timing, finder and separator patterns.
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    const aligns = alignmentPositions(version);
    for (const x of aligns) for (const y of aligns) {
      if ((x === 6 && (y === 6 || y === size - 7)) || (y === 6 && x === size - 7)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Reserve format and version information before placing data.
    function reserve(x, y) { if (!fixed[y][x]) set(x, y, false); }
    for (let i = 0; i <= 8; i++) { reserve(8, i); reserve(i, 8); }
    for (let i = 0; i < 8; i++) { reserve(size - 1 - i, 8); reserve(8, size - 1 - i); }
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (bits >>> i) & 1;
        set(size - 11 + i % 3, Math.floor(i / 3), bit);
        set(Math.floor(i / 3), size - 11 + i % 3, bit);
      }
    }
    set(8, size - 8, true);
    const dataBits = [];
    for (const byte of words) for (let i = 7; i >= 0; i--) dataBits.push((byte >>> i) & 1);
    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (!fixed[y][x]) matrix[y][x] = !!(dataBits[bit++] || 0);
        }
      }
    }
    return { matrix, fixed };
  }
  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return x * y % 2 + x * y % 3 === 0;
      case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
      default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
    }
  }
  function putFormat(matrix, mask) {
    const n = matrix.length, bits = formatBits(mask), b = (i) => !!((bits >>> i) & 1);
    for (let i = 0; i <= 5; i++) matrix[i][8] = b(i);
    matrix[7][8] = b(6); matrix[8][8] = b(7); matrix[8][7] = b(8);
    for (let i = 9; i < 15; i++) matrix[8][14 - i] = b(i);
    for (let i = 0; i < 8; i++) matrix[8][n - 1 - i] = b(i);
    for (let i = 8; i < 15; i++) matrix[n - 15 + i][8] = b(i);
    matrix[n - 8][8] = true;
  }
  function penalty(matrix) {
    const n = matrix.length;
    let score = 0, dark = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = matrix[y][x];
      if (v) dark++;
      if (x && y && v === matrix[y - 1][x] && v === matrix[y][x - 1] && v === matrix[y - 1][x - 1]) score += 3;
    }
    const patterns = ['10111010000', '00001011101'];
    for (let dir = 0; dir < 2; dir++) for (let line = 0; line < n; line++) {
      let run = 0, prev = null, bits = '';
      for (let pos = 0; pos < n; pos++) {
        const v = dir ? matrix[pos][line] : matrix[line][pos];
        bits += v ? '1' : '0';
        if (v === prev) run++; else { if (run >= 5) score += 3 + run - 5; run = 1; prev = v; }
      }
      if (run >= 5) score += 3 + run - 5;
      bits = `0000${bits}0000`;
      for (let pos = 0; pos <= bits.length - 11; pos++) if (patterns.includes(bits.slice(pos, pos + 11))) score += 40;
    }
    score += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
    return score;
  }
  function encode(text) {
    if (typeof text !== 'string') throw new TypeError('QR input must be text');
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 1;
    while (version <= 12 && (bytes.length >= (version <= 9 ? 256 : 65536) ||
      4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > capacity(version) * 8)) version++;
    if (version > 12) throw new RangeError('QR input too long for version 12 / ECC M');
    const { matrix: base, fixed } = makeMatrix(version, codewords(bytes, version));
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const matrix = base.map((row, y) => row.map((value, x) => fixed[y][x] ? value : value !== maskBit(mask, x, y)));
      putFormat(matrix, mask);
      const score = penalty(matrix);
      if (score < bestScore) { best = matrix; bestScore = score; }
    }
    return best;
  }
  function toSvg(matrix, { scale = 4, margin = 4 } = {}) {
    if (!Array.isArray(matrix) || !matrix.length || !matrix.every((r) => Array.isArray(r) && r.length === matrix.length && r.every((v) => typeof v === 'boolean')))
      throw new TypeError('QR matrix must be square booleans');
    if (!Number.isInteger(scale) || scale < 1 || scale > 100 || !Number.isInteger(margin) || margin < 0 || margin > 100)
      throw new RangeError('Invalid QR scale or margin');
    const size = (matrix.length + 2 * margin) * scale;
    const cells = [];
    for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++)
      if (matrix[y][x]) cells.push(`M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`);
    const path = cells.join('');
    if (typeof document !== 'undefined' && typeof XMLSerializer !== 'undefined') {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      for (const [key, value] of Object.entries({ viewBox: `0 0 ${size} ${size}`, width: size, height: size,
        role: 'img', 'aria-label': 'Pairing QR code' })) svg.setAttribute(key, String(value));
      const background = document.createElementNS(ns, 'rect');
      for (const [key, value] of Object.entries({ width: '100%', height: '100%', fill: 'white' })) background.setAttribute(key, value);
      const pixels = document.createElementNS(ns, 'path');
      pixels.setAttribute('fill', 'black'); pixels.setAttribute('d', path);
      svg.append(background, pixels);
      return new XMLSerializer().serializeToString(svg);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Pairing QR code"><rect width="100%" height="100%" fill="white"/><path fill="black" d="${path}"/></svg>`;
  }
  return { encode, toSvg, _test: { multiply, divisor, remainder, formatBits, versionBits, alignmentPositions, capacity, codewords, makeMatrix, maskBit, putFormat, penalty } };
});
