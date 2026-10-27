import { randomBytes } from 'node:crypto';

let lastMs = 0;
let counter = 0;

/** UUID v7: 48 бит времени в старших битах, монотонно внутри процесса. */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    counter = 0;
  } else {
    counter++;
    if (counter > 0xfff) {
      lastMs++;
      counter = 0;
    }
    ms = lastMs;
  }
  const b = randomBytes(16);
  const t = BigInt(ms);
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
