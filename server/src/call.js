// Çağrı yöneticisi — "3. kişi" tercüman modu
//
//  Ortak köprü (mixing): [user] + [remote] + [tercüman sesi: ExternalMedia]
//     → herkes birbirini duyar, tercüman araya girip çeviriyi herkese söyler.
//  Her tarafı ayrı dinlemek için Snoop(spy=in) kanalları: user ve remote'un
//  SADECE kendi söyledikleri ayrı ayrı STT'ye gider (tercümanın sesi karışmaz).
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, normalizeNumber } from './config.js';
import { RtpLeg, allocPort } from './rtp.js';
import { LiveTranscriber, translate, speakStream, intent, FILLERS } from './openai.js';
import { allContacts, findByName } from './contacts.js';

export const PROMPTS = {
  pin: 'Merhaba. Lütfen PIN kodunuzu girin.',
  badPin: 'Hatalı PIN, tekrar deneyin.',
  badPinFinal: 'Hatalı PIN. Görüşme sonlandırılıyor.',
  number: 'Kimi arayalım? İsmi veya numarayı söyleyebilir ya da tuşlayıp kare tuşuna basabilirsiniz.',
  notFound: 'Bu kişiyi rehberde bulamadım.',
  bye: 'Görüşmek üzere.',
  dialing: 'Aranıyor. Karşı taraf açınca Türkçe konuşmaya başlayabilirsiniz.',
  failed: 'Arama yapılamadı.',
  connected: 'Bağlandı.',
  noAnswer: 'Karşı taraf cevap vermedi.',
  remoteHangup: 'Karşı taraf görüşmeyi sonlandırdı.',
  remoteIntro: "Hello, this is a live interpreter line. The caller speaks Turkish and I will interpret into English. Please pause briefly between sentences.",
};

const PIN = process.env.ACCESS_PIN || '';

export class CallSession extends EventEmitter {
  constructor(ari, userChannel, contact = null) {
    super();
    this.ari = ari;
    this.contact = contact;
    this.id = randomUUID().slice(0, 8);
    this.user = { name: 'user', channel: userChannel, lang: 'tr', stt: null, snoop: null };
    this.remote = { name: 'remote', channel: null, lang: 'en', stt: null, snoop: null };
    this.main = { bridge: null, media: null, rtp: null }; // ortak köprü + tercüman sesi
    this.history = [];
    this.assistantHistory = []; // Jarvis modu bağlamı
    this.state = 'init';
    this.dtmf = '';
    this.pendingTarget = null;
    this.ended = false;
    this.speakChain = Promise.resolve(); // tercüman tek seferde tek cümle konuşur
    this.log = (...a) => console.log(`[${this.id}]`, ...a);
  }

  // ---------- Kurulum ----------
  async start() {
    this.log('Gelen çağrı');
    await this.setupMain();
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

  /** Ortak köprü: user + tercüman ExternalMedia. Bağlanınca remote da eklenir. */
  async setupMain() {
    this.main.bridge = await this.ari.createBridge(`main-${this.id}`);
    await this.ari.addToBridge(this.main.bridge.id, this.user.channel.id);
    this.main.media = await this.createExternalMedia(`media-main-${this.id}`, this.main.bridge.id);
    this.main.rtp = this.main.media.rtp;

    // Bağlanmadan önce köprüde sadece user var → bu ses doğrudan user'ın sesi (asistan modu)
    this.user.stt = this.makeStt(this.user);
    this.main.rtp.on('audio', (pcm) => {
      if (this.state === 'dialing-prompt' && this.user.stt && Date.now() > (this.keypadUntil || 0)) this.user.stt.feed(pcm);
    });
  }

  async createExternalMedia(id, bridgeId) {
    const port = allocPort();
    const rtp = new RtpLeg(port);
    await this.ari.request('POST', '/channels/externalMedia', {
      app: config.ari.app,
      channelId: id,
      external_host: `${config.rtp.host}:${port}`,
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',
      direction: 'both',
    });
    await this.ari.addToBridge(bridgeId, id);
    setTimeout(() => { if (!rtp.peer) this.log(id, 'UYARI: Asterisk\'ten RTP gelmedi'); }, 3000);
    return { id, rtp, port };
  }

  /** Bir tarafın yalnızca kendi sesini dinleyen snoop + ExternalMedia. */
  async setupSnoop(party) {
    const snoopId = `snoop-${party.name}-${this.id}`;
    await this.ari.request('POST', `/channels/${party.channel.id}/snoop`, {
      app: config.ari.app,
      appArgs: 'snoop',
      snoopId,
      spy: 'in',
      whisper: 'none',
    });
    const bridge = await this.ari.createBridge(`snoop-${party.name}-${this.id}`);
    await this.ari.addToBridge(bridge.id, snoopId);
    const media = await this.createExternalMedia(`media-${party.name}-${this.id}`, bridge.id);
    party.snoop = { id: snoopId, bridge, media };
    if (!party.stt) party.stt = this.makeStt(party);
    media.rtp.on('audio', (pcm) => { if (this.state === 'connected') party.stt.feed(pcm); });
  }

  makeStt(party) {
    const stt = new LiveTranscriber(party.lang);
    stt.on('speech_started', () => {
      // Asistan modunda konuşmaya başlayınca anonsu kes; görüşmede tercüman kesilmez
      if (this.state === 'dialing-prompt') this.main.rtp.flush();
      this.emit('transcript', { speaker: party.name, type: 'speaking' });
    });
    stt.on('partial', (t) => this.emit('transcript', { speaker: party.name, type: 'partial', text: t }));
    stt.on('final', (t) => this.handleUtterance(party, t));
    return stt;
  }

  // ---------- Giriş / hedef ----------
  async checkPin(digits) {
    if (digits === PIN) {
      this.awaitDtmf = null;
      await this.askTarget();
    } else {
      this.pinTries = (this.pinTries || 0) + 1;
      if (this.pinTries >= 3) {
        await this.say(PROMPTS.badPinFinal, 'tr');
        return this.end('bad-pin');
      }
      this.dtmf = '';
      await this.say(PROMPTS.badPin, 'tr');
    }
  }

  async askTarget() {
    this.setState('dialing-prompt');
    if (this.pendingTarget) return this.dial(this.pendingTarget);
    await this.say(PROMPTS.number, 'tr');
    this.dtmf = '';
    this.awaitDtmf = (digits) => this.dial(digits);
  }

  /** Jarvis modu: Türkçe sesli komut / soru. */
  async handleCommand(text) {
    this.emit('transcript', { speaker: 'user', type: 'final', text });
    if (this.busy) return;
    this.busy = true;
    try {
      // Anında kısa onay: sessizlik hissi olmasın
      this.say(FILLERS[Math.floor(Math.random() * FILLERS.length)], 'tr');
      const r = await intent(text, allContacts(), this.assistantHistory, (sentence) => {
        this.emit('transcript', { speaker: 'assistant', type: 'final', text: sentence });
        this.say(sentence, 'tr');
      });
      this.log('Komut:', text, '→', JSON.stringify(r));
      if (r.action === 'call' && r.number) {
        const c = findByName(String(r.number));
        return this.dial(c ? c.number : r.number);
      }
      if (r.action === 'hangup') { await this.say(PROMPTS.bye, 'tr'); return this.end('user-bye'); }
      this.assistantHistory.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply || '' });
      await this.speakChain;
    } catch (e) {
      this.log('Komut hatası', e.message);
    } finally { this.busy = false; }
  }

  setTarget(number) {
    const n = normalizeNumber(number);
    if (!n) return;
    if (this.state === 'dialing-prompt') this.dial(n);
    else this.pendingTarget = n;
  }

  onDtmf(digit) {
    if (!this.awaitDtmf) return;
    this.keypadUntil = Date.now() + 5000; // tuşlama sürerken STT dinlemez
    if (this.state === 'dialing-prompt') this.main.rtp.flush();
    clearTimeout(this.dtmfTimer);
    if (digit === '#') {
      const d = this.dtmf; this.dtmf = '';
      return this.awaitDtmf(d);
    }
    if (digit === '*') { this.dtmf = ''; return; }
    this.dtmf += digit;
    if (PIN && this.state === 'auth') {
      if (this.dtmf.length === PIN.length) { const d = this.dtmf; this.dtmf = ''; this.awaitDtmf(d); }
      return;
    }
    // Numara: 10 hane (veya 1 ile 11) tamamlanınca kısa bekleyip ara
    const digits = this.dtmf.replace(/\D/g, '');
    if (digits.length >= 10) {
      this.dtmfTimer = setTimeout(() => { const d = this.dtmf; this.dtmf = ''; this.awaitDtmf?.(d); }, 1500);
    }
  }

  async dial(number) {
    const n = normalizeNumber(number);
    if (!n || n.length < 8) { await this.say(PROMPTS.notFound, 'tr'); return; }
    this.awaitDtmf = null;
    this.target = n;
    this.setState('ringing');
    this.emit('status', { target: n });
    await this.say(PROMPTS.dialing, 'tr');
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
      await this.say(PROMPTS.failed, 'tr');
      return this.end('originate-failed');
    }
  }

  /** Karşı taraf açtı: ortak köprüye al, iki tarafa snoop kur. */
  async onRemoteAnswered(channel) {
    this.remote.channel = channel;
    await this.ari.addToBridge(this.main.bridge.id, channel.id);
    await this.setupSnoop(this.user);
    await this.setupSnoop(this.remote);
    this.setState('connected');
    this.emit('status', { connected: true });
    await this.say(PROMPTS.remoteIntro, 'en');
  }

  // ---------- Çeviri ----------
  async handleUtterance(party, text) {
    if (party === this.user && this.state === 'dialing-prompt') return this.handleCommand(text);
    if (this.state !== 'connected') return;
    const direction = party === this.user ? 'tr>en' : 'en>tr';
    const toLang = party === this.user ? 'en' : 'tr';
    this.emit('transcript', { speaker: party.name, type: 'final', text });
    try {
      const ctx = this.history.filter((h) => h.direction === direction);
      const translated = await translate(text, direction, ctx);
      this.history.push({ src: text, dst: translated, direction });
      this.emit('transcript', { speaker: party.name, type: 'translated', text: translated, original: text });
      await this.say(translated, toLang);
    } catch (e) {
      this.log('Çeviri/TTS hatası', e.message);
      this.emit('transcript', { speaker: 'system', type: 'error', text: 'Çeviri hatası: ' + e.message });
    }
  }

  /** Tercüman sesi — ortak köprüye, sırayla. */
  say(text, lang) {
    const run = async () => {
      if (!this.main.rtp || this.ended) return;
      try {
        const t0 = Date.now();
        let first = 0;
        this.main.rtp.beginUtterance();
        await speakStream(text, lang, (pcm) => { if (!first) first = Date.now() - t0; this.main.rtp.send(pcm); });
        this.main.rtp.endUtterance();
        this.log('TTS', lang, first + 'ms →', text.slice(0, 40));
        await new Promise((r) => setTimeout(r, this.main.rtp.pendingMs + 60));
      } catch (e) {
        this.main.rtp?.endUtterance();
        this.log('say hatası', e.message);
      }
    };
    this.speakChain = this.speakChain.then(run, run);
    return this.speakChain;
  }

  async typeToRemote(text) {
    if (this.state !== 'connected') return;
    await this.handleUtterance(this.user, text);
  }

  setState(s) {
    this.state = s;
    this.emit('status', { state: s });
  }

  // ---------- Kapanış ----------
  async end(reason = 'hangup') {
    if (this.ended) return;
    this.ended = true;
    this.setState('ended');
    this.log('Görüşme bitti:', reason);
    for (const party of [this.user, this.remote]) {
      party.stt?.close();
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
