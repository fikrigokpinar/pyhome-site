"""
test_engine.py — Tarayıcıdaki (Pyodide) test motoru.

Bu dosya scripts/validate.py'deki puanlama mantığının BİREBİR karşılığıdır:
aynı normalleştirme, aynı input() sahteleme, aynı test tipleri, aynı tolerans.
Pyodide CPython olduğundan, aynı dosya CPython'da da çalışır; scripts/parite_test.py
bunu tüm soru bankası üzerinde doğrular (motor == validate.py).

Öğrenci arayüzü (app.js) bu modülü Pyodide'de yükler ve iki fonksiyonu çağırır:
  - calistir(kod, girdiler)      -> "Çalıştır" düğmesi (kodu çalıştır, çıktıyı göster)
  - puanla(kod, testler)         -> "Gönder" düğmesi (testleri koştur, puan + geri bildirim)

Çözümler ve testlerin beklenen değerleri bu dosyaya GÖMÜLMEZ; app.js dışarıdan verir.
"""

import builtins
import contextlib
import io
import json
import re


class GirdiTukendi(Exception):
    """Kod, sağlanan girdi sayısından fazla input() çağrısı yaptığında fırlatılır."""


def turkce_kucult(s: str) -> str:
    """Türkçe büyük/küçük harf kurallarına göre metni küçültür (İ->i, I->ı)."""
    s = s.replace("İ", "i").replace("I", "ı")
    return s.lower()


def normalize(s: str) -> str:
    """Çıktıyı karşılaştırma için normalleştirir: baş/son boşluk atılır,
    çoklu boşluk teke iner, harfler Türkçe kurallarına göre küçültülür."""
    s = turkce_kucult(str(s))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def sayilari_cikar(s: str):
    """Metindeki tüm sayıları (ondalık, negatif dahil) sırayla listeler."""
    bulunanlar = re.findall(r"-?\d+(?:[.,]\d+)?", s)
    sonuc = []
    for b in bulunanlar:
        try:
            sonuc.append(float(b.replace(",", ".")))
        except ValueError:
            pass
    return sonuc


def kodu_calistir(kod: str, girdiler=None):
    """Verilen Python kodunu çalıştırır; input() çağrılarını girdiler listesinden
    sırayla besler (prompt metni çıktıya yazılmaz, bu yüzden çıktıdan sayılmaz).
    stdout'u yakalar. Dönüş: (stdout_metni, namespace_sozlugu)
    """
    girdiler = list(girdiler or [])
    girdi_kuyrugu = iter(girdiler)

    def sahte_input(prompt=""):
        try:
            return str(next(girdi_kuyrugu))
        except StopIteration:
            raise GirdiTukendi(
                f"Kod, sağlanandan fazla input() istedi (sağlanan girdi sayısı: {len(girdiler)})."
            )

    namespace = {"__name__": "__main__", "__builtins__": builtins}
    stdout_yakalayici = io.StringIO()

    eski_input = builtins.input
    builtins.input = sahte_input
    try:
        with contextlib.redirect_stdout(stdout_yakalayici):
            exec(kod, namespace)
    finally:
        builtins.input = eski_input

    return stdout_yakalayici.getvalue(), namespace


def sayi_esit_mi(a, b, tolerans):
    try:
        return abs(float(a) - float(b)) <= tolerans
    except (TypeError, ValueError):
        return a == b


def deger_karsilastir(alinan, beklenen, tolerans):
    """degisken/fonksiyon testleri için değer karşılaştırma; liste/array eleman
    bazlı, float'ta tolerans uygulanır."""
    if isinstance(beklenen, (list, tuple)):
        try:
            if len(alinan) != len(beklenen):
                return False
        except TypeError:
            return False
        return all(deger_karsilastir(a, b, tolerans) for a, b in zip(alinan, beklenen))
    if isinstance(beklenen, bool):
        return alinan is beklenen or alinan == beklenen
    if isinstance(beklenen, (int, float)):
        return sayi_esit_mi(alinan, beklenen, tolerans)
    if isinstance(beklenen, str):
        return normalize(str(alinan)) == normalize(beklenen)
    return alinan == beklenen


def test_calistir(test, kod):
    """Tek bir testi çalıştırır. Başarılıysa (True, "") döner, aksi halde (False, hata_mesaji)."""
    tip = test["tip"]
    tolerans = test.get("tolerans", 0.01)

    try:
        if tip == "kod_icerir":
            desen = test["beklenen"]
            if re.search(desen, kod):
                return True, ""
            return False, test.get("hata_mesaji", f"Kodda '{desen}' deseni bulunamadı.")

        if tip == "kod_icermez":
            desen = test["beklenen"]
            if not re.search(desen, kod):
                return True, ""
            return False, test.get("hata_mesaji", f"Kodda '{desen}' deseni bulunmamalıydı.")

        girdiler = test.get("girdiler", [])
        stdout, namespace = kodu_calistir(kod, girdiler)

        if tip == "stdout_esit":
            if normalize(stdout) == normalize(test["beklenen"]):
                return True, ""
            return False, test.get(
                "hata_mesaji", f"Beklenen çıktı: {test['beklenen']!r}, alınan: {stdout!r}"
            )

        if tip == "stdout_icerir":
            if normalize(str(test["beklenen"])) in normalize(stdout):
                return True, ""
            return False, test.get(
                "hata_mesaji", f"Çıktı '{test['beklenen']}' ifadesini içermeli. Alınan: {stdout!r}"
            )

        if tip == "stdout_satirlar":
            beklenen_satirlar = [normalize(b) for b in test["beklenen"]]
            alinan_satirlar = [normalize(satir) for satir in stdout.splitlines() if satir.strip()]
            if alinan_satirlar == beklenen_satirlar:
                return True, ""
            return False, test.get(
                "hata_mesaji",
                f"Çıktı satır satır beklenen: {test['beklenen']}, alınan: {alinan_satirlar}",
            )

        if tip == "stdout_sayi":
            beklenen = test["beklenen"]
            beklenen_liste = beklenen if isinstance(beklenen, list) else [beklenen]
            bulunanlar = sayilari_cikar(stdout)
            if len(bulunanlar) < len(beklenen_liste):
                return False, test.get(
                    "hata_mesaji", f"Çıktıda yeterli sayıda sayı bulunamadı. Alınan çıktı: {stdout!r}"
                )
            karsilastirilacak = bulunanlar[-len(beklenen_liste):]
            if all(sayi_esit_mi(a, b, tolerans) for a, b in zip(karsilastirilacak, beklenen_liste)):
                return True, ""
            return False, test.get(
                "hata_mesaji", f"Beklenen sayı(lar): {beklenen_liste}, alınan: {karsilastirilacak}"
            )

        if tip == "degisken":
            ad = test["degisken_adi"]
            if ad not in namespace:
                return False, test.get("hata_mesaji", f"'{ad}' adında bir değişken bulunamadı.")
            if deger_karsilastir(namespace[ad], test["beklenen"], tolerans):
                return True, ""
            return False, test.get(
                "hata_mesaji",
                f"'{ad}' değişkeni beklenen değere sahip değil. Beklenen: {test['beklenen']}, alınan: {namespace[ad]}",
            )

        if tip == "fonksiyon":
            ad = test["fonksiyon_adi"]
            if ad not in namespace or not callable(namespace[ad]):
                return False, test.get(
                    "hata_mesaji", f"'{ad}' adında çağrılabilir bir fonksiyon bulunamadı."
                )
            argumanlar = test.get("argumanlar", [])
            sonuc = namespace[ad](*argumanlar)
            if deger_karsilastir(sonuc, test["beklenen"], tolerans):
                return True, ""
            return False, test.get(
                "hata_mesaji",
                f"'{ad}' fonksiyonu beklenen değeri döndürmedi. Beklenen: {test['beklenen']}, alınan: {sonuc}",
            )

        return False, f"Bilinmeyen test tipi: {tip}"

    except GirdiTukendi as e:
        return False, str(e)
    except Exception as e:  # noqa: BLE001 — öğrenci kodundaki her türlü hatayı yakalamalı
        return False, f"Çalıştırma hatası: {type(e).__name__}: {e}"


# ----------------------------------------------------------------------------
# Arayüzün (app.js) çağırdığı üst düzey fonksiyonlar
# ----------------------------------------------------------------------------

def calistir(kod: str, girdiler=None):
    """'Çalıştır' düğmesi: kodu çalıştırır, çıktıyı veya hata metnini döndürür.
    Dönüş sözlüğü: {ok, stdout, hata}."""
    try:
        stdout, _ = kodu_calistir(kod, girdiler)
        return {"ok": True, "stdout": stdout, "hata": ""}
    except GirdiTukendi as e:
        return {"ok": False, "stdout": "", "hata": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "stdout": "", "hata": f"{type(e).__name__}: {e}"}


def puanla(kod: str, testler):
    """'Gönder' düğmesi: tüm testleri koşturur; ağırlıklı puan oranını ve test
    bazlı geri bildirimi döndürür.
    Dönüş: {oran (0..1), sonuclar: [{tip, gecti, mesaj, agirlik}, ...]}."""
    sonuclar = []
    kazanilan = 0.0
    for test in testler:
        gecti, mesaj = test_calistir(test, kod)
        agirlik = test.get("agirlik", 0)
        if gecti:
            kazanilan += agirlik
        sonuclar.append(
            {
                "tip": test.get("tip"),
                "gecti": bool(gecti),
                "mesaj": mesaj,
                "agirlik": agirlik,
            }
        )
    return {"oran": kazanilan, "sonuclar": sonuclar}


# JSON köprüsü — Pyodide'den çağırmak en güvenlisi JSON string alışverişi yapmak.
def calistir_json(kod: str, girdiler_json: str) -> str:
    girdiler = json.loads(girdiler_json) if girdiler_json else []
    return json.dumps(calistir(kod, girdiler))


def puanla_json(kod: str, testler_json: str) -> str:
    testler = json.loads(testler_json)
    return json.dumps(puanla(kod, testler))
