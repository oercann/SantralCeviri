const env = (k, d) => (process.env[k] ?? d);

export const config = {
  ari: {
    url: env('ARI_URL', 'http://127.0.0.1:8088'),
    user: env('ARI_USER', 'ceviri'),
    pass: env('ARI_PASS', ''),
    app: 'ceviri',
  },
  trunk: {
    host: env('TRUNK_HOST', 'sip.telnyx.com'),
    endpoint: 'telnyx',
    myDid: env('MY_DID', ''),
    myCell: env('MY_CELL', ''),
  },
  openai: {
    key: env('OPENAI_API_KEY', ''),
    stt: env('STT_MODEL', 'gpt-4o-mini-transcribe'),
    translate: env('TRANSLATE_MODEL', 'gpt-4o-mini'),
    tts: env('TTS_MODEL', 'tts-1'),
    voiceEn: env('TTS_VOICE_EN', 'alloy'),
    voiceTr: env('TTS_VOICE_TR', 'nova'),
  },
  web: {
    port: Number(env('WEB_PORT', 8443)),
    token: env('WEB_TOKEN', ''),
  },
  rtp: {
    host: env('RTP_HOST', '127.0.0.1'),
    portBase: Number(env('RTP_PORT_BASE', 40000)),
    sampleRate: 8000, // Asterisk ulaw (G.711)
  },
};

export function assertConfig() {
  const missing = [];
  if (!config.openai.key) missing.push('OPENAI_API_KEY');
  if (!config.ari.pass) missing.push('ARI_PASS');
  if (!config.trunk.myCell) missing.push('MY_CELL');
  if (missing.length) {
    console.error('Eksik ortam değişkenleri:', missing.join(', '));
    process.exit(1);
  }
}

/** Telefon numarasını E.164'e yakın normalize et (ABD varsayılan). */
export function normalizeNumber(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  d = d.replace(/^0+/, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return '+' + d;
}
