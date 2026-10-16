// Çağrı yöneticisi v3 — üç kişilik hat (sen + karşı taraf + tercüman)
//
//  Ortak köprü (mixing): [user] + [remote] + [media-main]  → herkes birbirini duyar,
//  tercümanın/asistanın sesi media-main üzerinden hatta verilir (sıra ile, aynı anda tek ses).
//  Her tarafın yalnızca kendi konuşması Snoop(spy=in) ile ayrı dinlenir:
//     user  → snoop → Tercüman TR→EN ─┐
//     remote→ snoop → Tercüman EN→TR ─┴→ Çıkış kapısı → media-main (hat)
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, normalizeNumber } from './config.js';
import { RtpLeg, allocPort } from './rtp.js';
import { speakStream, translateStream } from './openai.js';
import { RealtimeSession, ROLES, ASSISTANT_TOOLS, webSearch } from './realtime.js';
import { allContacts, findByName } from './contacts.js';

export const PROMPTS = {
  pin: 'Merhaba. Lütfen PIN kodunuzu girin.',
  badPin: 'Hatalı PIN, tekrar deneyin.',
  badPinFinal: 'Hatalı PIN. Görüşme sonlandırılıyor.',
  number: 'Kimi arayalım?',
  notFound: 'Numarayı anlayamadım. Tekrar söyler ya da tuşlar mısınız?',
  bye: 'Görüşmek üzere.',
  dialing: 'Aranıyor.',
  failed: 'Arama yapılamadı.',
  connected: 'Bağlandı. Tercüman hatta.',
  noAnswer: 'Karşı taraf cevap vermedi.',
  remoteHangup: 'Karşı taraf görüşmeyi sonlandırdı.',
  remoteIntro: 'Hello, an interpreter is on the line. Please speak after each sentence is interpreted.',
};

const PIN = process.env.ACCESS_PIN || '';

/** Tek çıkış kapısı: birden çok kaynak (tercümanlar, anonslar) aynı hatta sırayla konuşur. */
class OutputGate {
  constructor(rtp) { this.rtp = rtp; this.active = null; this.waiting = []; }
  /** Bir kaynak konuşmaya başlıyor; kapı boşsa canlı geçer, doluysa tamponlanır. */
  open(key) {
    const src = { key, chunks: [], done: false, live: false };
    if (!this.active) { this.active = src; src.live = true; this.rtp.beginUtterance(); }
    else this.waiting.push(src);
    return src;
  }
  push(src, pcm) { if (src.live) this.rtp.send(pcm); else src.chunks.push(pcm); }
  close(src) {
    src.done = true;
    if (src.live) this._finish();
  }
  _finish() {
    this.rtp.endUtterance();
    this.active = null;
    const next = this.waiting.shift();
    if (!next) return;
    this.active = next; next.live = true;
    this.rtp.beginUtterance();
    for (const c of next.chunks) this.rtp.send(c);
    next.chunks = [];
    if (next.done) this._finish();
  }
  flush() { this.rtp.flush(); }
}

export class CallSession extends EventEmitter {
  constructor(ari, userChannel, contact = null) {
    super();
    this.ari = ari;
    this.contact = contact;
    this.id = randomUUID().slice(0, 8);
    this.user = { name: 'user', channel: userChannel, lang: 'tr', snoop: null, interp: null };
    this.remote = { name: 'remote', channel: null, lang: 'en', snoop: null, interp: null };
    this.main = { bridge: null, media: null, rtp: null };
    this.gate = null;
    this.assistant = null;
    this.history = [];
    this.state = 'init';
    this.dtmf = '';
    this.pendingTarget = null;
    this.ended = false;
    this.log = (...a) => console.log(`[${this.id}]`, ...a);
  }

  // ---------- Kurulum ----------
  async start() {
    this.log('Gelen çağrı');
    this.main.bridge = await this.ari.createBridge(`main-${this.id}`);
    await this.ari.addToBridge(this.main.bridge.id, this.user.channel.id);
    this.main.media = await this.createMedia(`media-main-${this.id}`, this.main.bridge.id);
    this.main.rtp = this.main.media.rtp;
    this.gate = new OutputGate(this.main.rtp);
    // Bağlanmadan önce köprüde yalnız user var → bu ses asistana gider
    this.main.rtp.on('audio', (pcm) => {
      if (this.state === 'dialing-prompt' && this.assistant && Date.now() > (this.keypadUntil || 0)) this.assistant.feed(pcm);
    });

    this.setState('auth');
    if (this.contact?.trusted) {
      this.log('Tanınan arayan:', this.contact.name);
      await this.say(`Merhaba ${this.contact.name}.`, 'tr');
      await this.askTarget();
    } else if (PIN) {
      await this.say(PROMPTS.pin, 'tr');
      this.dtmf = '';
      this.awaitDtmf = (digits) => this.checkPin(digits);
    } else {
      await this.askTarget();
    }
  }

  async createMedia(id, bridgeId) {
    const port = allocPort();
    const rtp = new RtpLeg(port);
    await this.ari.request('POST', '/channels/externalMedia', {
      app: config.ari.app, channelId: id,
      external_host: `${config.rtp.host}:${port}`,
      format: 'ulaw', encapsulation: 'rtp', transport: 'udp', connection_type: 'client', direction: 'both',
    });
    await this.ari.addToBridge(bridgeId, id);
    setTimeout(() => { if (!rtp.peer) this.log(id, 'UYARI: Asterisk\'ten RTP gelmedi'); }, 3000);
    return { id, rtp, port };
  }

  /** Bir tarafın yalnızca kendi sesini dinleyen snoop + media. */
  async setupSnoop(party) {
    const snoopId = `snoop-${party.name}-${this.id}`;
    await this.ari.request('POST', `/channels/${party.channel.id}/snoop`, {
      app: config.ari.app, appArgs: 'snoop', snoopId, spy: 'in', whisper: 'none',
    });
    const bridge = await this.ari.createBridge(`snoop-${party.name}-${this.id}`);
    await this.ari.addToBridge(bridge.id, snoopId);
    const media = await this.createMedia(`media-${party.name}-${this.id}`, bridge.id);
    party.snoop = { id: snoopId, bridge, media };
    media.rtp.on('audio', (pcm) => { if (this.state === 'connected' && party.interp) party.interp.feed(pcm); });
  }

  /** Tercüman: metne dök → çevir → seslendir (model asla sohbet edemez). */
  pipeInterpreter(session, party) {
    const direction = party === this.user ? 'tr>en' : 'en>tr';
    const toLang = party === this.user ? 'en' : 'tr';
    session.on('heard', async (text) => {
      if (this.state !== 'connected') return;
      this.emit('transcript', { speaker: party.name, type: 'final', text });
      const t0 = Date.now();
      try {
        const ctx = this.history.filter((h) => h.direction === direction);
        const full = await translateStream(text, direction, ctx, (sentence) => {
          this.emit('transcript', { speaker: party.name, type: 'translated', text: sentence, original: text });
          this.say(sentence, toLang);
        });
        this.history.push({ who: party.name, src: text, dst: full, direction });
        this.log(`${party.name} ${direction} ${Date.now() - t0}ms:`, text, '⇒', full);
      } catch (e) { this.log('Çeviri hatası', e.message); }
    });
  }

  /** Bir model oturumunun çıkışını kapıya bağla. */
  pipe(session, label) {
    let src = null;
    session.on('response_start', () => { src = this.gate.open(label); });
    session.on('audio', (pcm) => { if (src) this.gate.push(src, pcm); });
    session.on('response_end', () => { if (src) { this.gate.close(src); src = null; } });
    session.on('heard', (t) => { this.emit('transcript', { speaker: label, type: 'final', text: t }); this.history.push({ who: label, text: t }); });
    session.on('said', (t) => this.emit('transcript', { speaker: label, type: 'translated', text: t }));
  }

  // ---------- Asistan (Jarvis) ----------
  startAssistant() {
    if (this.assistant) return;
    const a = new RealtimeSession({ role: 'assistant', instructions: ROLES.assistant(allContacts()), tools: ASSISTANT_TOOLS, label: 'asistan' });
    this.pipe(a, 'user');
    a.on('speech_started', () => this.gate.flush()); // araya girince anonsu kes
    a.on('tool', async ({ name, callId, args }) => {
      this.log('Araç:', name, JSON.stringify(args));
      if (name === 'call_number') {
        const c = args.name ? findByName(args.name) : null;
        const n = normalizeNumber(c ? c.number : args.number);
        if (!n || n.length < 8) return a.toolResult(callId, { ok: false, error: 'Numara anlaşılamadı' });
        a.toolResult(callId, { ok: true, dialing: n });
        setTimeout(() => this.dial(n), 1200);
      } else if (name === 'hangup') {
        a.toolResult(callId, { ok: true });
        setTimeout(() => this.end('user-bye'), 1500);
      } else if (name === 'web_search') {
        try {
          const answer = await webSearch(String(args.query || ''));
          this.log('Arama sonucu:', answer.slice(0, 120));
          a.toolResult(callId, { ok: true, answer });
        } catch (e) { a.toolResult(callId, { ok: false, error: e.message }); }
      }
    });
    this.assistant = a;
  }

  stopAssistant() { this.assistant?.close(); this.assistant = null; }

  // ---------- Giriş / hedef ----------
  async checkPin(digits) {
    if (digits === PIN) { this.awaitDtmf = null; await this.askTarget(); return; }
    this.pinTries = (this.pinTries || 0) + 1;
    if (this.pinTries >= 3) { await this.say(PROMPTS.badPinFinal, 'tr'); return this.end('bad-pin'); }
    this.dtmf = '';
    await this.say(PROMPTS.badPin, 'tr');
  }

  async askTarget() {
    this.setState('dialing-prompt');
    if (this.pendingTarget) return this.dial(this.pendingTarget);
    this.startAssistant();
    await this.say(PROMPTS.number, 'tr');
    this.dtmf = '';
    this.awaitDtmf = (digits) => this.dial(digits);
  }

  setTarget(number) {
    const n = normalizeNumber(number);
    if (!n) return;
    if (this.state === 'dialing-prompt') this.dial(n); else this.pendingTarget = n;
  }

  onDtmf(digit) {
    if (!this.awaitDtmf) return;
    this.keypadUntil = Date.now() + 5000;
    this.gate.flush();
    clearTimeout(this.dtmfTimer);
    if (digit === '#') { const d = this.dtmf; this.dtmf = ''; return this.awaitDtmf(d); }
    if (digit === '*') { this.dtmf = ''; return; }
    this.dtmf += digit;
    if (PIN && this.state === 'auth') {
      if (this.dtmf.length === PIN.length) { const d = this.dtmf; this.dtmf = ''; this.awaitDtmf(d); }
      return;
    }
    if (this.dtmf.replace(/\D/g, '').length >= 10) {
      this.dtmfTimer = setTimeout(() => { const d = this.dtmf; this.dtmf = ''; this.awaitDtmf?.(d); }, 1200);
    }
  }

  async dial(number) {
    if (this.state === 'ringing' || this.state === 'connected') return;
    const n = normalizeNumber(number);
    if (!n || n.length < 8) { await this.say(PROMPTS.notFound, 'tr'); return; }
    this.awaitDtmf = null;
    this.stopAssistant();
    this.target = n;
    this.setState('ringing');
    this.emit('status', { target: n });
    await this.say(PROMPTS.dialing, 'tr');
    const chanId = `remote-${this.id}`;
    this.remote.channel = { id: chanId };
    try {
      await this.ari.request('POST', '/channels', {
        endpoint: `PJSIP/${n.replace('+', '')}@${config.trunk.endpoint}`,
        app: config.ari.app, appArgs: `outbound,${n}`, callerId: config.trunk.myDid, channelId: chanId, timeout: 45,
      });
    } catch (e) {
      this.log('Arama başarısız', e.message);
      await this.say(PROMPTS.failed, 'tr');
      return this.end('originate-failed');
    }
  }

  /** Karşı taraf açtı: ortak köprüye al, iki tarafa snoop + tercüman. */
  async onRemoteAnswered(channel) {
    this.remote.channel = channel;
    await this.ari.addToBridge(this.main.bridge.id, channel.id);
    await this.setupSnoop(this.user);
    await this.setupSnoop(this.remote);
    this.user.interp = new RealtimeSession({ role: 'interpreter', instructions: ROLES.interpreter('Turkish', 'English'), label: 'TR→EN', src: 'Turkish', dst: 'English' });
    this.pipeInterpreter(this.user.interp, this.user);
    this.remote.interp = new RealtimeSession({ role: 'interpreter', instructions: ROLES.interpreter('English', 'Turkish'), label: 'EN→TR', src: 'English', dst: 'Turkish' });
    this.pipeInterpreter(this.remote.interp, this.remote);
    this.setState('connected');
    this.emit('status', { connected: true });
    await this.say(PROMPTS.remoteIntro, 'en');
  }

  // ---------- Anonslar (önbellekli TTS) — kapı üzerinden ----------
  async say(text, lang) {
    if (!this.gate || this.ended) return;
    const src = this.gate.open('anons');
    try {
      await speakStream(text, lang, (pcm) => this.gate.push(src, pcm));
    } catch (e) { this.log('say hatası', e.message); }
    this.gate.close(src);
    await new Promise((r) => setTimeout(r, this.main.rtp.pendingMs + 60));
  }

  /** PWA'dan yazılı metin: İngilizce olarak hatta okut. */
  async typeToRemote(text) {
    if (this.state !== 'connected') return;
    this.emit('transcript', { speaker: 'user', type: 'final', text });
    await this.say(text, 'en');
  }

  setState(s) { this.state = s; this.emit('status', { state: s }); }

  // ---------- Kapanış ----------
  async end(reason = 'hangup') {
    if (this.ended) return;
    this.ended = true;
    this.setState('ended');
    this.log('Görüşme bitti:', reason);
    this.stopAssistant();
    for (const party of [this.user, this.remote]) {
      party.interp?.close();
      if (party.snoop) {
        party.snoop.media.rtp.close();
        await this.ari.hangup(party.snoop.media.id);
        await this.ari.hangup(party.snoop.id);
        await this.ari.destroyBridge(party.snoop.bridge.id);
      }
      if (party.channel) await this.ari.hangup(party.channel.id);
    }
    this.main.rtp?.close();
    if (this.main.media) await this.ari.hangup(this.main.media.id);
    if (this.main.bridge) await this.ari.destroyBridge(this.main.bridge.id);
    this.emit('ended', { reason, history: this.history });
  }
}
