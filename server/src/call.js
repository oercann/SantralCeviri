// Çağrı yöneticisi: bacaklar, köprüler ve iki yönlü çeviri hattı
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, normalizeNumber } from './config.js';
import { RtpLeg, allocPort } from './rtp.js';
import { LiveTranscriber, translate, speakStream, intent } from './openai.js';
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
  remoteIntro: "Hello, this is a live interpreter line. The caller speaks Turkish; you will hear their words in English. Please speak normally and pause briefly between sentences.",
}

const PIN = process.env.ACCESS_PIN || '';

/**
 * Tek bir görüşme. İki bacak:
 *   user   : senin cebin (Türkçe konuşur, Türkçe duyar)
 *   remote : aranan kişi (İngilizce konuşur, İngilizce duyar)
 * Her bacak kendi köprüsünde, yanında bir ExternalMedia kanalı.
 * Bacaklar birbirini doğrudan duymaz; sadece çevrilmiş sesi duyar.
 */
export class CallSession extends EventEmitter {
  constructor(ari, userChannel, contact = null) {
    super();
    this.ari = ari;
    this.contact = contact; // arayan rehberde tanınıyorsa
    this.id = randomUUID().slice(0, 8);
    this.user = { channel: userChannel, bridge: null, media: null, rtp: null, stt: null, lang: 'tr' };
    this.remote = { channel: null, bridge: null, media: null, rtp: null, stt: null, lang: 'en' };
    this.history = []; // {src,dst,direction}
    this.state = 'init';
    this.dtmf = '';
    this.pendingTarget = null;
    this.ended = false;
    this.log = (...a) => console.log(`[${this.id}]`, ...a);
  }

  // ---------- Kurulum ----------
  async start() {
    this.log('Gelen çağrı, bacak kuruluyor');
    await this.setupLeg(this.user);
    this.log('Bacak hazır, RTP port', this.user.rtp.port);
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

  async checkPin(digits) {
    if (digits === PIN) {
      this.awaitDtmf = null;
      await this.askTarget();
    } else {
      this.pinTries = (this.pinTries || 0) + 1;
      if (this.pinTries >= 3) {
        await this.say(this.user, PROMPTS.badPinFinal);
        return this.end('bad-pin');
      }
      this.dtmf = '';
      await this.say(this.user, PROMPTS.badPin);
    }
  }

  async askTarget() {
    this.setState('dialing-prompt');
    if (this.pendingTarget) return this.dial(this.pendingTarget);
    await this.say(this.user, PROMPTS.number);
    this.dtmf = '';
    this.awaitDtmf = (digits) => this.dial(digits);
  }

  /** Jarvis modu: karşılama sonrası Türkçe sesli komut. */
  async handleCommand(text) {
    this.emit('transcript', { speaker: 'user', type: 'final', text });
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await intent(text, allContacts());
      this.log('Komut:', text, '→', JSON.stringify(r));
      if (r.action === 'call' && r.number) {
        const c = findByName(String(r.number)) ;
        return this.dial(c ? c.number : r.number);
      }
      if (r.action === 'hangup') { await this.say(this.user, PROMPTS.bye); return this.end('user-bye'); }
      const reply = r.reply || PROMPTS.notFound;
      this.emit('transcript', { speaker: 'assistant', type: 'final', text: reply });
      await this.say(this.user, reply);
    } catch (e) {
      this.log('Komut hatası', e.message);
    } finally { this.busy = false; }
  }

  /** PWA'dan hedef numara geldi. */
  setTarget(number) {
    const n = normalizeNumber(number);
    if (!n) return;
    if (this.state === 'dialing-prompt') this.dial(n);
    else this.pendingTarget = n;
  }

  onDtmf(digit) {
    if (!this.awaitDtmf) return;
    if (digit === '#') {
      const d = this.dtmf;
      this.dtmf = '';
      this.awaitDtmf(d);
    } else if (digit === '*') {
      this.dtmf = '';
    } else {
      this.dtmf += digit;
      if (PIN && this.state === 'auth' && this.dtmf.length === PIN.length) {
        const d = this.dtmf;
        this.dtmf = '';
        this.awaitDtmf(d);
      }
    }
  }

  async dial(number) {
    const n = normalizeNumber(number);
    this.awaitDtmf = null;
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

  /** Dış bacak Stasis'e girdi (cevaplandı). */
  async onRemoteAnswered(channel) {
    this.remote.channel = channel;
    await this.setupLeg(this.remote);
    this.setState('connected');
    this.emit('status', { connected: true });
    this.say(this.user, PROMPTS.connected);
    await this.say(this.remote, PROMPTS.remoteIntro, 'en');
  }

  async setupLeg(leg) {
    const name = leg === this.user ? 'user' : 'remote';
    leg.bridge = await this.ari.createBridge(`${name}-${this.id}`);
    await this.ari.addToBridge(leg.bridge.id, leg.channel.id);

    const port = allocPort();
    leg.rtp = new RtpLeg(port);
    const mediaId = `media-${name}-${this.id}`;
    leg.media = { id: mediaId };
    await this.ari.request('POST', '/channels/externalMedia', {
      app: config.ari.app,
      channelId: mediaId,
      external_host: `${config.rtp.host}:${port}`,
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',
      direction: 'both',
    });
    await this.ari.addToBridge(leg.bridge.id, mediaId);

    leg.stt = new LiveTranscriber(leg.lang);
    leg.rtp.on('ready', () => this.log(name, 'RTP: Asterisk paketi geldi', leg.rtp.peer.address + ':' + leg.rtp.peer.port));
    let frames = 0;
    setTimeout(() => { if (!leg.rtp.peer) this.log(name, 'UYARI: 3 sn içinde Asterisk\'ten RTP gelmedi'); }, 3000);
    leg.rtp.on('audio', (pcm) => {
      if (++frames % 250 === 0) this.log(name, 'RTP kare', frames);
      if (this.state === 'connected' || (leg === this.user && this.state === 'dialing-prompt')) leg.stt.feed(pcm);
    });
    leg.stt.on('speech_started', () => {
      // Kişi konuşmaya başladı: ona çalmakta olan çeviriyi kes (barge-in)
      leg.rtp.flush();
      this.emit('transcript', { speaker: name, type: 'speaking' });
    });
    leg.stt.on('partial', (t) => this.emit('transcript', { speaker: name, type: 'partial', text: t }));
    leg.stt.on('final', (t) => this.handleUtterance(leg, t));
  }

  // ---------- Çeviri hattı ----------
  async handleUtterance(fromLeg, text) {
    if (fromLeg === this.user && this.state === 'dialing-prompt') return this.handleCommand(text);
    if (this.state !== 'connected') return;
    const toLeg = fromLeg === this.user ? this.remote : this.user;
    const direction = fromLeg === this.user ? 'tr>en' : 'en>tr';
    const speaker = fromLeg === this.user ? 'user' : 'remote';
    this.emit('transcript', { speaker, type: 'final', text });
    try {
      const ctx = this.history.filter((h) => h.direction === direction);
      const translated = await translate(text, direction, ctx);
      this.history.push({ src: text, dst: translated, direction });
      this.emit('transcript', { speaker, type: 'translated', text: translated, original: text });
      if (toLeg.rtp && this.state === 'connected') {
        await speakStream(translated, toLeg.lang, (pcm) => toLeg.rtp.send(pcm));
      }
    } catch (e) {
      this.log('Çeviri/TTS hatası', e.message);
      this.emit('transcript', { speaker: 'system', type: 'error', text: 'Çeviri hatası: ' + e.message });
    }
  }

  /** Sisteme ait Türkçe/İngilizce uyarı sesi çal. */
  async say(leg, text, lang = leg.lang) {
    if (!leg.rtp) return;
    try {
      const t0 = Date.now();
      let first = 0;
      await speakStream(text, lang, (pcm) => { if (!first) first = Date.now() - t0; leg.rtp.send(pcm); });
      this.log('TTS ilk ses', first, 'ms →', text.slice(0, 30));
      await new Promise((r) => setTimeout(r, leg.rtp.pendingMs + 100));
    } catch (e) {
      this.log('say hatası', e.message);
    }
  }

  /** PWA'dan yazılı mesaj: çevirip karşı tarafa okut (konuşmak istemediğinde). */
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
    for (const leg of [this.user, this.remote]) {
      leg.stt?.close();
      leg.rtp?.close();
      if (leg.media) await this.ari.hangup(leg.media.id);
      if (leg.channel) await this.ari.hangup(leg.channel.id);
      if (leg.bridge) await this.ari.destroyBridge(leg.bridge.id);
    }
    this.emit('ended', { reason, history: this.history });
  }
}
