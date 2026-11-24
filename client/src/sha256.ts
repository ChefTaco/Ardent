/**
 * Incremental SHA-256 (FIPS 180-4) without Node built-ins. Web Crypto hashes only whole
 * buffers, and a resumable download must hash the bytes as they stream, so memory stays
 * bounded by one chunk whatever the artifact size.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  readonly #h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  readonly #w = new Uint32Array(64);
  readonly #block = new Uint8Array(64);
  #buffered = 0;
  #length = 0;
  #finished = false;

  /** Bytes hashed so far. */
  get length(): number { return this.#length; }

  update(data: Uint8Array): this {
    if (this.#finished) throw new Error('SHA-256 already finished');
    let offset = 0;
    this.#length += data.length;
    if (this.#buffered) {
      const take = Math.min(64 - this.#buffered, data.length);
      this.#block.set(data.subarray(0, take), this.#buffered);
      this.#buffered += take;
      offset = take;
      if (this.#buffered < 64) return this;
      this.#compress(this.#block, 0);
      this.#buffered = 0;
    }
    for (; offset + 64 <= data.length; offset += 64) this.#compress(data, offset);
    if (offset < data.length) {
      this.#block.set(data.subarray(offset), 0);
      this.#buffered = data.length - offset;
    }
    return this;
  }

  /** The lowercase hex digest. The hash cannot be updated afterwards. */
  hex(): string {
    if (!this.#finished) {
      const bits = this.#length * 8;
      const tail = new Uint8Array(this.#buffered < 56 ? 64 : 128);
      tail.set(this.#block.subarray(0, this.#buffered));
      tail[this.#buffered] = 0x80;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
      view.setUint32(tail.length - 4, bits >>> 0);
      for (let offset = 0; offset < tail.length; offset += 64) this.#compress(tail, offset);
      this.#finished = true;
    }
    return Array.from(this.#h, word => word.toString(16).padStart(8, '0')).join('');
  }

  #compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    const h = this.#h;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + k) >>> 0;
  }
}

/**
 * A stable UUID for an idempotency key that is not one (Magnus accepts only UUID keys):
 * the first 16 bytes of SHA-256("ardent-client:idempotency:" + key), with the version 8 and
 * RFC 9562 variant bits set.
 */
export function uuidFromKey(key: string): string {
  const hex = new Sha256().update(new TextEncoder().encode(`ardent-client:idempotency:${key}`)).hex().slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
