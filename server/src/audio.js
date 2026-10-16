// PCM16 yardımcıları: yeniden örnekleme, enerji ölçümü

/** Lineer interpolasyonla 16-bit mono PCM yeniden örnekle. */
export function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length / 2;
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/** RMS enerji (0..32767) — basit sessizlik tespiti için. */
export function rms(pcm) {
  const n = pcm.length / 2;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Ses seviyesini çarpanla ölçekle (kırpma korumalı). */
export function gain(pcm, factor) {
  if (factor === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    let s = pcm.readInt16LE(i) * factor;
    s = Math.max(-32768, Math.min(32767, s));
    out.writeInt16LE(Math.round(s), i);
  }
  return out;
}

// ---- G.711 mu-law ----
const BIAS = 0x84, CLIP = 32635;
const EXP_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) EXP_LUT[i] = i < 2 ? 0 : i < 4 ? 1 : i < 8 ? 2 : i < 16 ? 3 : i < 32 ? 4 : i < 64 ? 5 : i < 128 ? 6 : 7;
function linToUlaw(s) {
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  const exp = EXP_LUT[(s >> 7) & 0xff];
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
const ULAW_DEC = new Int16Array(256);
for (let u = 0; u < 256; u++) {
  const v = ~u & 0xff;
  const sign = v & 0x80, exp = (v >> 4) & 7, mant = v & 0x0f;
  let t = ((mant << 3) + BIAS) << exp;
  t -= BIAS;
  ULAW_DEC[u] = sign ? -t : t;
}
/** PCM16 LE → ulaw bytes */
export function pcmToUlaw(pcm) {
  const n = pcm.length >> 1, out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = linToUlaw(pcm.readInt16LE(i * 2));
  return out;
}
/** ulaw bytes → PCM16 LE */
export function ulawToPcm(u) {
  const out = Buffer.allocUnsafe(u.length * 2);
  for (let i = 0; i < u.length; i++) out.writeInt16LE(ULAW_DEC[u[i]], i * 2);
  return out;
}
