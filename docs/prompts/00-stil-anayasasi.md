# Stil anayasası

## Ne zaman kullan

Kullanıcıya görünen tek bir satır bile yazacak her session, işe başlamadan önce bu dosyayı okur. Site metni, blog, sosyal medya, e-posta, buton etiketi, hata mesajı: hepsi bu anayasaya tabidir.

## Nasıl çalıştır

Bu dosya bir rol promptu değildir, tek başına çalıştırılmaz. Lumenia reposunda (/Users/mericcintosun/faceid-wallet) açtığın Claude Code session'ına rol promptunu yapıştırdıktan sonra session bu anayasanın repo kopyasını (docs/marketing/style-constitution.md) okur; kopya henüz yoksa 7. bölümdeki talimatla oluşturur.

---

## Bu anayasa nedir

Lumenia'nın bütün pazarlama session'larının ortak referansı. İki işi var: Lumenia'nın sesini tarif etmek ve AI kokusunu metinden uzak tutmak. Başka bir talimat buradaki bir kuralla çelişirse, buradaki kazanır.

Site dili İngilizce. Dışa dönük çıktılar (site metni, blog, sosyal medya) İngilizce yazılır. Türkiye koridoru içerikleri ayrıca Türkçe yazılır. Bu anayasa iki dile de uygulanır.

## 1. Lumenia ses DNA'sı

Lumenia'nın sesi sitede zaten var. Bu bölüm o sesi ilkelere döker. Yeni metin yazarken hedef bu sesi tutturmak ve keskinleştirmek; AI kokusunu temizlerken bu sesi düzleştirmek yasak.

**Kısa cümle, tek fikir.** Bir cümle bir iş yapar. Siteden örnek: "Money home, in a link."

**İkinci şahıs.** Metin okuyucuyla konuşur, okuyucu hakkında konuşmaz. Siteden örnek: "Your money is never ours. That's the point."

**Korkuyu adlandır, sonra sök.** Kullanıcının aklındaki soruyu görmezden gelme. Soruyu yüzüne söyle, sonra tek tek cevapla. Siteden örnek: "Fair question. Four facts."

**Kesin olumsuzlama.** Bir şey yoksa, yok de. Yumuşatma, dolandırma. Siteden örnek: "No wallet, not now, not ever."

**Kanıt, sıfat değil.** Güven istemek yerine doğrulanabilir şey göster: tx hash, canlı sayı, Stellar doğrulama linki. Siteden örnek: "Proof, not promises."

**Abartısız sıcaklık.** Konu eve para göndermek. Ton sıcak ama süssüz. Coşku gösterisi yok, ünlem enflasyonu yok. Sıcaklık kelime süsünden değil, okuyucunun derdini ciddiye almaktan gelir.

## 2. Yasak listesi

Aşağıdaki kalıplar hiçbir çıktıda kullanılmaz. Liste örnek değil, yasak. Bir kalıbın çekimli hali, çoğulu ve yakın çevirisi de yasaktır.

### İngilizce: tek kelimeler ve kısa kalıplar

seamless, effortless, frictionless, hassle-free, empower, unlock, unleash, elevate, supercharge, revolutionize, game-changer, cutting-edge, state-of-the-art, best-in-class, world-class, next-level, robust, leverage (fiil olarak), delve, streamline, landscape (metafor olarak), realm, journey (metafor olarak), ecosystem (dolgu metafor olarak), holistic, synergy, intuitive (kanıtsız övgü olarak), innovative, future-proof, democratize, reimagine, redefine, transform the way, lightning-fast, blazingly fast, one-stop shop, peace of mind, at your fingertips, harness the power of, take it to the next level.

### İngilizce: hazır cümleler ve açılışlar

"In today's fast-paced world", "Look no further", "Whether you're X or Y", "Say goodbye to", "Welcome to the future of", "Imagine a world where", "That's where X comes in", "We've got you covered", "Rest assured", "No strings attached", "More than just", "The best part?", "But wait, there's more", "Let's dive in" ve her türlü "dive in", "Here's the thing".

### İngilizce: dolgu geçişler

moreover, furthermore, additionally, "at the end of the day", "when it comes to", "in a nutshell", "needless to say", "simply put", "it's worth noting", "it's important to note", "in conclusion".

### Türkçe kalıplar

"günümüz dünyasında", "dijital çağda", "hayal edin", "X'e veda edin", "geleceğe hoş geldiniz", "geleceği bugünden yaşayın", "devrim niteliğinde", "çığır açan", "kusursuz deneyim", "yepyeni bir deneyim", "ihtiyacınız olan tek şey", "sizin için buradayız", "parmaklarınızın ucunda", "bir tık uzağınızda", "hiç bu kadar kolay olmamıştı", "artık çok kolay", "içiniz rahat olsun", "gönül rahatlığıyla", "hayatınızı kolaylaştırır", "fark yaratın", "teknolojinin gücü", "sınırları kaldırıyoruz", "tanışın: X", "ve dahası", kanıtsız övgü olarak "zahmetsiz" ve "sorunsuz".

### Yapısal tikler

Kelime yasağı yetmez. AI metni yapısından da tanınır. Şunlar da yasak:

- Her paragrafı aynı uzunlukta tutmak. İnsan metninde ritim değişir. Tek cümlelik paragraf serbesttir.
- Sürekli "not X but Y" kalıbı, Türkçesi "sadece X değil, aynı zamanda Y". Metin başına en fazla bir kez.
- Boşluklu üç nokta yasak: üç noktanın öncesine ve sonrasına boşluk koymak. Karakteri burada göstermiyoruz, adıyla anıyoruz. Üç nokta zaten nadiren gerekir.
- Bağlaç enflasyonu: İngilizcede moreover, furthermore, additionally zinciri; Türkçede ayrıca, üstelik, dahası zinciri. Cümleler bağlaçsız da art arda gelebilir.
- Her cümleye bir sıfat sıkıştırmak. Cümle başına en fazla bir sıfat hedefle. Üçlü paralel sıfat dizisi ("fast, simple, and secure" tarzı) tamamen yasak.
- Başlık enflasyonu: iki cümlede bir ara başlık. Bir başlık altında en az bir dolu paragraf olmalı.
- Retorik soruyla açılış. Metin cevapla açılır, soruyla değil. Kullanıcının gerçek sorusunu FAQ biçiminde ele almak serbesttir, o retorik değildir.
- Emoji başlık. Başlıklarda emoji yok.
- Başlıklarda her kelimeyi büyük harfle yazmak. Sentence case kullanılır.
- Başlığı tekrar eden ilk cümle. Başlık "How claiming works" ise ilk cümle "Claiming works like this" olamaz.
- Her metni "In conclusion" veya "Sonuç olarak" ile kapatmak. Metin son somut cümlede biter.
- Hedge dolgusu: "it's important to note", "arguably", "denilebilir ki". İddiaysa söyle, değilse sil.

## 3. Em dash politikası

Em dash ve en dash hiçbir çıktıda kullanılmaz. Bu iki tire karakteri bu dosyada bile geçmez; o yüzden burada adlarıyla anılıyorlar. Normal kısa tire (birleşik kelimeler ve "7-day" gibi kullanımlar) serbesttir.

Neden yasak:

1. Bu iki tire AI metninin en tanınır imzası oldu. Okur görür görmez metne güvenini kaybediyor.
2. Uzun tire iki fikri, aralarındaki ilişkiyi söylemeden yapıştırır. Virgül, nokta veya parantez seçmek yazarı o ilişkiyi netleştirmeye zorlar.
3. Lumenia'nın sesi kısa cümle üstüne kurulu. Tireyle uzatılan cümle bu sese aykırı.

Yerine ne gelir: iki bağımsız fikir için nokta, bağlı fikir için virgül, yan bilgi için parantez. Çoğu durumda en iyi çözüm cümleyi ikiye bölmek.

Örnek dönüşümler (yasak karakter yerine [uzun tire] yazıldı):

1. Önce: "Your money is waiting [uzun tire] claim it with your face."
   Sonra: "Your money is waiting. Claim it with your face."
2. Önce: "If nobody claims it [uzun tire] the money comes back to you."
   Sonra: "If nobody claims it, the money comes back to you."
3. Önce: "The network fee [uzun tire] we cover it [uzun tire] never touches the receiver."
   Sonra: "The network fee (we cover it) never touches the receiver."

## 4. Önce ve sonra

Beş örnek. Hepsi Lumenia bağlamında: para gönderme, güven, claim akışı.

**1.**
Önce: "Lumenia empowers you to send money seamlessly to your loved ones, anywhere in the world."
Neden kötü: iki yasak kelime, sıfır bilgi.
Sonra: "Pick an amount. Paste the link into the chat. They tap it, the money is theirs."

**2.**
Önce: "Say goodbye to complicated wallets and hello to effortless transfers."
Neden kötü: yasak açılış kalıbı, kanıtsız övgü.
Sonra: "No wallet. No seed phrase. No app to download."

**3.**
Önce: "Rest assured, your funds are protected by cutting-edge blockchain technology."
Neden kötü: "rest assured" güven ister ama kanıt göstermez, "cutting-edge" hiçbir şey söylemez.
Sonra: "Your money waits in escrow as USDC. If nobody claims it in 7 days, it comes back to you. Check the transfer on Stellar yourself."

**4.**
Önce: "Whether you're a crypto expert or a complete beginner, Lumenia has you covered."
Neden kötü: "Whether you're X or Y" herkese seslenir, kimseye değmez.
Sonra: "Your mom doesn't need to know what Stellar is. She taps the link, shows her face, and the money is hers."

**5.**
Önce (TR): "Günümüz dünyasında yurt dışından eve para göndermek hiç bu kadar kolay olmamıştı."
Neden kötü: iki yasak kalıp üst üste, telefonda kimse böyle konuşmaz.
Sonra (TR): "Annene para göndermek için bir link yeter. Cüzdan yok, indirilecek uygulama yok."

## 5. Testler

Her metin yayına çıkmadan dört testten geçer. Testi geçemeyen cümle yeniden yazılır veya silinir.

**Telefon testi.** Bu cümleyi telefonda bir arkadaşına söyler miydin? Söylemezsen yeniden yaz. "We facilitate cross-border value transfer" telefonda söylenmez. "You send a link, she gets the money" söylenir.

**Sesli okuma testi.** Metni sesli oku. Nefesin yetmeyen, dilin dolaşan veya ikinci kez okumak zorunda kaldığın cümleyi böl ya da kısalt.

**"Hangi şirket olsa" testi.** Bu cümleyi başka bir şirket kendi sitesine aynen koyabilir mi? Koyabilirse cümle geneldir, sil. Kalan her cümle sadece Lumenia'dan gelebilecek bir şey söylemeli: link, escrow, 7 gün, yüzle talep, Stellar'da doğrulama.

**İddia testi.** Cümledeki her iddia doğrulanabilir mi? Doğrulanabiliyorsa kaynağını göster: tx hash, canlı sayı, dokümantasyon. Doğrulanamıyorsa o bir iddia değil süstür, sil.

## 6. Doğruluk kuralları

### Değiştirilemez teknik gerçekler

Bu iddialar metinde ancak bu haliyle yer alır. Yumuşatılamaz, abartılamaz, çevirisinde anlam kaydırılamaz:

- Para, link oluşturulduğu anda escrow'a ayrılır ve USDC olarak bekler.
- 7 gün içinde talep edilmeyen para gönderene otomatik döner.
- Lumenia parayı hiçbir an tutmaz. Lumenia banka değildir.
- Alım alıcı için ücretsizdir. Ağ ücretini (gas) Lumenia karşılar.
- Her transfer Stellar'a yazılır ve herkes tarafından doğrulanabilir.
- Alıcı parayı yüzüyle (biyometri) veya kendi seçtiği bir şifreyle talep eder. 12 kelimelik seed phrase yoktur.
- Lumenia, Stellar Community Fund desteklidir.

Not: Gerçekler değişmez ama adlandırma yüzeye göre değişir. Aynı gerçek app ekranında "held in dollars" diye, pazarlama sitesinde "USDC" diye anlatılır. Ayrıntı aşağıdaki yüzey ayrımı maddesinde.

### Yüzey ayrımı (vocabulary law)

Uygulama ekranlarında (app/(app) ve app/c) yalnızca para ve insan kelimeleri kullanılır: wallet, crypto, USDC, Stellar, blockchain, gas, on-chain yazılmaz. Onaylı karşılıklar: held in dollars, public record, we cover the network cost (kaynak: apps/web/lib/copy.ts başlığındaki vocabulary law, FRONTEND_PLAN paragraf 8). USDC, escrow ve Stellar adları yalnızca pazarlama sitesi app/(site), docs ve dış iletişimde kullanılır.

### Yeni iddia uydurmak yasak

- Ölçülmemiş hız iddiası yok. "Instant" veya "in seconds" ancak gerçek ölçüm varsa yazılır.
- Uydurma kullanıcı sayısı, hacim, ülke sayısı, ortaklık, lisans veya sertifika yok.
- "Guaranteed" ve "yüzde yüz güvenli" gibi mutlak güvenlik iddiası yok. Escrow bir mekanizmadır, garanti sözü değildir.
- Kur, liraya çevirme ve cash-out konusunda sitede ve dokümanlarda ne varsa o. Yenisini ekleme.
- Yeni bir iddia gerekiyorsa önce kanıt: repodaki EVIDENCE.md dosyasına bak, orada yoksa kurucuya sor. Kanıtsız iddia yayınlanmaz.

## 7. Repoya kopyalama

Bu anayasa repoda da yaşar:

1. Bu dosyanın yatay çizgiden sonraki bölümünü (anayasa metnini) /Users/mericcintosun/faceid-wallet/docs/marketing/style-constitution.md dosyasına kopyala.
2. Commit mesajı: `docs(marketing): add style constitution`. Güncellemede: `docs(marketing): update style constitution`.
3. Push et.
4. Anayasa değişirse iki kopya birlikte güncellenir. Repo kopyası eskimiş kalamaz.

Site metnine dokunan her session denetimi repo kopyası üzerinden yapar; içerik bu dosyayla aynıdır. Bu iddia iyi niyete bırakılmadı: defterdeki rol promptlarının stil blokları "yazmaya başlamadan önce docs/marketing/style-constitution.md dosyasını oku ve ona uy" maddesiyle başlar.
