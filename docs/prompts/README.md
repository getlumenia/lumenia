# Lumenia prompt defteri

Lumenia'yı büyütmek için Claude Code'da (Fable, ultra efor) açacağın her pazarlama session'ının hazır promptları. Her dosya kendi kendine yeterli: Lumenia bağlamı, görevler, paralel ajan talimatı, çıktı yolları ve commit kuralları içinde gömülü.

## Nasıl kullanılır

1. Lumenia reposuna gir: `cd /Users/mericcintosun/faceid-wallet`
2. Yeni bir Claude Code session aç.
3. İlgili dosyanın "## Prompt" bölümünü baştan sona kopyala ve olduğu gibi yapıştır. Promptlar zaten `ultracode` kelimesiyle başlar; bu kelime paralel ajanlı, kapsamlı çalışma modunu tetikler, o satırı silme.
4. Her session sonunda Fable çıktılarını repoya yazar, commitlere böler ve pushlar.

Öneri: Bu klasörü repoya `docs/prompts/` olarak kopyalayıp commitle. Böylece promptlar da versiyonlanır ve Fable session içinden dosyalara referans verebilir.

## Sıra önerisi

Önce `01` (mega revizyon) çalıştır. Sonra `02` ve `04` ile stratejik zemini kur. Kanallar (`05`-`12`) bu ikisinin çıktısı üstüne oturur. `99` dosyasını her büyük çalışmadan sonra bir süpürme turu olarak kullan.

## İçindekiler

| Dosya | Rol | Ne işe yarar |
|---|---|---|
| [00-stil-anayasasi.md](00-stil-anayasasi.md) | Ortak referans | Lumenia ses DNA'sı, yasak kalıp listesi (EN+TR), em dash politikası, önce/sonra örnekleri, testler |
| [01-mega-marketing-overhaul.md](01-mega-marketing-overhaul.md) | Pazarlama ve marka lideri | Tek seferlik ultra revizyon: AI kokan tüm içeriği temizle, em dashleri kaldır, product vision çalış, commitlere böl, pushla |
| [02-urun-vizyonu.md](02-urun-vizyonu.md) | Ürün vizyonu stratejisti | 1-3 yıl anlatısı, north star metrik, "why now", neye hayır diyoruz |
| [03-marka-stratejisi.md](03-marka-stratejisi.md) | Marka stratejisti | Marka kimliği, brand book, messenger karakteri, görsel dil brief'i |
| [04-rakip-analizi.md](04-rakip-analizi.md) | Rakip analisti | Wise/Remitly, link tabanlı kripto rakipler, Stellar ekosistemi, konumlandırma boşluğu |
| [05-seo.md](05-seo.md) | SEO lideri | Teknik denetim, keyword mimarisi, koridor sayfaları, Ahrefs/Semrush ile gerçek veri |
| [06-icerik-pazarlama.md](06-icerik-pazarlama.md) | İçerik pazarlama lideri | İçerik sütunları, 3 aylık takvim, ilk 10 blog brief'i |
| [07-sosyal-medya.md](07-sosyal-medya.md) | Sosyal medya yöneticisi | Kanal stratejisi, 30 günlük takvim, canlı link demosu formatları, profil biyografileri |
| [08-growth.md](08-growth.md) | Growth lideri | Viral döngü haritası, referral tasarımı, aktivasyon funnel, deney listesi |
| [09-cro-landing.md](09-cro-landing.md) | Dönüşüm optimizasyonu uzmanı | Landing denetimi, A/B hipotezleri, CTA alternatifleri, analytics kontrolü |
| [10-email-pazarlama.md](10-email-pazarlama.md) | Email ve yaşam döngüsü pazarlamacısı | Waitlist nurture serisi, işlemsel mail metinleri, konu satırı kuralları |
| [11-pr-lansman.md](11-pr-lansman.md) | PR ve lansman yöneticisi | Product Hunt planı, basın kiti, yayın listesi, lansman takvimi |
| [12-topluluk.md](12-topluluk.md) | Topluluk yöneticisi | Discord/Telegram yapısı, ilk 50 üye, Stellar topluluğu, ambasadör programı |
| [13-ux-writing.md](13-ux-writing.md) | UX writer | Tüm mikrokopi envanteri ve revizyonu, hata mesajı formatı, korku anlarının dili |
| [14-guven-iletisimi.md](14-guven-iletisimi.md) | Güven iletişimcisi | Anti-scam rehberi, "paran nerede" sayfası, olay iletişim şablonları |
| [15-yerellestirme.md](15-yerellestirme.md) | Yerelleştirme lideri | TR stratejisi, çeviri kalite anayasası, gurbet dili, i18n altyapısı |
| [16-devrel.md](16-devrel.md) | Developer relations lideri | Developers sayfası, README revizyonu, entegrasyon hikayesi, kod örnekleri |
| [17-scf-yatirim-anlatisi.md](17-scf-yatirim-anlatisi.md) | Hibe ve yatırım anlatısı yazarı | SCF başvuru anlatısı, pitch deck metni, traction kanıtları |
| [18-ucretli-edinim.md](18-ucretli-edinim.md) | Performance marketing uzmanı | Koridor hedefli Google/Meta/TikTok kampanyaları, reklam metinleri, CAC modeli, finans reklam politikaları |
| [19-influencer-creator.md](19-influencer-creator.md) | Influencer ve creator ortaklıkları | Diaspora içerik üreticileri, işbirliği programı, brief şablonları, gerçek link seeding |
| [20-ortakliklar-bd.md](20-ortakliklar-bd.md) | Ortaklıklar ve BD pazarlaması | Türkiye cash-out zinciri, off-ramp ortakları, diaspora dernekleri, ortak pazarlama |
| [21-olcum-analitik.md](21-olcum-analitik.md) | Ölçüm ve analitik sahibi | Tek event şeması, dashboard sahipliği, gizlilik duruşuyla uyumlu ölçüm |
| [22-itibar-yonetimi.md](22-itibar-yonetimi.md) | İtibar yöneticisi | "Is Lumenia legit" sorgu sahipliği, Reddit/inceleme siteleri, yanıt playbook'u |
| [23-kullanici-hikayeleri.md](23-kullanici-hikayeleri.md) | Kullanıcı hikâyeleri toplayıcısı | İzinli testimonial süreci, tx ile doğrulanabilir hikâyeler, yayın yerleri |
| [99-gozden-kacan-yuzeyler.md](99-gozden-kacan-yuzeyler.md) | Süpürme turu | Akla gelmeyen 60+ pazarlama yüzeyi ve hepsini denetleyen session promptu |

## Ortak kurallar (her session'da geçerli)

- Em dash ve en dash hiçbir çıktıda kullanılmaz.
- Vocabulary law (kaynak: `apps/web/lib/copy.ts` başlığı): uygulama ekranlarında (`app/(app)` ve `app/c`) yalnızca para ve insan kelimeleri kullanılır. Wallet, crypto, USDC, Stellar, blockchain, gas, on-chain yazılmaz; onaylı karşılıklar "held in dollars", "public record", "we cover the network cost". USDC, escrow ve Stellar adları yalnızca pazarlama sitesi, docs ve dış iletişimde geçer.
- Ana slogan "Money home, in a link." ("Money home, without the ordeal." yalnızca sitenin kapanış satırıdır.)
- Teknik iddialar değiştirilemez: 7 gün iade, USDC escrow, alım ücretsiz, gas sponsorlu, Stellar'da doğrulanabilir. Yeni iddia uydurmak yasak.
- Mevcut ses korunur: kısa, dürüst, korkuyu adlandıran, kanıt gösteren. Temizlik yapılırken bu ses düzleştirilmez.
- Araştırma ve strateji çıktıları `docs/marketing/` altına, metin değişiklikleri doğrudan kaynak dosyalara.
- Commitler anlamlı parçalara bölünür, mesajlar İngilizce conventional commits, session sonunda push.
- Son özet raporu Türkçe.
