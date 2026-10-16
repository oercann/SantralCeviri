// Asterisk ExternalMedia ile RTP alışverişi (slin16: 16 kHz, 16-bit mono)
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

const FRAME_MS = 20;
const FRAME_SAMPLES = (config.rtp.sampleRate * FRAME_MS) / 1000; // 320
const FRAME_BYTES = FRAME_SAMPLES * 2; // 640
// Asterisk, slin formatlarını RTP'de network byte order (big-endian) ile taşır.
const SWAP = process.env.RTP_BIG_ENDIAN !== '0';
function swap16(buf) {
  const out = Buffer.allocUnsafe(buf.length & ~1);
  for (let i = 0; i < out.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return out;
}

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
    this.pt = 118;
    this.seq = Math.floor(Math.random() * 65535);
    this.ts = Math.floor(Math.random() * 1e9);
    this.ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.queue = Buffer.alloc(0);
    this.timer = null;
    this.closed = false;
    this.sent = 0;

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
      const payload = msg.subarray(off);
      this.emit('audio', SWAP ? swap16(payload) : payload);
    });
    this.sock.on('error', (e) => console.error('RTP soket hatası', e.message));
    this.sock.bind(port, config.rtp.host);
  }

  /** PCM16 @16k gönderim kuyruğuna ekle. */
  send(pcm) {
    if (this.closed) return;
    this.queue = Buffer.concat([this.queue, pcm]);
    if (!this.timer) this.timer = setInterval(() => this._tick(), FRAME_MS);
  }

  /** Kuyruğu boşalt (kullanıcı sözünü kestiğinde). */
  flush() {
    this.queue = Buffer.alloc(0);
  }

  get pendingMs() {
    return (this.queue.length / FRAME_BYTES) * FRAME_MS;
  }

  _tick() {
    if (!this.peer || this.queue.length < FRAME_BYTES) {
      if (this.queue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        console.log(`RTP port ${this.port}: kuyruk bitti, toplam ${this.sent} kare gönderildi → ${this.peer?.address}:${this.peer?.port} pt=${this.pt}`);
        this.emit('drained');
      }
      return;
    }
    let payload = this.queue.subarray(0, FRAME_BYTES);
    this.queue = this.queue.subarray(FRAME_BYTES);
    if (SWAP) payload = swap16(payload);
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
