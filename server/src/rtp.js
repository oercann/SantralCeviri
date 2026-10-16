// Asterisk ExternalMedia ile RTP alışverişi (ulaw 8 kHz; içeride PCM16 kullanılır)
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { pcmToUlaw, ulawToPcm } from './audio.js';

const FRAME_MS = 20;
const FRAME_SAMPLES = (config.rtp.sampleRate * FRAME_MS) / 1000; // 320
const FRAME_BYTES = FRAME_SAMPLES * 2; // PCM16 bayt (ulaw'da 1 bayt/örnek)
const PREROLL_BYTES = (config.rtp.sampleRate * 2 * 400) / 1000; // 400 ms ön tampon

let nextPort = config.rtp.portBase;
export function allocPort() {
  const p = nextPort;
  nextPort += 2;
  if (nextPort > config.rtp.portBase + 1000) nextPort = config.rtp.portBase;
  return p;
}

/**
 * Tek bir bacak için RTP uç noktası.
 * 'audio' olayı: Asterisk'ten gelen 20ms PCM16 kareleri.
 * send(pcm): kuyruğa ekler, 20ms aralıkla Asterisk'e yollar.
 */
export class RtpLeg extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.sock = dgram.createSocket('udp4');
    this.peer = null; // Asterisk'in adresi (ilk paketten öğrenilir)
    this.pt = 0; // ulaw
    this.seq = Math.floor(Math.random() * 65535);
    this.ts = Math.floor(Math.random() * 1e9);
    this.ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.queue = Buffer.alloc(0);
    this.timer = null;
    this.closed = false;
    this.sent = 0;
    this.open = false;
    this.playing = false;
    this.underruns = 0;
    this.nextAt = 0;

    this.sock.on('message', (msg, rinfo) => {
      if (msg.length < 12) return;
      if (!this.peer) {
        this.peer = rinfo;
        this.pt = msg[1] & 0x7f;
        this.emit('ready');
      }
      const cc = msg[0] & 0x0f;
      const hasExt = (msg[0] & 0x10) !== 0;
      let off = 12 + cc * 4;
      if (hasExt && msg.length >= off + 4) {
        const extLen = msg.readUInt16BE(off + 2) * 4;
        off += 4 + extLen;
      }
      if (off >= msg.length) return;
      this.emit('audio', ulawToPcm(msg.subarray(off)));
    });
    this.sock.on('error', (e) => console.error('RTP soket hatası', e.message));
    this.sock.bind(port, config.rtp.host);
  }

  /** Bir cümle/akış başlıyor: ön tampon dolana kadar çalma. */
  beginUtterance() { this.open = true; }
  /** Akış bitti: kalan ne varsa çal. */
  endUtterance() { this.open = false; this._maybeStart(); }

  /** PCM16 (8 kHz) gönderim kuyruğuna ekle. */
  send(pcm) {
    if (this.closed) return;
    this.queue = Buffer.concat([this.queue, pcm]);
    this._maybeStart();
  }

  _maybeStart() {
    if (this.playing || this.queue.length < FRAME_BYTES) return;
    const enough = !this.open || this.queue.length >= PREROLL_BYTES;
    if (!enough) return;
    this.playing = true;
    this.nextAt = performance.now();
    if (!this.timer) this.timer = setInterval(() => this._tick(), 5);
  }

  /** Kuyruğu boşalt (kullanıcı sözünü kestiğinde). */
  flush() {
    this.queue = Buffer.alloc(0);
    this.playing = false;
  }

  get pendingMs() {
    return (this.queue.length / FRAME_BYTES) * FRAME_MS;
  }

  _tick() {
    if (!this.playing) {
      if (!this.open && this.queue.length < FRAME_BYTES) {
        clearInterval(this.timer); this.timer = null;
        console.log(`RTP port ${this.port}: kuyruk bitti, toplam ${this.sent} kare gönderildi → ${this.peer?.address}:${this.peer?.port} pt=${this.pt} underrun=${this.underruns}`);
        this.emit('drained');
      }
      return;
    }
    const now = performance.now();
    let budget = 4; // geç kalınmışsa en fazla 4 kare yetiştir
    while (now >= this.nextAt && budget-- > 0) {
      if (!this.peer || this.queue.length < FRAME_BYTES) {
        // Kaynak yetişemedi: duraklat, ön tampon dolunca devam
        this.playing = false;
        if (this.open) this.underruns++;
        return;
      }
      this._sendFrame();
      this.nextAt += FRAME_MS;
    }
  }

  _sendFrame() {
    const payload = pcmToUlaw(this.queue.subarray(0, FRAME_BYTES));
    this.queue = this.queue.subarray(FRAME_BYTES);
    const hdr = Buffer.alloc(12);
    hdr[0] = 0x80;
    hdr[1] = this.pt & 0x7f;
    hdr.writeUInt16BE(this.seq, 2);
    hdr.writeUInt32BE(this.ts >>> 0, 4);
    hdr.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
    this.sent++;
    this.sock.send(Buffer.concat([hdr, payload]), this.peer.port, this.peer.address, (e) => { if (e) console.error('RTP send hatası', e.message); });
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try { this.sock.close(); } catch {}
  }
}
