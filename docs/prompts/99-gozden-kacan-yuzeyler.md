# Gözden kaçan yüzeyler denetçisi

**Ne zaman kullan:** Her büyük pazarlama çalışmasından sonra süpürme turu olarak. Ana sayfa parlarken 404 sayfası, iade e-postası veya WhatsApp link önizlemesi unutulmuş olabilir; bu dosya o boşlukları tek tek bulur ve kapattırır.

**Nasıl çalıştır:** Lumenia reposunda (`/Users/mericcintosun/faceid-wallet`) yeni bir Claude Code session aç. Aşağıdaki "## Prompt" bölümünü olduğu gibi kopyalayıp yapıştır; ilk satırı `ultracode` olduğu için paralel ajanlı kapsamlı mod kendiliğinden tetiklenir.

## Parça 1: Akla gelmeyen pazarlama yüzeyleri kontrol listesi

Bu liste, alıcının ve gözlemcinin markayla temas ettiği ama planlarda hiç görünmeyen yüzeyleri toplar. Lumenia'da ilk temas çoğu zaman sohbete yapıştırılmış bir linktir. O yüzden bu listedeki maddelerin bir kısmı ana sayfadan daha kritiktir.

### Site dışı metadata

- [ ] OG görselleri: ana sayfa, claim sayfası (`apps/web/app/c`) ve brand kit için ayrı görseller. `apps/web/public/og.png` tek başına yeterli mi?
- [ ] Claim linki önizlemesi: Link WhatsApp, Telegram ve iMessage'a yapıştırıldığında başlık, açıklama ve görsel ne gösteriyor? Alıcının gördüğü ilk pazarlama yüzeyi budur.
- [ ] Twitter card etiketleri: summary_large_image, site ve creator alanları.
- [ ] Sayfa bazında title ve meta description: `apps/web/app/(site)` altındaki her sayfa için ayrı ve ayırt edici.
- [ ] Favicon seti: `favicon.ico`, `icon.png`, `apple-icon.png` tutarlılığı ve koyu temada görünürlük.
- [ ] Structured data: Organization, FAQPage ve SoftwareApplication için JSON-LD.
- [ ] `sitemap.ts` kapsamı: tüm site sayfaları listede mi, claim sayfaları dışarıda mı?
- [ ] `robots.ts` kuralları: `app/(app)` ve `app/c` doğru şekilde kapatılmış mı?
- [ ] Canonical URL'ler: her sayfada tek ve doğru adres.
- [ ] `manifest.ts` metinleri ve theme-color: isim, açıklama, ikonlar, renk.
- [ ] llms.txt: AI arama motorları Lumenia'yı doğru anlatsın diye kısa bir gerçekler dosyası.

### E-posta

- [ ] İşlemsel şablonlar: link oluşturuldu, para talep edildi, 7 gün hatırlatması, iade gerçekleşti. Dört ayrı olay, dört ayrı metin.
- [ ] Waitlist onay e-postası: konu satırı, kısa gövde, tek CTA.
- [ ] Gönderen adı ve adresi: no-reply yerine cevap alınabilen bir adres.
- [ ] Kurucu e-posta imzası: günlük yazışmalarda Lumenia'yı tek satırda anlatan imza.
- [ ] SPF, DKIM ve DMARC kayıtları: en iyi metin spam klasöründe işe yaramaz.
- [ ] Her şablonun düz metin alternatifi.

### Hata ve kenar durumları

- [ ] 404 sayfası: `apps/web/app/not-found.tsx` metni Lumenia sesinde mi?
- [ ] 500 ve beklenmeyen hata ekranı: özür dileyen ve yol gösteren kısa metin.
- [ ] Süresi dolmuş link sayfası: "Para gönderene geri döndü" bilgisi, tarih ve tx kanıtıyla.
- [ ] Zaten claim edilmiş link sayfası: ikinci kez tıklayan alıcıya net ve sakin bir açıklama.
- [ ] Boş durumlar: Live numbers sıfırken veya veri yokken ekran ne diyor?
- [ ] Offline ve yavaş ağ durumu: bekleme anlarında "Stellar'da onaylanıyor" gibi durum metinleri.
- [ ] Biyometri başarısız akışı: yüz tanınmadığında panik yaratmayan metin ve şifre alternatifine yönlendirme.
- [ ] Yanlış şifre metni: suçlamayan, tekrar denemeye çağıran dil.
- [ ] İade bildirimi: 7. günde giden otomatik mesajın metni.

### Sosyal varlık

- [ ] X biyografisi, pinlenmiş post ve header görseli.
- [ ] LinkedIn şirket sayfası: tagline, about bölümü, kapak görseli.
- [ ] GitHub org profili: getlumenia org açıklaması ve profil README'si.
- [ ] Repo README'nin GitHub social preview görseli.
- [ ] npm paket açıklamaları: yayınlanmış paket varsa description ve keywords alanları.
- [ ] Telegram ve Discord karşılama mesajları ile pinler.
- [ ] Stellar ekosistem dizinlerindeki listelenme metinleri.

### Güven yüzeyleri

- [ ] Status page: basit bir uptime sayfası bile güven satar.
- [ ] Public changelog: `CHANGELOG.md` içeriğinin sitede insan dilinde görünen hali.
- [ ] `apps/web/public/.well-known/security.txt` dosyası.
- [ ] `SECURITY.md` tazeliği: açık nasıl bildirilir, kim bakar, ne kadar sürede dönülür.
- [ ] Basın kiti: `apps/web/app/brand-kit` sayfasında logo, renkler ve tek paragraf boilerplate.
- [ ] Kurucu profilleri: sitedeki About, LinkedIn ve X aynı hikayeyi mi anlatıyor?
- [ ] `EVIDENCE.md` güncelliği ve sitedeki tx doğrulama linkinin hala çalışıyor olması.
- [ ] SCF desteği ifadesinin doğrulanabilir bir linke bağlanması.

### Erişilebilirlik metinleri

- [ ] aria-label'lar: özellikle claim butonu ve link kopyalama butonu.
- [ ] Tüm görsellerde anlamlı alt text.
- [ ] Screen reader ile claim akışı: yüz doğrulama adımı sesli kullanıcıya ne söylüyor?
- [ ] Form hata mesajlarının aria-live ile okunması.
- [ ] Odak sırası ve skip link.

### Video ve demo

- [ ] Demo videosu senaryosu: 30 saniyede gönder, yapıştır, claim et.
- [ ] Altyazılar: EN ve TR. Sessiz izlenme çoğunluktadır.
- [ ] lumenia-demo.mp4 güncelliği: videodaki arayüz bugünkü ürünle aynı mı? Dosya repoda bulunamıyorsa nerede yaşadığını netleştir.
- [ ] Video poster görseli: oynatmadan önce görünen kare.

### Legal ton

- [ ] Privacy sayfası başına insan dilinde özet kutusu: neyi topluyoruz, neyi toplamıyoruz.
- [ ] Terms başına aynı tarz özet: 7 gün kuralı, escrow, ücretler.
- [ ] "Lumenia parayı hiçbir an tutmaz" cümlesinin legal metinde de geçmesi.
- [ ] Çerez ve analytics açıklaması: ne kullanılıyor, ne kullanılmıyor.

### Destek

- [ ] Destek makroları: "param nerede", "link çalışmıyor", "yüzüm tanınmadı", "iade ne zaman" için hazır cevaplar.
- [ ] Report a problem akışının metni: form alanları, onay ekranı, dönüş sözü.
- [ ] Otomatik ilk yanıt e-postası: ne zaman dönüleceğine dair net bir söz.
- [ ] Destek adresinin sitede kolay bulunabilirliği.

### PWA ve uygulama mağazaları

- [ ] PWA manifest metinleri: name, short_name, description.
- [ ] Ana ekrana ekleme deneyimi: ikon ve başlık nasıl görünüyor?
- [ ] İleriye dönük App Store ve Play Store taslakları: başlık, alt başlık, açıklama, anahtar kelimeler.

### Küçük ama görünen yüzeyler

- [ ] Footer: copyright yılı, şirket adı, sayfa linklerinin tamlığı.
- [ ] Waitlist teşekkür ekranı: kayıttan sonra ne olacağını söyle.
- [ ] Tarayıcı sekme başlıkları: her sayfada ayırt edici title.
- [ ] Kod içindeki kullanıcıya sızan metinler: console mesajları, placeholder'lar, seed data isimleri.

---

## Prompt

ultracode

Sen Lumenia'nın gözden kaçan yüzeyler denetçisisin. Detay avcısısın; ana sayfayı herkes cilalar, sen 404 sayfasını, iade e-postasını ve WhatsApp link önizlemesini cilalarsın. Bir markanın asıl karakteri kimsenin bakmadığı yüzeylerde ortaya çıkar ve senin işin o yüzeylerin hiçbirini boş bırakmamak. Bulduğun her eksiği ya bu session'da kapatırsın ya da dürüstçe "açık kaldı" diye kayda geçirirsin.

### Bağlam

Lumenia, Stellar üzerinde cüzdansız para gönderme altyapısıdır. Gönderen bir miktar seçer, bir link oluşturur ve linki sohbete yapıştırır. Alıcı linke dokunur, parayı yüzüyle (biyometri) veya kendi seçtiği bir şifreyle talep eder. Cüzdan yok, seed phrase yok, indirilecek uygulama yok, kayıt formu yok. Para, link oluşturulduğu anda USDC olarak escrow'a ayrılır; 7 gün içinde talep edilmezse gönderene otomatik döner. Lumenia parayı hiçbir an tutmaz, banka değildir. Her transfer Stellar'a yazılır ve herkes tarafından doğrulanabilir. Alıcı için ücretsizdir; ağ ücretini Lumenia karşılar. Konumlandırma: "Money home, in a link." Hedef kitle eve para gönderen insanlar ve kripto bilmeyen alıcılar; Türkiye koridoru önemli. Ses tonu: kısa cümleler, ikinci şahıs, korkuları tek tek adlandırıp söken dürüst cevaplar ("Fair question. Four facts."), kanıt odaklı ("Proof, not promises"). Proje Stellar Community Fund destekli ve sitede tx hash ile doğrulanabilir gerçek bir transfer örneği var.

Repo gerçekleri: pnpm monorepo, GitHub getlumenia/lumenia, yerel yol `/Users/mericcintosun/faceid-wallet`. `apps/web` Next.js: pazarlama sitesi `apps/web/app/(site)`, uygulama `apps/web/app/(app)`, claim sayfaları `apps/web/app/c`, brand kit `apps/web/app/brand-kit`. Kullanıcıya görünen metnin önemli kısmı `apps/web/lib/copy.ts` içinde. `apps/web/app` altında `robots.ts`, `sitemap.ts`, `manifest.ts`, `not-found.tsx` var; `apps/web/public` altında `og.png` ve ikon seti var. Kökte `README.md`, `brand.md`, `CHANGELOG.md`, `EVIDENCE.md`, `SECURITY.md`, `stack.md` ve `docs/` var. `apps/sponsor` gas sponsorluğu yapan bir Cloudflare Worker ve kendi README'si var. Site dili İngilizce, `pnpm web:dev` ile çalışır.

### Denetlenecek kontrol listesi

Site dışı metadata: OG görselleri (ana sayfa, claim sayfası, brand kit); claim linkinin WhatsApp, Telegram ve iMessage önizlemesi; twitter card etiketleri; sayfa bazında title ve meta description; favicon seti tutarlılığı; JSON-LD (Organization, FAQPage, SoftwareApplication); sitemap kapsamı; robots kuralları; canonical URL'ler; manifest metinleri ve theme-color; llms.txt.

E-posta: işlemsel şablonlar (link oluşturuldu, para talep edildi, 7 gün hatırlatması, iade gerçekleşti); waitlist onayı; gönderen adı ve adresi; kurucu imzası; SPF, DKIM, DMARC; düz metin alternatifleri.

Hata ve kenar durumları: 404; 500; süresi dolmuş link sayfası; zaten claim edilmiş link sayfası; boş durumlar; offline ve bekleme metinleri; biyometri başarısız akışı; yanlış şifre metni; 7. gün iade bildirimi.

Sosyal varlık: X biyografisi ve pinlenmiş post; LinkedIn şirket sayfası; GitHub org profili ve README; repo social preview görseli; npm paket açıklamaları; Telegram ve Discord pinleri; Stellar ekosistem dizin metinleri.

Güven yüzeyleri: status page; sitede insan dilinde changelog; security.txt; SECURITY.md tazeliği; basın kiti; kurucu profillerinin tutarlılığı; EVIDENCE.md ve tx doğrulama linkinin çalışırlığı; SCF ifadesinin doğrulanabilir linki.

Erişilebilirlik: aria-label'lar (özellikle claim ve kopyalama butonları); alt text'ler; screen reader ile claim akışı; aria-live hata mesajları; odak sırası ve skip link.

Video ve demo: demo senaryosu; EN ve TR altyazılar; lumenia-demo.mp4 güncelliği; poster görseli.

Legal ton: Privacy ve Terms başına insan dilinde özet kutuları; "Lumenia parayı tutmaz" cümlesinin legal metinde geçmesi; çerez ve analytics açıklaması.

Destek: makrolar (param nerede, link çalışmıyor, yüzüm tanınmadı, iade ne zaman); Report a problem akış metni; otomatik ilk yanıt; destek adresinin bulunabilirliği.

PWA ve mağazalar: manifest metinleri; ana ekrana ekleme görünümü; ileriye dönük App Store ve Play Store taslakları.

Küçük yüzeyler: footer ve copyright; waitlist teşekkür ekranı; sekme başlıkları; kullanıcıya sızan console ve placeholder metinleri.

### Görevler

1. Envanter çıkar. Kontrol listesindeki her maddeyi repoda tek tek denetle. Her maddeye şu dört durumdan birini ver: "var ve iyi", "var ama zayıf", "yok", "repo dışı". Kanıt olarak dosya yolunu veya eksikliğin yerini yaz. Sonucu `docs/marketing/surface-inventory.md` dosyasına kategori bazlı tablo olarak kaydet (dosya varsa güncelle, yoksa oluştur).
2. Repo içinde kapanabilen eksikleri bu session'da kapat: sayfa bazlı metadata, OG ve twitter card alanları, JSON-LD, sitemap ve robots kapsamı, manifest metinleri, 404 ve hata metinleri, süresi dolmuş ve zaten claim edilmiş link durum metinleri, boş durumlar, aria-label ve alt text eksikleri, `apps/web/public/.well-known/security.txt`, `SECURITY.md` güncellemesi, Privacy ve Terms başına insan dilinde özet kutuları, llms.txt. Site metni İngilizce yazılır; değişiklikler `apps/web/lib/copy.ts` ve ilgili sayfa dosyalarına gider.
3. Repo dışı yüzeyler için kopyala kullan metinleri üret ve `docs/marketing/` altına yaz: işlemsel e-posta şablonları ve waitlist onayı; X ve LinkedIn biyografileri ile GitHub org profil README'si; Telegram ve Discord karşılama ve pin metinleri; destek makroları; 30 saniyelik demo video senaryosu ve EN ile TR altyazı metni; ileriye dönük App Store ve Play Store taslakları. Dışa dönük metinler İngilizce olacak; Türkiye koridoruna dönük sürümleri ayrıca Türkçe yaz.
4. Kanıt tazeliğini doğrula. `EVIDENCE.md` içindeki ve sitedeki tx doğrulama linkini kontrol et. Kırık veya bayatsa envantere işle ve mümkünse düzelt.
5. Önceliklendir. Bu session'da kapanmayan maddeleri etki ve efora göre sırala. `docs/marketing/surface-inventory.md` sonuna "sıradaki 10 iş" listesi ekle; her işe tek cümle gerekçe yaz.

### Çalışma şekli

- Her kategori için ayrı bir subagent çalıştır: metadata, e-posta, hata durumları, sosyal, güven, erişilebilirlik, video, legal, destek, PWA ve mağazalar, küçük yüzeyler. Her ajan kendi kategorisini denetler, envanter satırlarını çıkarır ve düzeltmelerini hazırlar.
- Ajanlar bitince bir sentez ajanı tüm bulguları tek envanterde birleştirir ve aynı dosyaya dokunan düzeltmeleri çakışma olmadan uygular.
- En sonda bir tamamlanma kritiği ajanı çalıştır: listeyi ve görevleri baştan tarasın, atlanmış veya yüzeysel geçilmiş maddeleri bulsun. Bulduklarını ya kapattır ya da envantere "yapılmadı" diye açıkça yazdır.

Sınırlar: Teknik iddialar değiştirilemez: 7 gün iade, USDC escrow, alıcı için ücretsiz, gas sponsorlu, Stellar'da doğrulanabilir. Yeni iddia uydurma, var olmayan rakam yazma. Kontrol edemediğin yüzeyi (örneğin DNS kayıtları) tahmin etme; "kontrol edilemedi" diye işaretle ve elle kontrol talimatı bırak.

### Çıktılar

Doküman çıktıları için kural: önce `docs/marketing/` altındaki mevcut dosyaları güncelle; yoksa aşağıdaki İngilizce adlarla oluştur.

- `docs/marketing/surface-inventory.md`: durum tablosu, kanıt yolları, sıradaki 10 iş.
- `docs/marketing/email/transactional.md`: işlemsel şablonlar ve waitlist onayı, EN ve TR.
- `docs/marketing/social/bios.md`: X, LinkedIn, GitHub org, Telegram ve Discord metinleri.
- `docs/marketing/support-macros.md`: hazır destek cevapları, EN ve TR.
- `docs/marketing/social/demo-video-script.md`: senaryo, çekim listesi, EN ve TR altyazı metni.
- `docs/marketing/app-store-drafts.md`: App Store ve Play Store taslakları.
- Kaynak dosya değişiklikleri: `apps/web/lib/copy.ts`, `apps/web/app/(site)` sayfaları, `apps/web/app/c` durum sayfaları, `apps/web/app/not-found.tsx`, `robots.ts`, `sitemap.ts`, `manifest.ts`, `apps/web/public/.well-known/security.txt`, kökte `SECURITY.md`.

### Stil kuralları (pazarlık yok)

1. Repoda docs/marketing/style-constitution.md varsa yazmaya başlamadan önce onu oku ve ona uy; aşağıdaki liste özettir.
2. Em dash ve en dash hiçbir çıktıda kullanılmaz (bu iki tire karakteri tamamen yasak). Yerine virgül, nokta veya parantez.
3. Yasak EN kalıpları: seamless, effortless, empower, unlock, unleash, elevate, supercharge, game-changer, revolutionize, cutting-edge, robust, leverage (fiil), delve, dive in, streamline, landscape, realm, journey (metafor), "In today's fast-paced world", "Look no further", "Whether you're X or Y", "Say goodbye to", "Welcome to the future of", "Imagine a world where", "That's where X comes in", "at your fingertips", "harness the power of", "best-in-class", "state-of-the-art", "Let's dive in".
4. Yasak TR kalıpları: "günümüz dünyasında", "hayal edin", "X'e veda edin", "geleceğe hoş geldiniz", "devrim niteliğinde", "kusursuz deneyim", "ihtiyacınız olan tek şey", "sizin için buradayız".
5. Üçlü paralel sıfat dizisi yok ("fast, simple, and secure" tarzı). Cümle başına en fazla bir sıfat hedefle.
6. Retorik soruyla açılış yok. Emoji başlık yok. Başlıklarda sentence case (her kelime büyük harf değil).
7. Somut > soyut. Rakam ve örnek > sıfat. Kısa cümle > uzun cümle.
8. Telefon testi: Bir insan bu cümleyi telefonda arkadaşına söyler miydi? Söylemezse yeniden yaz.
9. Uygulama ekranlarında (app/(app) ve app/c) yalnızca para ve insan kelimeleri kullanılır: wallet, crypto, USDC, Stellar, blockchain, gas, on-chain yazılmaz. Onaylı karşılıklar: held in dollars, public record, we cover the network cost (kaynak: apps/web/lib/copy.ts başlığındaki vocabulary law). USDC, escrow ve Stellar adları yalnızca pazarlama sitesi app/(site), docs ve dış iletişimde kullanılır.
10. Lumenia'nın mevcut sesi korunur: kısa, dürüst, korkuyu adlandıran, kanıt gösteren. AI kokusu temizlenirken bu ses düzleştirilmez.

### Bitirirken

Değişiklikleri anlamlı parçalara bölünmüş commitlere ayır. Örnek bölme:

- `feat(seo): add per-page metadata, structured data and sitemap coverage`
- `feat(site): add copy for expired, claimed and error states`
- `feat(trust): add security.txt and human-language legal summaries`
- `fix(a11y): add aria labels and alt text across marketing pages`
- `docs(marketing): add off-site surface inventory and ready-to-paste templates`

Commit mesajları İngilizce ve conventional commits formatında olsun; repo geleneğindeki gibi dürüst ve insan sesli yaz (gerçek örnek: "fix(ux): stop the app asserting things about money that aren't true"). Yalnızca `docs/marketing/` altına yazdıysan bile commitle. Session sonunda push et. Son özet raporunu Türkçe yaz: ne denetlendi, ne kapandı, ne açık kaldı ve sıradaki 10 iş ne.
