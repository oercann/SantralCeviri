# Çeviri Asistanı

Telefon görüşmeleri için canlı Türkçe ⇄ İngilizce çeviri. Cebinden kendi ABD numaranı ararsın, PIN girersin, hedef numarayı tuşlarsın (ya da PWA'dan yazarsın); karşı taraf senin Türkçeni İngilizce duyar, sen onun İngilizcesini Türkçe duyarsın ve telefonda canlı transkripti okursun.

## Mimari

```
Cep telefonu ──PSTN──> Telnyx ──SIP──> Asterisk (VPS)
                                         │  ExternalMedia (RTP, slin16)
                                         ▼
                                  Node.js çeviri motoru
                        STT (OpenAI Realtime) → Çeviri (GPT) → TTS
                                         │ WebSocket
                                         ▼
                                   PWA (telefon ekranı)
```

- `install/` — VPS kurulum scripti ve Asterisk yapılandırması
- `server/` — Node.js çeviri motoru (ARI + RTP + OpenAI)
- `web/` — PWA (Cloudflare Pages'a konabilir)

## Kurulum

1. **VPS** (Ubuntu 24.04, ABD doğu kıyısı). SSH anahtarını ekle.
2. **Telnyx**: numara al → SIP Connection (Credentials) oluştur → numarayı bu connection'a bağla.
3. **OpenAI** API anahtarı.
4. Sunucuda:
   ```bash
   git clone <repo> /opt/ceviri-src && cd /opt/ceviri-src
   cp install/ceviri.env.example /etc/ceviri.env && nano /etc/ceviri.env
   sudo bash install/setup-vps.sh
   ```
5. PWA: `https://<sunucu>:8443` ya da `web/` klasörünü Cloudflare Pages'a yükle; ilk açılışta sunucu adresi + `WEB_TOKEN` gir, ana ekrana ekle.

## Kullanım

1. PWA'da numarayı yaz → **Numarayı Hazırla**.
2. **Cebimden Ara** (kendi DID'ini arar) → PIN tuşla.
3. Karşı taraf açınca Türkçe konuş; transkript ekranda akar. İstersen alttan yazıp gönder, İngilizce okunur.

## Güvenlik

- Gelen çağrı yalnızca `MY_CELL` numarasından kabul edilir **ve** `ACCESS_PIN` istenir (caller ID taklit edilebildiği için PIN şart).
- SIP portu yalnızca Telnyx ağlarına açık; Asterisk'te dışarıdan kayıt olabilecek endpoint yok.
- ARI yalnızca `127.0.0.1`; PWA API/WS `WEB_TOKEN` ile, 5 hatalı denemede 15 dk IP kilidi.
- fail2ban (SSH + Asterisk), ufw, SSH'de parola girişi kapalı.
- Anahtarlar `/etc/ceviri.env` içinde (600), repoya girmez.
- Öneri: 8443'ü dışa açmak yerine Cloudflare Tunnel ile `ceviri.alanadin.com` üzerinden TLS'li yayınla; o zaman `ufw delete allow 8443/tcp`.

## Yol haritası

- [ ] PWA içinden WebRTC ile doğrudan arama (cep hattı olmadan)
- [ ] Gelen aramaları (müşterilerin seni araması) çevirili karşılama
- [ ] Görüşme geçmişi ve kayıt
- [ ] Orijinal sesi düşük seviyede arkada duyma seçeneği
