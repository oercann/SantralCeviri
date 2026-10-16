// Çeviri Asistanı — giriş noktası
import { config, assertConfig, normalizeNumber } from './config.js';
import { Ari } from './ari.js';
import { Web } from './web.js';
import { CallSession } from './call.js';

assertConfig();

const ari = new Ari();
const web = new Web();
let session = null;            // Aynı anda tek görüşme (kişisel asistan)
let pendingTarget = null;      // PWA'dan arama öncesi girilen numara

function attach(s) {
  session = s;
  s.on('status', (st) => web.broadcast({ type: 'status', id: s.id, state: s.state, ...st }));
  s.on('transcript', (t) => web.broadcast({ type: 'transcript', ...t, at: Date.now() }));
  s.on('ended', (e) => {
    web.broadcast({ type: 'ended', reason: e.reason });
    if (session === s) session = null;
  });
}

// ---------- ARI olayları ----------
ari.on('connected', () => console.log('ARI bağlı'));

ari.on('StasisStart', async (ev) => {
  const ch = ev.channel;
  const [kind, arg] = ev.args || [];
  if (ch.id.startsWith('media-')) return; // ExternalMedia kanalı, bridge'e biz ekliyoruz

  if (kind === 'inbound') {
    const caller = normalizeNumber(arg || ch.caller?.number);
    if (caller !== normalizeNumber(config.trunk.myCell)) {
      console.warn('Yetkisiz arayan reddedildi:', caller);
      return ari.hangup(ch.id);
    }
    if (session && !session.ended) {
      console.warn('Zaten aktif görüşme var, yeni arama reddedildi');
      return ari.hangup(ch.id);
    }
    const s = new CallSession(ari, ch);
    attach(s);
    if (pendingTarget) { s.pendingTarget = pendingTarget; pendingTarget = null; }
    try { await s.start(); } catch (e) { console.error('Oturum başlatılamadı', e); s.end('error'); }
    return;
  }

  if (kind === 'outbound') {
    if (session && session.remote.channel?.id === ch.id) await session.onRemoteAnswered(ch);
    else ari.hangup(ch.id);
  }
});

ari.on('ChannelDtmfReceived', (ev) => {
  if (session && ev.channel.id === session.user.channel.id) session.onDtmf(ev.digit);
});

ari.on('StasisEnd', (ev) => {
  if (!session) return;
  const id = ev.channel.id;
  if (id === session.user.channel.id) session.end('user-hangup');
  else if (id === session.remote.channel?.id && session.state !== 'ended') session.end('remote-hangup');
});

ari.on('ChannelDestroyed', (ev) => {
  if (session && ev.channel.id === session.remote.channel?.id && session.state === 'ringing') {
    session.say(session.user, 'Karşı taraf cevap vermedi.').then(() => session.end('no-answer'));
  }
});

// ---------- PWA API ----------
web.on('api', async ({ path, method, data, resolve }) => {
  try {
    if (path === '/api/status') {
      return resolve({ body: { active: !!session, state: session?.state || 'idle', target: session?.target || pendingTarget, myDid: config.trunk.myDid, history: session?.history || [] } });
    }
    if (path === '/api/dial' && method === 'POST') {
      const n = normalizeNumber(data.number);
      if (!n) return resolve({ status: 400, body: { error: 'Geçersiz numara' } });
      if (session && !session.ended) session.setTarget(n); else pendingTarget = n;
      return resolve({ body: { ok: true, target: n, hint: `Şimdi cebinden ${config.trunk.myDid} numarasını ara.` } });
    }
    if (path === '/api/hangup' && method === 'POST') {
      if (session) await session.end('pwa-hangup');
      pendingTarget = null;
      return resolve({ body: { ok: true } });
    }
    if (path === '/api/say' && method === 'POST') {
      if (!session) return resolve({ status: 409, body: { error: 'Aktif görüşme yok' } });
      await session.typeToRemote(String(data.text || '').slice(0, 500));
      return resolve({ body: { ok: true } });
    }
    resolve({ status: 404, body: { error: 'not found' } });
  } catch (e) {
    resolve({ status: 500, body: { error: e.message } });
  }
});

web.on('command', (cmd) => {
  if (cmd.type === 'say' && session) session.typeToRemote(String(cmd.text || '').slice(0, 500));
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

ari.connect();
web.listen();
console.log('Çeviri Asistanı başladı. DID:', config.trunk.myDid);
