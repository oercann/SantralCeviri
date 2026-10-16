// OpenAI: canlı konuşma tanıma (Realtime), çeviri (Chat) ve seslendirme (TTS)
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { resample, Decimator3, ulawToPcm } from './audio.js';

const OAI_RATE = 24000; // Realtime ve TTS pcm16 24 kHz

/**
 * Sürekli konuşma tanıma oturumu.
 * feed(pcm16k) ile ses ver; 'partial' ve 'final' olaylarını dinle.
 */
export class LiveTranscriber extends EventEmitter {
  constructor(language) {
    super();
    this.language = language; // 'tr' | 'en'
    this.ws = null;
    this.ready = false;
    this.pending = [];
    this.connect();
  }

  connect() {
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${config.openai.key}` },
    });
    this.ws.on('open', () => {
      // GA Realtime API (transcription oturumu)
      this.ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: OAI_RATE },
                transcription: { model: config.openai.stt, language: this.language },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 400,
                },
                noise_reduction: { type: 'far_field' },
              },
            },
          },
        })
      );
      this.fails = 0;
      this.ready = true;
      for (const b of this.pending) this._append(b);
      this.pending = [];
    });
    this.ws.on('message', (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case 'input_audio_buffer.speech_started':
          this.emit('speech_started');
          break;
        case 'conversation.item.input_audio_transcription.delta':
          if (ev.delta) this.emit('partial', ev.delta);
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript && ev.transcript.trim()) this.emit('final', ev.transcript.trim());
          break;
        case 'error':
          console.error('STT hata:', ev.error?.message || JSON.stringify(ev));
          break;
      }
    });
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      if (this.closed) return;
      this.fails = (this.fails || 0) + 1;
      if (this.fails > 5) { console.error('STT: 5 kez bağlanamadı, vazgeçildi'); return; }
      console.warn('STT bağlantısı kapandı', code, reason?.toString());
      setTimeout(() => this.connect(), 2000 * this.fails);
    });
    this.ws.on('error', (e) => console.error('STT WS:', e.message));
  }

  feed(pcm16k) {
    const pcm24k = resample(pcm16k, config.rtp.sampleRate, OAI_RATE);
    if (!this.ready) {
      this.pending.push(pcm24k);
      if (this.pending.length > 100) this.pending.shift();
      return;
    }
    this._append(pcm24k);
  }

  _append(buf) {
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

const SYSTEM = {
  'tr>en': `You are a professional phone interpreter. Translate the Turkish sentence into natural, polite spoken American English as the caller would say it on a business phone call. Output only the translation, nothing else. Keep names, numbers and addresses exact.`,
  'en>tr': `Sen profesyonel bir telefon tercümanısın. İngilizce cümleyi doğal, akıcı Türkçeye çevir; telefon görüşmesindeki karşı tarafın söylediği gibi. Sadece çeviriyi yaz, başka hiçbir şey ekleme. İsimleri, sayıları ve adresleri aynen koru.`,
};

/** Metin çevirisi; context son birkaç cümle (tutarlılık için). */
export async function translate(text, direction, context = []) {
  const messages = [{ role: 'system', content: SYSTEM[direction] }];
  for (const c of context.slice(-6)) {
    messages.push({ role: 'user', content: c.src });
    messages.push({ role: 'assistant', content: c.dst });
  }
  messages.push({ role: 'user', content: text });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.openai.translate, messages, temperature: 0.2, max_tokens: 300 }),
  });
  if (!res.ok) throw new Error('Çeviri hatası ' + res.status + ' ' + (await res.text()));
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

const ttsCache = new Map(); // sabit anonslar

async function ttsRequest(text, lang) {
  const voice = lang === 'en' ? config.openai.voiceEn : config.openai.voiceTr;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openai.tts,
      voice,
      input: text,
      response_format: 'pcm',
      speed: 1.05,
      instructions: lang === 'en'
        ? 'Clear, calm, friendly phone voice. Natural pacing.'
        : 'Sakin, net, doğal bir telefon sesi.',
    }),
  });
  if (!res.ok) throw new Error('TTS hatası ' + res.status + ' ' + (await res.text()));
  return res;
}

/**
 * Akışlı seslendirme: PCM24k parçaları geldikçe 8k'ya çevirip onPcm(pcm) ile verir.
 * Çıktı aynı zamanda tam PCM olarak döner (cache için).
 */
export async function speakStream(text, lang, onPcm) {
  const key = lang + '|' + text;
  const cached = ttsCache.get(key);
  if (cached) { onPcm(cached); return cached; }
  const chunks = [];
  const push = (pcm) => { if (pcm.length) { chunks.push(pcm); onPcm(pcm); } };

  if (process.env.TTS_PROVIDER === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
    await elevenLabsStream(text, lang, push);
  } else {
    const res = await ttsRequest(text, lang);
    const reader = res.body.getReader();
    const dec = new Decimator3();
    let pending = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, Buffer.from(value)]);
      const usable = pending.length & ~1;
      if (usable >= 2400) { push(dec.process(pending.subarray(0, usable))); pending = pending.subarray(usable); }
    }
    if (pending.length >= 2) push(dec.process(pending.subarray(0, pending.length & ~1)));
  }
  return Buffer.concat(chunks);
}

/** ElevenLabs: doğrudan ulaw_8000 akışı (telefon için optimize). */
async function elevenLabsStream(text, lang, push) {
  const voice = lang === 'en' ? (process.env.ELEVENLABS_VOICE_EN || '21m00Tcm4TlvDq8ikWAM') : (process.env.ELEVENLABS_VOICE_TR || 'EXAVITQu4vr4xnSDxMaL');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', language_code: lang, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
  });
  if (!res.ok) throw new Error('ElevenLabs hatası ' + res.status + ' ' + (await res.text()));
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    push(ulawToPcm(Buffer.from(value)));
  }
}

/** Seslendirme → PCM16 (Asterisk'e hazır), tamamı bir kerede. */
export async function speak(text, lang) {
  const parts = [];
  await speakStream(text, lang, (p) => parts.push(p));
  return Buffer.concat(parts);
}

/** Sabit anonsları önceden üret (ilk çağrıda bekleme olmasın). */
export async function prewarm(list) {
  for (const { text, lang } of list) {
    try {
      const pcm = await speak(text, lang);
      ttsCache.set(lang + '|' + text, pcm);
    } catch (e) { console.error('prewarm hatası:', e.message); }
  }
  console.log('Anonslar hazır:', ttsCache.size);
}

/** Sesli komutu yorumla → {action:'call'|'reply'|'hangup', number?, reply}. history: önceki [{role,content}] */
export async function intent(text, contacts, history = []) {
  const list = contacts.map((c) => `${c.name}: ${c.number}`).join('\n') || '(boş)';
  const system = `Sen Türkçe konuşan kişisel bir sesli asistansın (telefon üzerinden). Her cevabı şu JSON ile ver:
{"action":"call","number":"+1XXXXXXXXXX"}  → kullanıcı bir numarayı veya rehberdeki kişiyi aramak istiyorsa (rehberden numarayı sen koy; ABD numaraları +1 ile)
{"action":"hangup"}  → kapatmak / veda etmek istiyorsa
{"action":"reply","reply":"..."}  → diğer her şey için: soruyu genel bilginle doğrudan ve doğru cevapla (tarih, matematik, çeviri, tavsiye, bilgi, günlük plan, her konu). Telefonda dinleneceği için en fazla 2-3 cümle, sade ve samimi. "Ne yapabilirsin" derse: arama yapabildiğini, canlı tercümanlık yaptığını ve her soruyu cevaplayabildiğini söyle. Canlı veri (hava durumu, haber, trafik) gerekiyorsa erişimin olmadığını kısaca söyle.
Sadece JSON yaz.
Rehber:
${list}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ASSISTANT_MODEL || config.openai.translate,
      messages: [{ role: 'system', content: system }, ...history.slice(-8), { role: 'user', content: text }],
      temperature: 0.3,
      max_tokens: 250,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error('Intent hatası ' + res.status);
  const j = await res.json();
  try { return JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch { return { action: 'reply', reply: 'Anlayamadım, tekrar eder misiniz?' }; }
}
