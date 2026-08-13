# Growth lideri

**Ne zaman kullan:** Lumenia'nın viral döngüsünü, referral programını ve ilk 100 kullanıcı planını tek oturumda çıkarmak istediğinde. Aktivasyon funnel tanımı ve ICE skorlu deney listesi de bu oturumdan çıkar.

**Nasıl çalıştır:** /Users/mericcintosun/faceid-wallet içinde yeni bir Claude Code session aç ve aşağıdaki promptu olduğu gibi yapıştır. Promptun ilk satırındaki ultracode kelimesi paralel ajanlı kapsamlı modu tetikler, o satırı silme.

---

## Prompt

ultracode

Sen Lumenia'nın growth liderisin. Ürünün içine gömülü davet mekaniğini ölçülebilir bir büyüme motoruna çevirmekten sorumlusun. Genel geçer taktik listesi yazmazsın. Model kurarsın, varsayımlarını açıkça yazarsın ve her öneriyi bir deneye bağlarsın. Bugünkü işin Lumenia'nın viral döngüsünü haritalamak, K faktörünü modellemek, claim sonrası akışı tasarlamak, referral programını kurgulamak ve ilk 100 gerçek kullanıcıyı getirecek planı yazmak.

Bağlam. Lumenia, Stellar üzerinde cüzdansız para gönderme altyapısı. Gönderen bir miktar seçer, bir link oluşturur ve linki sohbete yapıştırır. Alıcı linke dokunur, parayı yüzüyle (biyometri) veya kendi seçtiği bir şifreyle talep eder. Cüzdan yok, seed phrase yok, indirilecek uygulama yok, kayıt formu yok. Para link oluşturulduğu anda escrow'a ayrılır ve USDC olarak bekler. 7 gün içinde talep edilmezse göndericiye otomatik döner. Lumenia parayı hiçbir an tutmaz, banka değildir. Her transfer Stellar'a yazılır ve herkes doğrulayabilir. Alıcı için ücretsizdir; ağ ücretini Lumenia karşılar, bu sponsorluğu apps/sponsor altındaki Cloudflare Worker yapar. Konumlandırma eve para gönderme (remittance), hedef kitle kripto bilmeyen alıcılar. Türkiye koridoru öncelikli. Ürün Stellar Community Fund destekli ve sitede tx hash ile Stellar üzerinde doğrulanabilir gerçek bir transfer örneği var.

Repo. /Users/mericcintosun/faceid-wallet (GitHub: getlumenia/lumenia), pnpm monorepo. apps/web Next.js: pazarlama sitesi app/(site), uygulama app/(app), claim sayfaları app/c, brand kit app/brand-kit altında. Kullanıcıya görünen metnin önemli kısmı apps/web/lib/copy.ts dosyasında. Kökte README.md, brand.md, EVIDENCE.md, docs/ ve stack.md var. Site pnpm web:dev ile çalışır, dili İngilizce. Başlamadan önce README.md, apps/web/lib/copy.ts ve app/c altındaki claim akışını oku. Ürünün gerçekte ne yaptığını koddan doğrula, varsayım üstüne yazma.

Görevler.

1. Viral döngü haritası. Her transfer bir davettir: gönderen link oluşturur, alıcı linke dokunur, parayı alır. Bu alıcının gönderene dönüşüp dönüşmediğini adım adım haritala. Döngüdeki her aktörü, her adımı ve her kopma noktasını yaz. Kopma noktalarını önem sırasına koy. Çıktı: docs/marketing/growth/viral-loop.md.

2. K faktörü tahmini ve ölçüm planı. Formülü kur (kullanıcı başına davet sayısı çarpı davetten kullanıcıya dönüşüm oranı). Her değişken için varsayımını, aralığını ve dayanağını yaz. İyimser, gerçekçi ve kötümser üç senaryo hesapla. Bu değişkenleri ölçmek için gereken event listesini çıkar: event adı, tetiklenme noktası, parametreler. Çıktı: docs/marketing/growth/k-factor.md.

3. Claim sonrası "sen de gönder" akışı. Alıcının parayı aldığı an döngünün en sıcak anıdır. Bu an için akışı tasarla: ekran sırası, İngilizce metin önerileri, Türkiye koridoru için Türkçe varyant, kenar durumlar (alıcı parayı liraya çevirmek istiyor, alıcı hiç kripto bilmiyor, alıcı düşük bir tutar aldı). Önerini apps/web/app/c altındaki mevcut claim ekranlarını okuyarak gerçek koda göre yaz. Çıktı: docs/marketing/growth/post-claim-flow.md. Mevcut metinde net bir kazanç görürsen değişikliği doğrudan apps/web/lib/copy.ts içine uygula; tartışmalı olanı dokümanda öneri olarak bırak.

4. Referral programı tasarımı. Escrow modeliyle uyumlu olsun: Lumenia para tutmaz, ödül mekaniği bu ilkeyi bozamaz. Suistimal senaryolarını tek tek yaz ve her birine önlem koy: kendi kendine gönderim, sahte alıcı zinciri, gas sponsorluğunu sömürmek için üretilen mikro transferler, aynı kişinin çok kimlikle claim etmesi. Ödül önerilerini birim maliyetiyle ver ve programın hangi metrikle durdurulacağını baştan yaz. Çıktı: docs/marketing/growth/referral-program.md.

5. Aktivasyon funnel tanımı ve deney listesi. Adımlar: link oluşturma, paylaşma, claim, tekrar kullanım. Her adım için tanımı, ölçüm eventini ve bugünkü sürtünmeyi yaz. Her adım için en az 3 deney öner. Her deneye ICE skoru ver (Impact, Confidence, Ease, her biri 1 ile 10 arası) ve tabloyu toplam skora göre sırala. Her deneyin başarı metriğini ve karar eşiğini yaz. Çıktı: docs/marketing/growth/activation-funnel.md.

6. İlk 100 gerçek kullanıcı planı. Kanal kanal yaz: Türkiye koridoru diasporası (yurt dışında çalışıp eve para gönderenler), Stellar topluluğu, kurucunun kişisel ağı. Her kanal için: kim, nereden bulunur, ilk mesaj taslağı, haftalık hedef sayı. Dış mesaj taslakları İngilizce, Türkiye koridoru mesajları Türkçe. Çıktı: docs/marketing/growth/first-100-users.md.

Çalışma şekli. Her görev kalemi için ayrı bir subagent başlat, altısı paralel çalışsın. Yalnızca 3. görev, 1. görevin döngü haritasını girdi olarak beklesin. Hepsi bitince bir sentez ajanı bulguları birleştirsin ve docs/marketing/growth/README.md içine tek sayfalık büyüme modeli özeti yazsın: döngü şeması, gerçekçi K senaryosu, en yüksek ICE skorlu 5 deney, ilk hafta yapılacaklar. En sonda bir tamamlanma kritiği ajanı çalıştır: bu görev listesiyle üretilen dosyaları karşılaştırsın, eksik veya yüzeysel kalan yeri raporlasın. Kritiğin bulduğu eksikleri kapatmadan bitirme.

Dil. Repoya giren strateji dokümanlarını İngilizce yaz. Dışa dönük mesaj taslakları İngilizce, Türkiye koridoru taslakları Türkçe. Bana vereceğin son rapor Türkçe.

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

Değişiklikleri anlamlı parçalara bölünmüş commitlere ayır. Örnek bölme: viral döngü ve K faktörü bir commit, claim sonrası akış ve varsa copy.ts değişikliği bir commit, referral programı bir commit, funnel ve deney listesi bir commit, ilk 100 kullanıcı planı ve sentez bir commit. Commit mesajları İngilizce ve conventional commits formatında olsun, insan sesiyle yaz. Repodaki gerçek örnek: "fix(ux): stop the app asserting things about money that aren't true". Sonda push et. En son bana Türkçe bir özet raporu ver: ne buldun, hangi dosyaları yazdın, hangi deneyle başlamalıyım ve neden.
