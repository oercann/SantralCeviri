// Çağrı yöneticisi v2 — gerçek zamanlı ses→ses tercüman
//
//  user  ──bridge──┬── media(user)   : user'ın sesi → Tercüman TR→EN → remote'a çalınır
//  remote──bridge──┴── media(remote) : remote'un sesi → Tercüman EN→TR → user'a çalınır
//  Taraflar birbirinin orijinal sesini duymaz; sadece çeviriyi duyar (temiz, karışma yok).
//  Bağlanmadan önce user tarafında "asistan" oturumu (Jarvis) çalışır.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, normalizeNumber } from './config.js';
import { RtpLeg, allocPort } from './rtp.js';
import { speakStream } from './openai.js';
import { RealtimeSession, ROLES, ASSISTANT_TOOLS } from './realtime.js';
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
  connected: 'Bağlandı, konuşabilirsiniz.',
  noAnswer: 'Karşı taraf cevap vermedi.',
  remoteHangup: 'Karşı taraf görüşmeyi sonlandırdı.',
  remoteIntro: 'Hello, this call is interpreted live from Turkish. Please go ahead.',
};

const PIN = process.env.ACCESS_PIN || '';

export class CallSession extends EventEmitter {
  constructor(ari, userChannel, contact = null) {
    super();
    this.ari = ari;
    this.contact = contact;
    this.id = randomUUID().slice(0, 8);
    this.user = { name: 'user', channel: userChannel, lang: 'tr', bridge: null, media: null, rtp: null, interp: null };
    this.remote = { name: 'remote', channel: null, lang: 'en', bridge: null, media: null, rtp: null, interp: null };
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
    await this.setupLeg(this.user);
    this.setState('auth');
    if (this.contact?.trusted) {
      this.log('Tanınan arayan:', this.contact.name);
      await this.say(this.user, `Merhaba ${this.contact.name}.`);
      await this.askTarget();
    } else if (PIN) {
      await this.say(this.user, PROMPTS.pin);
      this.dtmf = '';
      this.awaitDtmf = (digits) => this.checkPin(digits);
    } else {
      await this.askTarget();
    }
  }

  async setupLeg(leg) {
    leg.bridge = await this.ari.createBridge(`${leg.name}-${this.id}`);
    await this.ari.addToBridge(leg.bridge.id, leg.channel.id);
    const port = allocPort();
    leg.rtp = new RtpLeg(port);
    leg.media = { id: `media-${leg.name}-${this.id}` };
    await this.ari.request('POST', '/channels/externalMedia', {
      app: config.ari.app,
      channelId: leg.media.id,
      external_host: `${config.rtp.host}:${port}`,
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',
      direction: 'both',
    });
    await this.ari.addToBridge(leg.bridge.id, leg.media.id);
    setTimeout(() => { if (!leg.rtp.peer) this.log(leg.name, 'UYARI: Asterisk\'ten RTP gelmedi'); }, 3000);
    leg.rtp.on('audio', (pcm) => this.onAudio(leg, pcm));
  }

  /** Tarafın sesi: duruma göre asistana ya da tercümana gider. */
  onAudio(leg, pcm) {
    if (leg === this.user && this.state === 'dialing-prompt' && this.assistant && Date.now() > (this.keypadUntil || 0)) {
      this.assistant.feed(pcm);
    } else if (this.state === 'connected' && leg.interp) {
      leg.interp.feed(pcm);
    }
  }

  /** Model çıkışını bir bacağa bağla (tampon yönetimiyle). */
  pipe(session, toLeg, speakerLabel) {
    session.on('response_start', () => toLeg.rtp.beginUtterance());
    session.on('audio', (pcm) => toLeg.rtp.send(pcm));
    session.on('response_end', () => toLeg.rtp.endUtterance());
    session.on('heard', (t) => { this.emit('transcript', { speaker: speakerLabel, type: 'final', text: t }); this.history.push({ who: speakerLabel, text: t }); });
    session.on('said', (t) => this.emit('transcript', { speaker: speakerLabel, type: 'translated', text: t }));
  }

  // ---------- Asistan (Jarvis) ----------
  startAssistant() {
    if (this.assistant) return;
    const a = new RealtimeSession({ role: 'assistant', instructions: ROLES.assistant(allContacts()), tools: ASSISTANT_TOOLS, label: 'asistan' });
    this.pipe(a, this.user, 'user');
    a.on('speech_started', () => this.user.rtp.flush()); // araya girince anonsu kes
    a.on('tool', async ({ name, callId, args }) => {
      this.log('Araç:', name, JSON.stringify(args));
      if (name === 'call_number') {
        const c = args.name ? findByName(args.name) : null;
        const n = normalizeNumber(c ? c.number : args.number);
        if (!n || n.length < 8) return a.toolResult(callId, { ok: false, error: 'Numara anlaşılamadı' });
        a.toolResult(callId, { ok: true, dialing: n });
        setTimeout(() => this.dial(n), 1200); // "Arıyorum" demesine zaman tanı
      } else if (name === 'hangup') {
        a.toolResult(callId, { ok: true });
        setTimeout(() => this.end('user-bye'), 1500);
      }
    });
    this.assistant = a;
  }

  stopAssistant() {
    this.assistant?.close();
    this.assistant = null;
  }

  // ---------- Giriş / hedef ----------
  async checkPin(digits) {
    if (digits === PIN) { this.awaitDtmf = null; await this.askTarget(); return; }
    this.pinTries = (this.pinTries || 0) + 1;
    if (this.pinTries >= 3) { await this.say(this.user, PROMPTS.badPinFinal); return this.end('bad-pin'); }
    this.dtmf = '';
    await this.say(this.user, PROMPTS.badPin);
  }

  async askTarget() {
    this.setState('dialing-prompt');
    if (this.pendingTarget) return this.dial(this.pendingTarget);
    this.startAssistant();
    await this.say(this.user, PROMPTS.number);
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
    this.user.rtp.flush();
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
    if (!n || n.length < 8) { await this.say(this.user, PROMPTS.notFound); return; }
    this.awaitDtmf = null;
    this.stopAssistant();
    this.target = n;
    this.setState('ringing');
    this.emit('status', { target: n });
    await this.say(this.user, PROMPTS.dialing);
    const chanId = `remote-${this.id}`;
    this.remote.channel = { id: chanId };
    try {
      await this.ari.request('POST', '/channels', {
        endpoint: `PJSIP/${n.replace('+', '')}@${config.trunk.endpoint}`,
        app: config.ari.app,
        appArgs: `outbound,${n}`,
        callerId: config.trunk.myDid,
        channelId: chanId,
        timeout: 45,
      });
    } catch (e) {
      this.log('Arama başarısız', e.message);
      await this.say(this.user, PROMPTS.failed);
      return this.end('originate-failed');
    }
  }

  /** Karşı taraf açtı: iki tercüman oturumu. */
  async onRemoteAnswered(channel) {
    this.remote.channel = channel;
    await this.setupLeg(this.remote);
    // user'ın Türkçesi → İngilizce → remote
    this.user.interp = new RealtimeSession({ role: 'interpreter', instructions: ROLES.interpreter('Turkish', 'English'), label: 'TR→EN' });
    this.pipe(this.user.interp, this.remote, 'user');
    // remote'un İngilizcesi → Türkçe → user
    this.remote.interp = new RealtimeSession({ role: 'interpreter', instructions: ROLES.interpreter('English', 'Turkish'), label: 'EN→TR' });
    this.pipe(this.remote.interp, this.user, 'remote');
    this.setState('connected');
    this.emit('status', { connected: true });
    this.say(this.user, PROMPTS.connected);
    this.say(this.remote, PROMPTS.remoteIntro, 'en');
  }

  // ---------- Sistem anonsları (önbellekli TTS) ----------
  async say(leg, text, lang = leg.lang) {
    if (!leg.rtp || this.ended) return;
    try {
      leg.rtp.beginUtterance();
      await speakStream(text, lang, (pcm) => leg.rtp.send(pcm));
      leg.rtp.endUtterance();
      await new Promise((r) => setTimeout(r, leg.rtp.pendingMs + 60));
    } catch (e) {
      leg.rtp.endUtterance();
      this.log('say hatası', e.message);
    }
  }

  /** PWA'dan yazılı metin: İngilizce olarak karşı tarafa okut. */
  async typeToRemote(text) {
    if (this.state !== 'connected') return;
    this.emit('transcript', { speaker: 'user', type: 'final', text });
    await this.say(this.remote, text, 'en');
  }

  setState(s) { this.state = s; this.emit('status', { state: s }); }

  // ---------- Kapanış ----------
  async end(reason = 'hangup') {
    if (this.ended) return;
    this.ended = true;
    this.setState('ended');
    this.log('Görüşme bitti:', reason);
    this.stopAssistant();
    for (const leg of [this.user, this.remote]) {
      leg.interp?.close();
      leg.rtp?.close();
      if (leg.media) await this.ari.hangup(leg.media.id);
      if (leg.channel) await this.ari.hangup(leg.channel.id);
      if (leg.bridge) await this.ari.destroyBridge(leg.bridge.id);
    }
    this.emit('ended', { reason, history: this.history });
  }
}
