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
