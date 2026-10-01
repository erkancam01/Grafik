/**
 * Altın için haber konjonktürü takvimi (2021-01 → 2026-09) — yapay zekâ süzgecinin "o gün haberleri okusaydı" görüşü.
 * Kullanıcı isteği: "geçmişteki haberleri sanki dün duyuyormuş gibi düşünerek ve grafiğe bakarak işlem al; sinyal geldi
 * diyelim, o günkü konjonktüre bak, mantıksızsa alma".
 *
 * Kurallar (takvim yazılırken uyuldu; A_STUDY, protocol.ts):
 * - Her görüş değişikliği tarihli bir habere bağlı: Fed kararı/konuşması, enflasyon ve istihdam verisi, savaş, kriz,
 *   resmi açıklama, rapor. Görüş haber gününün ertesi 00:00 UTC'den geçerli ("dün duymuş gibi").
 * - Görüş, haberin o günkü olağan okunuşu: şahin Fed / yükselen reel faiz / güçlü dolar / risk iştahı → olumsuz;
 *   güvercin Fed / güvenli liman olayı / merkez bankası alımı / enflasyon ve mali kaygı → olumlu; çelişkiliyse karışık.
 * - Altının kendi fiyat hareketi gerekçe olarak kullanılmadı.
 * - Aynı görüşü pekiştiren önemli haberler de yazıldı (kararı değiştirmez).
 * Uyarı: takvim 2026-10'da, sonradan ne olduğunu bilen biri (Claude) tarafından yazıldı. Ne kadar dikkat edilse de
 * geriye dönük sonuç iyimser bir üst sınırdır. 2026 haberleri web aramasıyla doğrulandı.
 */

export type Gorus = 1 | 0 | -1;

export interface Haber {
  /** Haberin günü (UTC). */
  tarih: string;
  /** Altın için: 1 olumlu, 0 karışık, -1 olumsuz. */
  gorus: Gorus;
  haber: string;
}

export const KONJONKTUR: readonly Haber[] = [
  { tarih: "2020-12-31", gorus: 0, haber: "Başlangıç: Fed faizi sıfırda tutuyor, varlık alımı sürüyor; aşı iyimserliği ve risk iştahı güçlü. Karışık." },
  // ---------------------------------------------------------------- 2021
  { tarih: "2021-01-06", gorus: -1, haber: "Georgia seçimiyle Demokratlar Senato'yu aldı; büyük teşvik beklentisiyle ABD 10 yıllık faizi Mart 2020'den beri ilk kez %1'i aştı. Yükselen faiz olumsuz." },
  { tarih: "2021-02-25", gorus: -1, haber: "Tahvil satışı sertleşti, 10 yıllık faiz %1,5'in üstünde (pekiştiren)." },
  { tarih: "2021-03-17", gorus: 0, haber: "FOMC: 2023 sonuna kadar faiz artışı öngörülmüyor, Fed faizlerin yükselişine karşı çıkmıyor; faizler yine de yükseliyor. Karışık." },
  { tarih: "2021-04-28", gorus: 1, haber: "FOMC: alımları azaltmayı konuşmanın zamanı değil, enflasyon 'geçici'. Gevşek para ve yükselen enflasyon olumlu." },
  { tarih: "2021-05-12", gorus: 1, haber: "Nisan TÜFE %4,2 (2008'den beri en yüksek); enflasyondan korunma talebi (pekiştiren)." },
  { tarih: "2021-06-16", gorus: -1, haber: "FOMC sürprizi: noktalar 2023'te iki artış gösteriyor; Bullard (18 Haziran) 2022'de artış diyor. Şahin Fed olumsuz." },
  { tarih: "2021-07-14", gorus: 0, haber: "Powell Kongre'de: alımları azaltmaya 'daha epey yol var'; Delta varyantı kaygısıyla faizler düşüyor. Karışık." },
  { tarih: "2021-08-06", gorus: -1, haber: "Temmuz istihdamı 943 bin, beklentinin üstünde: Fed'in alımları azaltması yaklaşıyor. Olumsuz." },
  { tarih: "2021-08-27", gorus: 0, haber: "Jackson Hole: Powell azaltma bu yıl başlayabilir ama faiz artışında acele yok dedi. Karışık." },
  { tarih: "2021-09-22", gorus: -1, haber: "FOMC: azaltma 'yakında', üyelerin yarısı 2022'de faiz artışı görüyor. Olumsuz." },
  { tarih: "2021-10-13", gorus: 0, haber: "Eylül TÜFE %5,4; Fed tutanakları kasımda azaltma diyor. Enflasyon kaygısı ile şahin Fed dengede, karışık." },
  { tarih: "2021-11-10", gorus: 1, haber: "Ekim TÜFE %6,2 (31 yılın zirvesi); Fed (3 Kasım) yalnız alımları azaltıyor, faizde acele etmiyor. Enflasyondan korunma talebi olumlu." },
  { tarih: "2021-11-22", gorus: -1, haber: "Biden Powell'ı yeniden aday gösterdi (daha güvercin Brainard yerine); faizler ve dolar yükseldi. Olumsuz." },
  { tarih: "2021-11-30", gorus: -1, haber: "Powell 'geçici' sözünü bıraktı, alımları daha hızlı azaltmayı önerdi (pekiştiren)." },
  { tarih: "2021-12-15", gorus: -1, haber: "FOMC azaltmayı iki katına çıkardı, noktalar 2022'de üç artış gösteriyor (pekiştiren)." },
  // ---------------------------------------------------------------- 2022
  { tarih: "2022-01-26", gorus: -1, haber: "FOMC: mart ayında faiz artışı işareti (pekiştiren)." },
  { tarih: "2022-02-11", gorus: 1, haber: "ABD: Rusya Ukrayna'yı her an işgal edebilir (Sullivan). Savaş riski, güvenli liman talebi. Olumlu." },
  { tarih: "2022-02-24", gorus: 1, haber: "Rusya Ukrayna'yı işgal etti; yaptırımlar, emtia şoku (pekiştiren)." },
  { tarih: "2022-03-16", gorus: 0, haber: "Fed ilk faiz artışını yaptı ve yıl içinde altı artış daha işaret etti; savaş sürüyor ama ateşkes görüşmeleri başladı. Karışık." },
  { tarih: "2022-04-06", gorus: -1, haber: "Fed tutanakları: ayda 95 milyar dolarlık bilanço küçültme ve 50 baz puanlık artışlar; Brainard (5 Nisan) hızlı küçültme dedi. Faiz ve dolar yükseliyor, olumsuz." },
  { tarih: "2022-05-04", gorus: -1, haber: "Fed 50 baz puan artırdı, bilanço küçültme haziranda (pekiştiren)." },
  { tarih: "2022-06-15", gorus: -1, haber: "Mayıs TÜFE %8,6 sonrası Fed 75 baz puan artırdı (pekiştiren)." },
  { tarih: "2022-08-26", gorus: -1, haber: "Jackson Hole: Powell enflasyonla mücadelede 'acı' uyarısı (pekiştiren)." },
  { tarih: "2022-09-21", gorus: -1, haber: "Fed yine 75 baz puan, noktalar daha yüksek (pekiştiren)." },
  { tarih: "2022-10-21", gorus: 0, haber: "WSJ: Fed aralıkta artışları yavaşlatmayı tartışacak; 'dönüş' beklentisi başladı. Karışık." },
  { tarih: "2022-11-10", gorus: 1, haber: "Ekim TÜFE %7,7, beklentinin altında: enflasyon zirveyi geçti, Fed yavaşlayacak; dolar sert düştü. Merkez bankaları 3. çeyrekte rekor altın aldı (WGC, 1 Kasım). Olumlu." },
  { tarih: "2022-12-07", gorus: 1, haber: "Çin merkez bankası üç yıl aradan sonra altın rezervini artırdı (pekiştiren)." },
  // ---------------------------------------------------------------- 2023
  { tarih: "2023-01-31", gorus: 1, haber: "WGC: merkez bankaları 2022'de rekor altın aldı (pekiştiren)." },
  { tarih: "2023-02-03", gorus: -1, haber: "Ocak istihdamı 517 bin, beklentinin üç katı: Fed artışları sürdürecek, dolar yükseldi. Olumsuz." },
  { tarih: "2023-03-07", gorus: -1, haber: "Powell Kongre'de: tepe faiz beklenenden yüksek olabilir (pekiştiren)." },
  { tarih: "2023-03-10", gorus: 1, haber: "Silicon Valley Bank battı (ardından Signature, Credit Suisse): bankacılık krizi, güvenli liman ve Fed'in duracağı beklentisi. Olumlu." },
  { tarih: "2023-03-22", gorus: 1, haber: "Fed 25 baz puan artırdı, artışların sonuna yaklaşıldığını işaret etti (pekiştiren)." },
  { tarih: "2023-05-28", gorus: 0, haber: "ABD borç tavanı anlaşması; güçlü veriler haziranda artış ihtimalini yükseltti. Karışık." },
  { tarih: "2023-06-14", gorus: -1, haber: "Fed durdu ama noktalar yıl içinde iki artış daha gösteriyor (şahin duraklama). Olumsuz." },
  { tarih: "2023-07-12", gorus: 0, haber: "Haziran TÜFE %3,0, beklentinin altında: artışların sonu yakın. Karışık." },
  { tarih: "2023-08-02", gorus: -1, haber: "Fitch ABD'nin notunu düşürdü, Hazine borçlanmayı artırdı; uzun vadeli faizler 15 yılın zirvesine yürüyor. Olumsuz." },
  { tarih: "2023-09-20", gorus: -1, haber: "Fed: faiz daha uzun süre yüksek kalacak (pekiştiren)." },
  { tarih: "2023-10-07", gorus: 1, haber: "Hamas İsrail'e saldırdı, Orta Doğu'da savaş: güvenli liman talebi. Olumlu." },
  { tarih: "2023-11-14", gorus: 1, haber: "Ekim TÜFE beklentinin altında, faiz artışları bitti beklentisi (pekiştiren)." },
  { tarih: "2023-12-13", gorus: 1, haber: "FOMC: noktalar 2024'te üç indirim gösteriyor, Fed dönüşü (pekiştiren)." },
  // ---------------------------------------------------------------- 2024
  { tarih: "2024-01-31", gorus: 0, haber: "Powell: mart ayında indirim olası değil; güçlü veriler indirimleri erteliyor. Merkez bankası alımları sürüyor. Karışık." },
  { tarih: "2024-03-07", gorus: 1, haber: "Powell Kongre'de: indirime başlamak için gereken güvene 'uzak değiliz'. Merkez bankaları (Çin) alımı sürdürüyor. Olumlu." },
  { tarih: "2024-04-13", gorus: 1, haber: "İran İsrail'e füze ve İHA saldırısı düzenledi (pekiştiren)." },
  { tarih: "2024-04-19", gorus: 0, haber: "İsrail'in sınırlı karşılığı sonrası İran gerginliği yatıştı; sıcak enflasyon (10 Nisan) indirimleri geciktiriyor. Karışık." },
  { tarih: "2024-06-07", gorus: -1, haber: "Çin merkez bankası 18 aylık altın alımını durdurdu; mayıs istihdamı güçlü (272 bin). Olumsuz." },
  { tarih: "2024-06-12", gorus: 0, haber: "Mayıs TÜFE beklentinin altında; Fed noktaları yıl içinde bir indirim gösteriyor. Karışık." },
  { tarih: "2024-07-11", gorus: 1, haber: "Haziran TÜFE aylık eksiye döndü: eylülde indirim neredeyse kesin. ABD'de siyasi belirsizlik (13 Temmuz suikast girişimi, 21 Temmuz Biden çekildi). Olumlu." },
  { tarih: "2024-08-02", gorus: 1, haber: "Temmuz istihdamı zayıf, işsizlik %4,3 (pekiştiren)." },
  { tarih: "2024-08-23", gorus: 1, haber: "Jackson Hole: Powell 'politikayı ayarlamanın zamanı geldi' (pekiştiren)." },
  { tarih: "2024-09-18", gorus: 1, haber: "Fed 50 baz puan indirdi (pekiştiren)." },
  { tarih: "2024-10-01", gorus: 1, haber: "İran İsrail'e balistik füze saldırısı düzenledi (pekiştiren)." },
  { tarih: "2024-11-06", gorus: -1, haber: "Trump seçimi kazandı: dolar ve faizler yükseliyor, risk iştahı güçlü ('Trump ticareti'). Olumsuz." },
  { tarih: "2024-12-18", gorus: -1, haber: "Fed indirdi ama 2025 için daha az indirim işaret etti (pekiştiren)." },
  // ---------------------------------------------------------------- 2025
  { tarih: "2025-01-20", gorus: 1, haber: "Trump göreve başladı; Kanada ve Meksika'ya 1 Şubat için gümrük vergisi tehdidi: ticaret savaşı belirsizliği, güvenli liman talebi; merkez bankası alımları sürüyor. Olumlu." },
  { tarih: "2025-02-01", gorus: 1, haber: "Kanada, Meksika ve Çin'e gümrük vergileri açıklandı (pekiştiren)." },
  { tarih: "2025-04-02", gorus: 1, haber: "'Kurtuluş Günü' karşılıklı gümrük vergileri: piyasalarda çöküş, durgunluk kaygısı (pekiştiren)." },
  { tarih: "2025-04-21", gorus: 1, haber: "Trump Powell'ı hedef aldı: Fed'in bağımsızlığı kaygısı (pekiştiren)." },
  { tarih: "2025-05-12", gorus: -1, haber: "ABD-Çin Cenevre anlaşması: karşılıklı gümrük vergileri 90 gün indirildi; risk iştahı döndü, güvenli liman talebi azaldı. Olumsuz." },
  { tarih: "2025-05-16", gorus: 0, haber: "Moody's ABD'nin notunu düşürdü, bütçe açığı kaygısı. Karışık." },
  { tarih: "2025-06-13", gorus: 1, haber: "İsrail İran'ı vurdu (ABD 22 Haziran'da katıldı): güvenli liman talebi. Olumlu." },
  { tarih: "2025-06-24", gorus: 0, haber: "İsrail-İran ateşkesi; jeopolitik risk primi azaldı. Karışık." },
  { tarih: "2025-08-01", gorus: 1, haber: "Temmuz istihdamı zayıf, önceki aylar sert aşağı düzeltildi; Trump BLS başkanını görevden aldı. Eylülde indirim beklentisi ve kurumlara güven kaygısı. Olumlu." },
  { tarih: "2025-08-22", gorus: 1, haber: "Jackson Hole: Powell eylülde indirime kapıyı açtı (pekiştiren)." },
  { tarih: "2025-08-25", gorus: 1, haber: "Trump Fed üyesi Cook'u görevden almaya çalıştı: Fed'in bağımsızlığı kaygısı (pekiştiren)." },
  { tarih: "2025-09-17", gorus: 1, haber: "Fed 25 baz puan indirdi (pekiştiren)." },
  { tarih: "2025-10-01", gorus: 1, haber: "ABD hükümeti kapandı (pekiştiren)." },
  { tarih: "2025-10-30", gorus: 0, haber: "Powell (29 Ekim): aralıkta indirim kesin değil; Trump-Şi görüşmesinde ticaret ateşkesi. Karışık." },
  { tarih: "2025-11-21", gorus: 1, haber: "New York Fed başkanı Williams: yakın vadede indirime yer var; aralık indirimi beklentisi yükseldi. Olumlu." },
  { tarih: "2025-12-10", gorus: 1, haber: "Fed 25 baz puan indirdi (pekiştiren)." },
  // ---------------------------------------------------------------- 2026
  { tarih: "2026-01-30", gorus: -1, haber: "Trump Fed başkanlığına Kevin Warsh'ı aday gösterdi: güvercin başkan beklentisi çöktü, Warsh geleneksel ve bilanço küçültmeye yatkın. Olumsuz." },
  { tarih: "2026-02-20", gorus: 0, haber: "ABD Yüksek Mahkemesi IEEPA gümrük vergilerini iptal etti, Trump %15 genel vergi koydu; dolar zayıfladı, ticaret belirsizliği. Karışık." },
  { tarih: "2026-02-28", gorus: 1, haber: "ABD ve İsrail İran'a saldırdı; Hürmüz Boğazı'nda petrol akışı durma noktasına geldi. Büyük jeopolitik şok, güvenli liman talebi. Olumlu." },
  { tarih: "2026-03-18", gorus: 0, haber: "Fed faizi sabit tuttu (%3,50-3,75); noktalar 2026'da tek indirim gösteriyor, petrol kaynaklı enflasyon riski. Savaş sürüyor. Karışık." },
  { tarih: "2026-04-08", gorus: -1, haber: "ABD-İran iki haftalık ateşkes (Pakistan arabuluculuğu): savaş primi azalıyor; enerji kaynaklı enflasyon Fed'i şahin tutuyor. Olumsuz." },
  { tarih: "2026-04-29", gorus: -1, haber: "FOMC sabit; üç üye gevşeme eğilimine karşı çıktı (pekiştiren)." },
  { tarih: "2026-05-12", gorus: -1, haber: "Nisan TÜFE %3,8 (2023'ten beri en yüksek), faizler yükseldi (pekiştiren)." },
  { tarih: "2026-05-13", gorus: -1, haber: "Senato Warsh'ı onayladı (pekiştiren)." },
  { tarih: "2026-06-10", gorus: -1, haber: "Mayıs TÜFE %4,2 (pekiştiren)." },
  { tarih: "2026-06-14", gorus: -1, haber: "ABD-İran ateşkesi uzatma ve Hürmüz'ü açma anlaşması (pekiştiren)." },
  { tarih: "2026-06-17", gorus: -1, haber: "Warsh'ın ilk FOMC'si: yıl içi indirim beklentisi kaldırıldı, artış mümkün (pekiştiren)." },
  { tarih: "2026-07-08", gorus: 0, haber: "Ateşkes çöktü, İran Hürmüz'de ticari gemilere saldırıyor (13-14 Temmuz ABD saldırıları ve abluka); öte yandan Fed şahin. Karışık." },
  { tarih: "2026-07-29", gorus: 0, haber: "FOMC sabit, üç üye artış istedi; savaş sürüyor (karışık sürüyor)." },
  { tarih: "2026-08-28", gorus: -1, haber: "Jackson Hole: Warsh inatçı enflasyon için faiz artışı işareti verdi. Olumsuz." },
  { tarih: "2026-09-16", gorus: -1, haber: "Fed 2023'ten beri ilk kez faiz artırdı (%3,75-4,00), bir artış daha işaret etti (pekiştiren)." },
];

const GUN = 86_400_000;
/** Görüşün geçerli olduğu an: haber gününün ertesi 00:00 UTC. */
export const gecerli = (h: Haber) => Date.parse(`${h.tarih}T00:00:00Z`) + GUN;

const ZAMANLAR = KONJONKTUR.map(gecerli);

/** `t` anında (ms) geçerli haber (o ana kadar duyulmuş en son haber). */
export function haberAt(t: number): Haber {
  let i = 0;
  while (i + 1 < ZAMANLAR.length && ZAMANLAR[i + 1]! <= t) i++;
  return KONJONKTUR[i]!;
}

/**
 * Karar (yapay zekâ: haber + grafik): konjonktür olumluysa yalnız long, olumsuzsa yalnız short; karışıksa üst zaman
 * dilimi trendi yönündeki sinyaller alınır.
 */
export function kararHaberGrafik(yon: 1 | -1, gorus: Gorus, trend: 1 | -1): boolean {
  return gorus !== 0 ? gorus === yon : trend === yon;
}
/** Yalnız haber: karışıkta sinyal alınır. */
export function kararHaber(yon: 1 | -1, gorus: Gorus): boolean {
  return gorus === 0 || gorus === yon;
}
/** Yalnız grafik: üst zaman dilimi trendi yönündeki sinyaller. */
export function kararGrafik(yon: 1 | -1, trend: 1 | -1): boolean {
  return trend === yon;
}

/** Grafik okuması: sinyal zaman dilimi → üst zaman dilimi ve EMA (son kapanmış mumda kapanış EMA'nın üstündeyse yukarı). */
export const UST_TREND: Record<number, { tf: number; ema: number; ad: string }> = {
  3600: { tf: 14_400, ema: 50, ad: "4 saatlik EMA50" },
  14_400: { tf: 86_400, ema: 50, ad: "günlük EMA50" },
  86_400: { tf: 604_800, ema: 20, ad: "haftalık EMA20" },
  604_800: { tf: 604_800, ema: 40, ad: "haftalık EMA40" },
};
