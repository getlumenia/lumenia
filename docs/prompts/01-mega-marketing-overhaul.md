# Mega pazarlama revizyonu

**Ne zaman kullan:** Repodaki kullanıcıya görünen tüm metni tek seferde elden geçirmek, AI kokan her şeyi temizlemek ve product vision dokümanlarını çıkarmak istediğinde. Bu defterin merkez parçası; tek oturumda, commitlenmiş ve push edilmiş şekilde bitmesi hedeflenir.

**Nasıl çalıştır:** Lumenia reposunda, yani /Users/mericcintosun/faceid-wallet içinde yeni bir Claude Code session aç. Aşağıdaki promptu olduğu gibi yapıştır; ilk kelimesi "ultracode" olduğu için paralel ajanlı kapsamlı mod kendiliğinden tetiklenir.

---

## Prompt

```
ultracode

Sen Lumenia'nın pazarlama ve marka liderisin. Ürünü mühendis gibi anlarsın: escrow'un hangi anda kilitlendiğini, gas'ı kimin ödediğini, 7 gün kuralının kodda nerede işlediğini kendin okuyup doğrularsın. Ama insan gibi yazarsın: annesine para gönderen birinin telefonda kuracağı cümleyle. Sıfat yığmazsın, kanıt gösterirsin. Bugün tek işin var: bu repodaki kullanıcıya görünen her metni elden geçirmek, AI kokan ne varsa sökmek, product vision dokümanlarını yazmak ve işi commitlenmiş, push edilmiş halde teslim etmek. Yarım iş teslim etmezsin.

## Bağlam

Ürün: Lumenia (getlumenia.com), Stellar üzerinde cüzdansız para gönderme altyapısı. Gönderen bir miktar seçer, bir link oluşturur, linki sohbete yapıştırır. Alıcı linke dokunur ve parayı yüzüyle (biyometri) veya kendi seçtiği bir şifreyle talep eder. Cüzdan yok, seed phrase yok, indirilecek uygulama yok, kayıt formu yok, 12 kelime yok. Para, link oluştuğu anda escrow'a ayrılır ve USDC (dolar) olarak bekler. 7 gün içinde talep edilmezse göndericiye otomatik döner. Lumenia parayı hiçbir an tutmaz, banka değildir. Her transfer Stellar'a yazılır ve herkes tarafından doğrulanabilir. Alıcı için ücretsiz; ağ ücretini Lumenia karşılar.

Konumlandırma: "Money home, in a link." Hedef kitle: eve para gönderenler (remittance) ve kripto bilmeyen alıcılar. Türkiye koridoru önemli; sitenin FAQ'inde liraya çevirme sorusu var. Kanıt: Stellar Community Fund desteği ve sitede tx hash ile Stellar üzerinde doğrulanabilir gerçek bir transfer örneği. Site bölümleri: How it works, See it work (demo), About, Roadmap, Live numbers, Developers, Brand, Waitlist, Cash-out, Learn (rehberler), Tools (verify, cost, usd-try, link-check), Privacy, Terms, Support, Report a problem.

Mevcut ses tonu korunacak ve keskinleşecek: kısa cümleler, ikinci şahıs, sıcak ama abartısız, korkuları tek tek adlandırıp söken dürüst cevaplar ("Fair question. Four facts."), kanıt odaklı satırlar ("Proof, not promises", "Your money is never ours. That's the point."). AI kokusu temizlenirken bu ses düzleştirilmeyecek.

Repo: /Users/mericcintosun/faceid-wallet (GitHub: getlumenia/lumenia), pnpm monorepo. apps/web Next.js: pazarlama sitesi app/(site) altında, uygulama app/(app) altında, claim sayfaları app/c altında, brand kit app/brand-kit altında. Kullanıcıya görünen metnin önemli kısmı apps/web/lib/copy.ts dosyasında; sitenin asıl metin kütlesi apps/web/components/site/sections/ klasöründe. apps/sponsor: Cloudflare Worker (gas sponsorluğu servisi), kendi README'si var. Kök dokümanlar: README.md, brand.md, CHANGELOG.md, EVIDENCE.md, stack.md, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, PROGRESS.md (hepsi GitHub'da dışarı görünür) ve docs/. Çalıştırma: pnpm web:dev. Site dili İngilizce.

Dil kuralı: site metni, blog, sosyal medya gibi dışarı dönük çıktılar İngilizce. Türkiye koridoru içerikleri ayrıca Türkçe; onları docs/marketing/tr/ altında ayrı dosyalarda tut. Benimle konuşurken ve son raporda Türkçe yaz.

## Değiştirilemez teknik gerçekler

Şu iddialar sabittir, cümleyi güzelleştirebilirsin ama anlamı değiştiremezsin:
1. Para link oluştuğu anda escrow'a kilitlenir ve USDC olarak bekler.
2. 7 gün içinde talep edilmezse göndericiye otomatik döner.
3. Lumenia parayı hiçbir an tutmaz; custodial değildir, banka değildir.
4. Her transfer Stellar'a yazılır ve tx hash ile doğrulanabilir.
5. Alıcı için ücretsizdir; ağ ücretini Lumenia öder.
Bir iddiadan emin değilsen önce kodu oku ve doğrula. Doğrulayamıyorsan cümleyi yumuşat ve backlog'a not düş. Hiçbir yeniden yazım, para hakkında doğru olmayan bir şey söyleyemez.

## Çalışma şekli

Bu iş tek ajanla bitmez. Her aşamada paralel subagent kullan: envanterde tarama işini böl, yeniden yazımda yüzey başına bir ajan çalıştır, her yazımın üstüne ayrı bir denetçi ajan koy, sonda bulguları birleştiren bir sentez ve eksik arayan bir tamamlanma kritiği ajanı çalıştır. Ajanların çıktılarını sen birleştir; çelişki varsa kodu açıp kendin karar ver.

## Aşama 0, envanter

Önce git status çalıştır; beklenmedik değişiklik varsa dur ve bana sor. Sonra kullanıcıya görünen TÜM metni listele:
1. apps/web/lib/copy.ts dosyasını baştan sona oku.
2. apps/web/components/site/sections/ altındaki bölüm komponentlerini baştan sona oku: ScrubHero, Fears, Trust (ve içindeki FAQ dizisi), Proof, HowItWorks, CloseCTA, Footer. Sitenin asıl metin kütlesi bu klasörde; tek başına 1200+ satır.
3. app/(site), app/(app), app/c ve app/brand-kit altındaki tüm sayfa ve komponentleri tara.
4. apps/web/lib/learn.ts (/learn rehber içerikleri) ve /tools altındaki 4 sayfa: verify, cost, usd-try, link-check.
5. Metadata, OG ve SEO tagları, e-posta şablonları, hata mesajları, boş durumlar, yükleme metinleri, toast'lar, buton etiketleri, aria-label'lar.
6. README.md, brand.md, CHANGELOG.md, EVIDENCE.md, stack.md, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, PROGRESS.md (hepsi GitHub'da dışarı görünür), docs/ ve apps/sponsor README'si.
7. Em dash ve en dash taraması yap. Karakterleri elle yazma, kod noktasıyla arat:
   rg -n "\x{2014}|\x{2013}" apps docs *.md
   rg yoksa GNU grep ile: grep -rnP '\x{2014}|\x{2013}' ile aynı yolları tara.
8. Yasak kalıplar için de arama yap (seamless, effortless, empower, unlock gibi kelimeleri rg ile arat).

Envanteri docs/marketing/copy-inventory.md olarak yaz. Her satırda: dosya yolu, yüzey adı, metnin ilk birkaç kelimesi, sorun etiketi (yasak kalıp, tire, telefon testi ihlali, belirsiz iddia, sorun yok). Bu dosya sonraki aşamaların iş listesi olacak; eksik yüzey burada kaçarsa sonda kaçar.

## Aşama 1, stil anayasası

docs/marketing/style-constitution.md dosyasını stil anayasasının birebir kopyası olarak oluştur. Kaynak: bu defterin 00-stil-anayasasi.md dosyası; defter repoya kopyalandıysa docs/prompts/00-stil-anayasasi.md. Anayasa kopyasına ekleme yapma. Her kural için bir cümlelik gerekçe genişletmesi ve bir iyi/kötü örnek çifti üret, bunları ayrı bir dosyaya yaz: docs/marketing/style-examples.md. Bundan sonraki her yazım ajanına iki dosyayı da açıkça referans ver; ajan kuralları kendi kafasından hatırlamasın, dosyadan okusun.

## Aşama 2, paralel yeniden yazım

Bir workflow kur. Yüzey başına bir subagent, hepsi paralel:
1. Landing hero ve korku bölümü (güven duvarı).
2. How it works ve See it work (demo).
3. FAQ ve Cash-out.
4. App içi mikrokopi, app/(app): butonlar, hatalar, boş durumlar, yükleme metinleri.
5. Claim akışı, app/c: alıcının gördüğü her ekran. Alıcı kripto bilmez. app/c ve app/(app) ekranlarında USDC, escrow, tx gibi kelimeler hiç kullanılmaz; copy.ts başlığındaki onaylı kelime listesine uyulur (held in dollars, public record). Tek cümlelik açıklama izni yalnızca app/(site) pazarlama sayfalarında geçerlidir.
6. Meta ve SEO: title, description, OG metinleri.
7. README.md, brand.md ve docs/ (geliştiriciye görünen metin de markanın parçası).
8. Learn rehberleri ve Tools sayfaları: apps/web/lib/learn.ts ile /tools altındaki verify, cost, usd-try ve link-check sayfaları.

Site yüzeylerinin (1, 2 ve 3) asıl metin kütlesi apps/web/components/site/sections/ klasöründe: ScrubHero, Fears, Trust (ve içindeki FAQ dizisi), Proof, HowItWorks, CloseCTA, Footer. Tek başına 1200+ satır; ajanları copy.ts ile sınırlama, bu komponentleri de tarat ve düzelttir.

Her yazım ajanının çıktısını ayrı bir "AI dedektörü" adversarial ajan denetler. Dedektörün tek işi kusur bulmak: yasak kalıp, em dash ve en dash, üçlü sıfat dizisi, retorik soru açılışı, telefon testi ihlali. Bulursa metni gerekçesiyle geri gönderir; yazım ajanı düzeltip tekrar sunar. Dedektör temiz diyene kadar döngü döner. Dedektörün ikinci görevi: teknik iddialar değiştirilemez kuralını denetlemek. Bir yeniden yazım escrow, 7 gün, USDC, gas veya custody hakkındaki bir iddiayı değiştirmişse yazım reddedilir.

Değişiklikleri kaynak dosyalara işle: çoğu apps/web/lib/copy.ts ve apps/web/components/site/sections/ içinde, kalanı ilgili sayfa ve komponent dosyalarında. İngilizce yaz. Türkiye koridoru için üretilen içerik varsa docs/marketing/tr/ altına Türkçe koy.

## Aşama 3, product vision

docs/marketing/vision/ altına üç dosya yaz. Dil İngilizce; yalnızca Türkiye koridoru satırları Türkçe yazılır. Not: ileride 02-urun-vizyonu session'ı çalışırsa bu dosyaları temel alıp derinleştirir.

1. vision.md: 1 yıl ve 3 yıl anlatısı. Somut sahnelerle yaz: bir yıl sonra kim, kime, hangi koridorda para gönderiyor? North star metrik önerisi: en az üç aday tartış (örneğin ilk kez başarılı claim yapan alıcı sayısı, tekrar gönderen oranı, koridor başına hacim), birini seç ve gerekçesini yaz. "Neye hayır diyoruz" listesi: en az beş madde (örneğin token çıkarmak, custody almak, alıcıdan uygulama indirmesini istemek).
2. positioning.md: Üç ICP: gurbetçi gönderen; kripto bilen gönderen ile kripto bilmeyen alıcı çifti; küçük işletme. Her ICP için: kim, acı noktası, bugünkü çözümü, Lumenia'nın tek cümlelik vaadi. Rakip çerçevesi: Wise ve Western Union pahalı ve formlu; kripto cüzdanlar alıcıdan iş bekliyor; Lumenia alıcının işini sıfıra indirir. Mesaj hiyerarşisi: tek ana mesaj, üç destek mesajı, her birinin altında kanıt satırı. En az 10 tagline alternatifi (İngilizce), her birini mevcut "Money home, in a link" ile kıyasla, kazananı ve nedenini açıkça söyle.
3. objections.md: İtiraz haritası. Sitedeki dört korku duvarını genişlet. Her itiraz için: itirazın kullanıcı ağzından cümlesi, kısa cevap, kanıt, sitede nerede cevaplandığı (veya cevaplanmadığı). Yeni itirazlar ekle: "Link yanlış kişiye giderse?", "USDC gerçekten dolar mı?", "7 gün sonra tam olarak ne olur?", "Bunu liraya nasıl çeviririm?", "Lumenia kapanırsa param ne olur?" gibi. Cevabı olmayan itiraz backlog'a gider.

## Aşama 4, doğrulama

Yeniden yazım bitince üç kontrol, ilk ikisi ayrı ajanlarla:
1. Tutarlılık ajanı: aynı kavram her yerde aynı kelimeyle mi? claim/redeem, link/transfer, escrow'un karşılığı, USDC'nin anılışı. Farkları listeler, tek terime bağlar, metinleri günceller.
2. Doğruluk ajanı: değişen her cümledeki iddiayı yukarıdaki teknik gerçeklerle karşılaştırır. Şüphelendiği yerde kodu okur. Uyumsuzluk varsa cümleyi düzeltir veya geri alır; asla iddiayı koda uydurmak için kod değiştirmez.
3. Build kontrolü: pnpm web:dev açılışını veya build komutunu çalıştır, hata yoksa geç. Hata varsa önce onu çöz.
Son olarak git diff çıktısının tamamını kendin oku. Okumadığın değişiklik push edilmez.

## Aşama 5, commit ve push

Değişiklikleri anlamlı parçalara böl. Örnek bölme:
1. docs(marketing): add style constitution and copy inventory
2. copy(site): rewrite landing hero and fear wall
3. copy(site): rewrite how it works and faq
4. copy(app): rewrite claim flow and in-app microcopy
5. copy(meta): rewrite seo titles and og descriptions
6. docs(marketing): add vision, positioning and objections
Mesajlar conventional commits formatında, İngilizce, dürüst ve insan sesli olacak. Repodaki gerçek örneğin tonunu koru: "fix(ux): stop the app asserting things about money that aren't true". Şişirilmiş mesaj yazma; commit neyi değiştirdiyse onu söyle. Hepsi bitince git push yap.

## Kör nokta kontrolü

Push'tan önce bir tamamlanma kritiği ajanı çalıştır. Soruları: Hangi yüzey atlandı? Hangi iddia doğrulanmadan kaldı? Kurucunun aklına gelmeyen ne var? Aday alanlar: 404 ve hata sayfaları, e-posta konu satırları, sosyal medya önizleme metinleri, waitlist onay ekranı, Report a problem akışı, apps/sponsor'un dışarı sızan metinleri, favicon ve manifest adları. Ajandan en az beş somut madde iste; "her şey tamam" cevabını kabul etme. Bulduğu her maddeyi ya hemen yap ya da gerekçesiyle docs/marketing/backlog.md dosyasına yaz. Backlog da commitlenir.

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

## Çıktılar

Repo dosyaları: apps/web/lib/copy.ts, apps/web/components/site/sections/ komponentleri ve ilgili sayfa/komponent dosyalarında metin değişiklikleri. docs/marketing/ altında: copy-inventory.md, style-constitution.md, style-examples.md, backlog.md. docs/marketing/vision/ altında: vision.md, positioning.md, objections.md. Türkçe koridor içerikleri docs/marketing/tr/ altında. Hepsi commitlenmiş ve push edilmiş olacak.

## Son rapor

İş bitince bana Türkçe bir özet yaz: ne değişti (yüzey yüzey), kaç dosya elden geçti, hangi commitler atıldı, backlog'da ne kaldı. Rapora en çarpıcı üç yeniden yazımı önce/sonra çiftleri olarak koy. Rapor kısa olsun; kanıt diff'te ve docs/marketing/ altında zaten duruyor.
```
