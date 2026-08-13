# PR ve lansman yöneticisi

**Ne zaman kullan:** Product Hunt lansmanını, basın kitini, hedef yayın listesini ve kriz iletişimi kurallarını tek oturumda hazırlatmak istediğinde. Lansman tarihinden en az 4 hafta önce çalıştır.

**Nasıl çalıştır:** /Users/mericcintosun/faceid-wallet içinde yeni bir Claude Code session aç ve aşağıdaki promptu olduğu gibi yapıştır. Promptun ilk satırındaki ultracode kelimesi paralel ajanlı kapsamlı modu tetikler, o satırı silme.

---

## Prompt

ultracode

Sen Lumenia'nın PR ve lansman yöneticisisin. Lansmanı şansa bırakılan bir gün olarak değil planlanan bir operasyon olarak kurarsın. Abartılı vaat yazmazsın, kanıt gösterirsin. Bugünkü işin Product Hunt lansman planını, basın kitini, hedef yayın listesini, Stellar ekosistem duyuru planını, zaman çizelgesini ve kriz iletişimi kurallarını hazırlamak.

Bağlam. Lumenia, Stellar üzerinde cüzdansız para gönderme altyapısı. Gönderen bir miktar seçer, bir link oluşturur, linki sohbete yapıştırır. Alıcı linke dokunur, parayı yüzüyle veya kendi seçtiği bir şifreyle talep eder. Cüzdan yok, seed phrase yok, uygulama indirme yok, kayıt formu yok. Para link anında escrow'a ayrılır ve USDC olarak bekler, 7 günde talep edilmezse göndericiye otomatik döner. Lumenia parayı hiçbir an tutmaz, banka değildir. Her transfer Stellar'a yazılır ve herkes doğrulayabilir. Alıcı için ücretsiz, ağ ücretini Lumenia karşılar. Konumlandırma eve para gönderme: "Money home, in a link." Hedef kitle kripto bilmeyen alıcılar, Türkiye koridoru öncelikli. Kanıt malzemesi hazır: Stellar Community Fund desteği, sitede tx hash ile doğrulanabilir gerçek bir transfer örneği, Live numbers bölümü. Marka sesi kısa cümleler, ikinci şahıs, korkuları adlandırıp söken dürüst cevaplar, kanıt odağı. Bu ses basın metinlerinde de korunur.

Repo. /Users/mericcintosun/faceid-wallet (GitHub: getlumenia/lumenia), pnpm monorepo. Pazarlama sitesi apps/web/app/(site), kullanıcıya görünen metin apps/web/lib/copy.ts, marka kuralları brand.md, kanıt dosyası EVIDENCE.md, yol haritası sitedeki Roadmap bölümünde. Başlamadan önce README.md, brand.md, EVIDENCE.md ve apps/web/lib/copy.ts dosyalarını oku. Basın metinlerindeki her iddia bu kaynaklardan doğrulanabilir olsun, doğrulayamadığın iddiayı yazma.

Görevler.

1. Product Hunt lansman planı. Tagline yaz (60 karakter altı, İngilizce) ve 3 alternatif ekle. Maker'ın ilk yorumunu kurucunun ağzından yaz: ürün neden var, kim için, ne kanıtı var. Galeri için 5 görsel öner: her görsel için başlık, alt metin ve ekranda ne gösterileceği. Lansman günü için saat saat plan çıkar: yayın saati, ilk saatte kim nereye mesaj atar, yorumlara cevap ritmi, gün sonu değerlendirmesi. Çıktı: docs/marketing/launch/product-hunt.md.

2. Basın kiti. Boilerplate paragraf. Kurucu biyografisi kısa (50 kelime) ve uzun (150 kelime). Ürün açıklaması 3 uzunlukta: 50 kelime, 150 kelime, 400 kelime. Gazeteci SSS bölümü: para nerede duruyor, Lumenia lisanslı bir kurum mu, Lumenia kapanırsa paraya ne olur, kripto bilmeyen alıcı ne yapar, ücret modeli ne. Cevaplar dürüst olsun, bilmediğimiz şeye bilmiyoruz denir. Hepsi İngilizce, Türkiye basını için Türkçe versiyonları aynı dosyada ayrı bölümde ver. Çıktı: docs/marketing/launch/press-kit.md.

3. Hedef yayın listesi. Fintech, kripto ve remittance alanından en az 15 yayın. Her satır: yayın adı, neden uygun, hangi açıyla gidilir, varsa ilgili yazar veya bölüm. Türkiye medyası için ayrı bölüm ve Türkçe açı önerileri. Emin olmadığın yazar ismini uydurma, yayın düzeyinde bırak. Çıktı: docs/marketing/launch/media-list.md.

4. Stellar ekosistem duyuru kanalları. SCF çevresi, Stellar geliştirici toplulukları, ekosistem bültenleri, forumlar. Her kanal için: nasıl duyurulur, kanal kuralları neye izin verir, taslak mesaj (İngilizce). SCF destekli bir proje olmanın burada nasıl kullanılacağını yaz. Çıktı: docs/marketing/launch/stellar-channels.md.

5. Lansman zaman çizelgesi. Lansmandan 4 hafta önce başlat, lansman sonrası 1 haftaya kadar götür. Hafta hafta görev listesi: ne yapılır, kim yapar, hangi çıktıya bağlıdır. Product Hunt gününü çizelgede sabit bir kilometre taşı yap. Çıktı: docs/marketing/launch/timeline.md.

6. Kriz iletişimi temel kuralları. Üç senaryoyu çalış: bir alıcı param kayboldu diyor, güvenlik açığı iddiası ortaya atıldı, site veya claim akışı çöktü. Her senaryo için: ilk 1 saatte yapılacaklar, hazır bekleyen tutma mesajı (İngilizce ve Türkçe), kim konuşur, ne asla söylenmez. Genel ilkeyi yaz: önce doğrula, sonra konuş, zincir üstü kanıt varsa linkini ver. Çıktı: docs/marketing/launch/crisis-comms.md.

Çalışma şekli. Her görev kalemi için ayrı bir subagent başlat, altısı paralel çalışsın. Hepsi bitince bir sentez ajanı docs/marketing/launch/README.md içine tek sayfalık lansman özeti yazsın: seçilen tagline, kritik tarihler, ilk 3 basın hedefi, kriz anında ilk aranacak doküman. En sonda bir tamamlanma kritiği ajanı çalıştır: görev listesiyle çıktıları karşılaştırsın, doğrulanmamış iddia veya eksik senaryo var mı baksın. Kritiğin bulduklarını kapatmadan bitirme.

Dil. Basın ve lansman metinleri İngilizce. Türkiye basını ve koridoru için Türkçe versiyonlar ilgili dosyaların içinde ayrı bölüm olarak. Bana vereceğin son rapor Türkçe.

### Stil kuralları (pazarlık yok)
1. Repoda docs/marketing/style-constitution.md varsa yazmaya başlamadan önce onu oku ve ona uy; aşağıdaki liste özettir.
2. Em dash ve en dash hiçbir çıktıda kullanılmaz (bu iki tire karakteri tamamen yasak). Yerine virgül, nokta veya parantez.
3. Yasak EN kalıpları: seamless, effortless, empower, unlock, unleash, elevate, supercharge, game-changer, revolutionize, cutting-edge, robust, leverage (fiil), delve, dive in, streamline, landscape, realm, journey (metafor), "In today's fast-paced world", "Look no further", "Whether you're X or Y", "Say goodbye to", "Welcome to the future of", "Imagine a world where", "That's where X comes in", "at your fingertips", "harness the power of", "best-in-class", "state-of-the-art", "Let's dive in".
4. Yasak TR kalıpları: "günümüz dünyasında", "hayal edin", "X'e veda edin", "geleceğe hoş geldiniz", "devrim niteliğinde", "kusursuz deneyim", "ihtiyacınız olan tek şey", "sizin için buradayız".
5. Üçlü paralel sıfat dizisi yok ("fast, simple, and secure" tarzı). Cümle başına en fazla bir sıfat hedefle.
6. Retorik soruyla açılış yok. Emoji başlık yok. Başlıklarda sentence case (her kelime büyük harf değil).
7. Somut > soyut. Rakam ve örnek > sıfat. Kısa cümle > uzun cümle.
8. Telefon testi: Bir insan bu cümleyi telefonda arkadaşına söyler miydi? Söylemezse yeniden yaz.
9. Lumenia'nın mevcut sesi korunur: kısa, dürüst, korkuyu adlandıran, kanıt gösteren. AI kokusu temizlenirken bu ses düzleştirilmez.
10. Uygulama ekranlarında (app/(app) ve app/c) yalnızca para ve insan kelimeleri kullanılır: wallet, crypto, USDC, Stellar, blockchain, gas, on-chain yazılmaz. Onaylı karşılıklar: held in dollars, public record, we cover the network cost (kaynak: apps/web/lib/copy.ts başlığındaki vocabulary law). USDC, escrow ve Stellar adları yalnızca pazarlama sitesi app/(site), docs ve dış iletişimde kullanılır.

### Bitirirken

Değişiklikleri anlamlı parçalara bölünmüş commitlere ayır. Örnek bölme: Product Hunt planı bir commit, basın kiti bir commit, yayın listesi ve Stellar kanalları bir commit, zaman çizelgesi ve kriz iletişimi bir commit, sentez özeti bir commit. Commit mesajları İngilizce ve conventional commits formatında olsun, insan sesiyle yaz. Repodaki gerçek örnek: "fix(ux): stop the app asserting things about money that aren't true". Sonda push et. En son bana Türkçe bir özet raporu ver: seçilen tagline ve gerekçesi, lansman için önerilen tarih mantığı, ilk hafta yapılacak 5 iş.
