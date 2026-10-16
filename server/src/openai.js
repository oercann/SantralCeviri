// OpenAI: canlı konuşma tanıma (Realtime), çeviri (Chat) ve seslendirme (TTS)
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { resample } from './audio.js';

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
                  silence_duration_ms: 600,
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

/** Seslendirme → PCM16 @16k (Asterisk'e hazır). */
export async function speak(text, lang) {
  const voice = lang === 'en' ? config.openai.voiceEn : config.openai.voiceTr;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openai.tts,
      voice,
      input: text,
      response_format: 'pcm',
      speed: 1.0,
      instructions: lang === 'en'
        ? 'Clear, calm, friendly phone voice.'
        : 'Sakin, net, doğal bir telefon sesi.',
    }),
  });
  if (!res.ok) throw new Error('TTS hatası ' + res.status + ' ' + (await res.text()));
  const pcm24k = Buffer.from(await res.arrayBuffer());
  return resample(pcm24k, OAI_RATE, config.rtp.sampleRate);
}
