// OpenAI Realtime (ses→ses) oturumu: tercüman ya da asistan rolünde.
// Giriş: PCM16 8 kHz (telefon)  →  24 kHz'e çıkar  →  model
// Çıkış: model 24 kHz PCM16  →  8 kHz'e indir  →  onAudio(pcm)
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { resample, Decimator3 } from './audio.js';

const OAI_RATE = 24000;
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';
const VOICE = process.env.REALTIME_VOICE || 'marin';

export const ROLES = {
  interpreter: (src, dst) => `You are a professional simultaneous interpreter on a phone call.
Everything you hear is spoken in ${src}. Immediately say the same thing in ${dst}, in first person, with the same tone and meaning. Keep names, numbers, addresses and times exact.
Rules: output ONLY the interpretation. Never answer questions, never add comments, never explain, never greet, never mention that you are an interpreter. If the audio is silence or noise, say nothing.`,

  assistant: (contacts) => `Sen Türkçe konuşan kişisel bir sesli asistansın; telefonda konuşuyorsun. Kısa, doğal ve samimi konuş (en fazla 2-3 cümle).
Şu an: ${new Date().toLocaleString('tr-TR', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} (New Jersey saati).
Yapabildiklerin: bir numarayı ya da rehberdeki kişiyi aramak (call_number aracı), görüşmeyi kapatmak (hangup aracı), güncel bilgi için internette arama (web_search aracı: hava durumu, haber, trafik, fiyat, açılış saatleri, güncel her şey) ve her türlü soruya cevap vermek.
Güncel/değişken bilgi gerekiyorsa tahmin etme, web_search çağır; önce "bakıyorum" gibi kısa bir şey söyleyebilirsin.
Kullanıcı birini aramak isterse hemen call_number aracını çağır; rehberden bahsetme, numara rehberde yoksa söyleneni ara. ABD numaralarını +1 ile ver.
Rehber:
${contacts.map((c) => `${c.name}: ${c.number}`).join('\n') || '(boş)'}`,
};

export class RealtimeSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {'interpreter'|'assistant'} o.role
   * @param {string} o.instructions
   * @param {Array} [o.tools]
   * @param {string} [o.label]
   */
  constructor({ role, instructions, tools = [], label = role }) {
    super();
    this.role = role;
    this.instructions = instructions;
    this.tools = tools;
    this.label = label;
    this.ready = false;
    this.closed = false;
    this.dec = new Decimator3();
    this.pending = [];
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${config.openai.key}` },
    });
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: this.instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: OAI_RATE },
              noise_reduction: { type: 'far_field' },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.55,
                prefix_padding_ms: 250,
                silence_duration_ms: this.role === 'interpreter' ? 450 : 500,
                create_response: true,
                interrupt_response: this.role === 'assistant',
              },
            },
            output: { format: { type: 'audio/pcm', rate: OAI_RATE }, voice: VOICE },
          },
          tools: this.tools,
          tool_choice: this.tools.length ? 'auto' : 'none',
        },
      }));
      this.ready = true;
      for (const b of this.pending) this._append(b);
      this.pending = [];
      console.log(`[rt:${this.label}] bağlı (${MODEL})`);
    });
    this.ws.on('message', (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case 'input_audio_buffer.speech_started':
          this.emit('speech_started'); break;
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript?.trim()) this.emit('heard', ev.transcript.trim()); break;
        case 'response.created':
          this.dec = new Decimator3();
          this.emit('response_start'); break;
        case 'response.output_audio.delta': {
          const pcm24 = Buffer.from(ev.delta, 'base64');
          this.emit('audio', this.dec.process(pcm24));
          break;
        }
        case 'response.output_audio_transcript.delta':
          this.emit('said_partial', ev.delta); break;
        case 'response.output_audio_transcript.done':
          if (ev.transcript?.trim()) this.emit('said', ev.transcript.trim()); break;
        case 'response.output_audio.done':
          this.emit('response_end'); break;
        case 'response.function_call_arguments.done': {
          let args = {}; try { args = JSON.parse(ev.arguments || '{}'); } catch {}
          this.emit('tool', { name: ev.name, callId: ev.call_id, args });
          break;
        }
        case 'error':
          console.error(`[rt:${this.label}] hata:`, ev.error?.message || JSON.stringify(ev)); break;
      }
    });
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      if (this.closed) return;
      this.fails = (this.fails || 0) + 1;
      console.warn(`[rt:${this.label}] kapandı`, code, reason?.toString());
      if (this.fails <= 3) setTimeout(() => this.connect(), 1500 * this.fails);
    });
    this.ws.on('error', (e) => console.error(`[rt:${this.label}] WS:`, e.message));
  }

  /** Telefon sesi (PCM16 8 kHz) ver. */
  feed(pcm8k) {
    const pcm24 = resample(pcm8k, config.rtp.sampleRate, OAI_RATE);
    if (!this.ready) { this.pending.push(pcm24); if (this.pending.length > 150) this.pending.shift(); return; }
    this._append(pcm24);
  }
  _append(buf) {
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
  }

  /** Araç sonucunu bildir ve konuşmaya devam ettir. */
  toolResult(callId, output) {
    if (!this.ready) return;
    this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } }));
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  /** Modelden metin söylemesini iste (karşılama vb.). */
  sayText(text) {
    if (!this.ready) return;
    this.ws.send(JSON.stringify({ type: 'response.create', response: { instructions: `Say exactly this, nothing else: "${text}"` } }));
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

export const ASSISTANT_TOOLS = [
  {
    type: 'function',
    name: 'call_number',
    description: 'Bir telefon numarasını ara (rehberdeki isim verilirse numarasını kullan).',
    parameters: { type: 'object', properties: { number: { type: 'string', description: 'E.164, ör. +19085551234' }, name: { type: 'string', description: 'Rehberdeki isim (opsiyonel)' } }, required: ['number'] },
  },
  { type: 'function', name: 'hangup', description: 'Görüşmeyi kapat.', parameters: { type: 'object', properties: {} } },
  {
    type: 'function',
    name: 'web_search',
    description: 'İnternette güncel bilgi ara (hava durumu, haber, trafik, fiyat, saatler, güncel olaylar).',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Arama sorusu, konum dahil (ör. "Caldwell NJ hava durumu bugün")' } }, required: ['query'] },
  },
];

/** OpenAI Responses API + web_search ile kısa, Türkçe cevap. */
export async function webSearch(query) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.SEARCH_MODEL || 'gpt-4.1-mini',
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'US', region: 'New Jersey', city: 'Caldwell' } }],
      input: `Soru: ${query}\nİnternette ara ve Türkçe, en fazla 3 kısa cümleyle, telefonda okunacak şekilde cevap ver. Kaynak linki yazma.`,
    }),
  });
  if (!res.ok) throw new Error('Arama hatası ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = j.output_text || (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join(' ');
  return (text || 'Sonuç bulunamadı.').trim();
}
