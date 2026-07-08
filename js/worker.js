/* PyHome — Pyodide Web Worker'ı (Faz 2 sertleştirme: sonsuz döngü koruması)
 *
 * Neden worker? Öğrenci kodu (örn. `while True:`) ana iş parçacığında çalışırsa
 * sekme kilitlenir. Bu worker Pyodide'ı ayrı bir iş parçacığında çalıştırır;
 * kod takılırsa ana iş parçacığı (app.js) bu worker'ı `terminate()` ile öldürüp
 * yenisini kurar — SharedArrayBuffer / özel HTTP başlığı GEREKTİRMEYEN yöntem
 * (GitHub Pages özel başlık desteklemez).
 *
 * Bu worker bir Blob URL'den yüklenir (app.js içinde). Sebep: Chrome, file://
 * sayfalarında ayrı dosyadan worker açmayı engeller ama blob: worker'a izin verir;
 * böylece yerel önizleme (file://) de çalışır. Pyodide CDN'den importScripts ile
 * alınır (blob worker'dan mutlak https adresine importScripts serbesttir).
 *
 * Mesaj protokolü (ana iş parçacığı -> worker):
 *   {type:'init', pyodideUrl, motorSrc}          Pyodide + test motorunu yükle
 *   {type:'calistir', id, kod, girdiler}         "Çalıştır"
 *   {type:'puanla',   id, kod, testler}          "Gönder"
 * (worker -> ana iş parçacığı):
 *   {type:'hazir'}                               init tamam
 *   {type:'init_hata', hata}                     init başarısız
 *   {type:'paket', id}                           paket (numpy/pandas) yükleniyor
 *   {type:'basladi', id}                         hesaplama fazı başladı (koşu sayacı burada başlar)
 *   {type:'sonuc', id, veri}                     motor JSON çıktısı (string)
 *   {type:'hata', id, hata}                      worker altyapı hatası (öğrenci kodu hatası değil)
 */

/* global loadPyodide */

let pyodide = null;
let calistir_json = null;
let puanla_json = null;

// Kodun paket (numpy/pandas) gerektirip gerektirmediğini kabaca sezer — yalnızca
// "paketler yükleniyor…" durumunu göstermek için (asıl yükleme Pyodide'ye ait).
function paketGerekli(kod) {
  return /\b(?:import|from)\s+(?:numpy|pandas)\b/.test(kod || "");
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "init") {
      importScripts(m.pyodideUrl + "pyodide.js");
      pyodide = await loadPyodide({ indexURL: m.pyodideUrl });
      pyodide.runPython(m.motorSrc);
      calistir_json = pyodide.globals.get("calistir_json");
      puanla_json = pyodide.globals.get("puanla_json");
      self.postMessage({ type: "hazir" });
      return;
    }

    if (m.type === "calistir" || m.type === "puanla") {
      if (!pyodide) {
        self.postMessage({ type: "hata", id: m.id, hata: "Ortam henüz hazır değil." });
        return;
      }
      // Paket yükleme fazı (zaman aşımı: hazırlık). Ana iş parçacığına durum bildir.
      if (paketGerekli(m.kod)) self.postMessage({ type: "paket", id: m.id });
      try {
        await pyodide.loadPackagesFromImports(m.kod);
      } catch (_) {
        /* paket yoksa/başarısızsa sessiz geç; hata çalıştırma çıktısında görünür */
      }
      // Hesaplama fazı başlıyor — ana iş parçacığı koşu zaman aşımını buradan başlatır.
      self.postMessage({ type: "basladi", id: m.id });
      let sonucStr;
      if (m.type === "calistir") {
        sonucStr = calistir_json(m.kod, JSON.stringify(m.girdiler || []));
      } else {
        sonucStr = puanla_json(m.kod, JSON.stringify(m.testler || []));
      }
      self.postMessage({ type: "sonuc", id: m.id, veri: sonucStr });
      return;
    }
  } catch (err) {
    const mesaj = String((err && err.message) || err);
    self.postMessage({
      type: m.type === "init" ? "init_hata" : "hata",
      id: m.id,
      hata: mesaj,
    });
  }
};
