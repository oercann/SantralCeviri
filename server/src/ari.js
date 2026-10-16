// Minimal Asterisk ARI istemcisi (REST + WebSocket olaylar)
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from './config.js';

export class Ari extends EventEmitter {
  constructor() {
    super();
    const { url, user, pass, app } = config.ari;
    this.base = url.replace(/\/$/, '') + '/ari';
    this.app = app;
    this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    this.ws = null;
  }

  async request(method, path, query = {}, body) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    const url = `${this.base}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ARI ${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  connect() {
    const wsUrl =
      this.base.replace(/^http/, 'ws') +
      `/events?app=${this.app}&subscribeAll=true&api_key=${encodeURIComponent(
        config.ari.user + ':' + config.ari.pass
      )}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => this.emit('connected'));
    this.ws.on('message', (data) => {
      try {
        const ev = JSON.parse(data.toString());
        this.emit('event', ev);
        this.emit(ev.type, ev);
      } catch (e) {
        console.error('ARI olay parse hatası', e);
      }
    });
    this.ws.on('close', () => {
      console.warn('ARI bağlantısı koptu, 3 sn sonra tekrar');
      setTimeout(() => this.connect(), 3000);
    });
    this.ws.on('error', (e) => console.error('ARI WS hata:', e.message));
  }

  // --- Kanal işlemleri ---
  answer(id) { return this.request('POST', `/channels/${id}/answer`); }
  hangup(id) { return this.request('DELETE', `/channels/${id}`).catch(() => {}); }
  getChannel(id) { return this.request('GET', `/channels/${id}`); }

  play(id, media) {
    return this.request('POST', `/channels/${id}/play`, { media });
  }

  /** Trunk üzerinden dışarı ara; kanal Stasis(outbound) içine düşer. */
  originate(number, { callerId, appArgs }) {
    return this.request('POST', '/channels', {
      endpoint: `PJSIP/${number}@${config.trunk.endpoint}`,
      app: this.app,
      appArgs,
      callerId,
      timeout: 45,
    });
  }

  /** ExternalMedia kanalı: Asterisk sesi bize RTP ile yollar, biz de ona. */
  externalMedia(host, port) {
    return this.request('POST', '/channels/externalMedia', {
      app: this.app,
      external_host: `${host}:${port}`,
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',
      direction: 'both',
    });
  }

  // --- Bridge ---
  createBridge(name) {
    return this.request('POST', '/bridges', { type: 'mixing', name });
  }
  addToBridge(bridgeId, channelIds) {
    return this.request('POST', `/bridges/${bridgeId}/addChannel`, {
      channel: [].concat(channelIds).join(','),
    });
  }
  destroyBridge(id) { return this.request('DELETE', `/bridges/${id}`).catch(() => {}); }
}
