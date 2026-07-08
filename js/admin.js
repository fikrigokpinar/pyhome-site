/* PyHome — Yönetici paneli uygulama mantığı (Faz 4)
 *
 * admin.html'in DOM'unu window.ADMIN (admin_katman.js) ile besler. Sekmeler:
 * Ödevler, Gruplar, Öğrenciler, Gönderimler, Rapor. Her sekme kendi verisini ilk
 * açılışta (veya "Yenile"ye basınca) çeker; ağır sayfa yükü yerine sekme-tembel yükleme.
 */
(function () {
  "use strict";

  const $ = (sel, kok) => (kok || document).querySelector(sel);
  const $$ = (sel, kok) => Array.from((kok || document).querySelectorAll(sel));

  // Sekme başına önbellek (tekrar sekme değiştirince yeniden çekmemek için)
  const onbellek = { odevler: null, gruplar: null, ogrenciler: null, gonderimler: null };

  // -----------------------------------------------------------------------
  // Yardımcılar
  // -----------------------------------------------------------------------

  function durumYaz(id, metin, tip) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = metin || "";
    el.className = "yon-durum" + (tip ? " " + tip : "");
  }

  function kacis(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ISO zaman damgası -> <input type="datetime-local"> değeri (yerel saat)
  function isoToLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // <input type="datetime-local"> değeri -> ISO (boşsa null = süre sınırsız)
  function localInputToIso(val) {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d)) return null;
    return d.toISOString();
  }

  function tarihGoster(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function oranSinifi(oran) {
    if (oran >= 1) return "tam";
    if (oran <= 0) return "sifir";
    return "kismi";
  }

  function odevEtiket(odevNo, versiyon) {
    return `Ödev ${odevNo} (v${versiyon})`;
  }

  async function calistir(fn, durumId, basariMetin) {
    try {
      await fn();
      if (durumId && basariMetin) durumYaz(durumId, basariMetin, "ok");
    } catch (e) {
      if (durumId) durumYaz(durumId, e.message || String(e), "hata");
      else alert(e.message || String(e));
      throw e;
    }
  }

  // -----------------------------------------------------------------------
  // Giriş / oturum
  // -----------------------------------------------------------------------

  async function girisBaslat() {
    const form = $("#giris-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const eposta = $("#giris-eposta").value.trim();
      const sifre = $("#giris-sifre").value;
      const btn = $("#giris-btn");
      btn.disabled = true;
      durumYaz("giris-durum", "Giriş yapılıyor…");
      const sonuc = await window.ADMIN.giris(eposta, sifre);
      btn.disabled = false;
      if (!sonuc.ok) {
        durumYaz("giris-durum", sonuc.hata, "hata");
        return;
      }
      panelAc();
    });

    $("#btn-cikis").addEventListener("click", async () => {
      await window.ADMIN.cikis();
      location.reload();
    });
  }

  async function panelAc() {
    $("#giris").classList.add("gizli");
    $("#panel").classList.remove("gizli");
    try {
      const profil = await window.ADMIN.adminProfil();
      $("#kullanici-ad").textContent = profil && profil.ad ? profil.ad : "Yönetici";
    } catch (_) {
      $("#kullanici-ad").textContent = "Yönetici";
    }
    await odevleriYukle();
  }

  async function baslangicKontrol() {
    if (!window.ADMIN.yapilandirilmisMi()) {
      durumYaz("giris-durum", "Supabase yapılandırılmamış (site/js/supabase_config.js). Bkz. supabase/KURULUM.md.", "hata");
      return;
    }
    const oturumVar = await window.ADMIN.oturum();
    if (oturumVar) {
      const admin = await window.ADMIN.yoneticiMi ? await window.ADMIN.yoneticiMi() : true;
      if (admin) {
        panelAc();
        return;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sekmeler
  // -----------------------------------------------------------------------

  function sekmeleriBaslat() {
    $$(".yon-sekme").forEach((btn) => {
      btn.addEventListener("click", () => sekmeAc(btn.dataset.sekme));
    });
  }

  function sekmeAc(ad) {
    $$(".yon-sekme").forEach((b) => b.classList.toggle("aktif", b.dataset.sekme === ad));
    $$(".yon-panel").forEach((p) => p.classList.toggle("aktif", p.dataset.panel === ad));
    if (ad === "odevler" && !onbellek.odevler) odevleriYukle();
    if (ad === "gruplar" && !onbellek.gruplar) gruplariYukle();
    if (ad === "ogrenciler" && !onbellek.ogrenciler) ogrencileriYukle();
    if (ad === "gonderimler" && !onbellek.gonderimler) gonderimleriYukle();
    if (ad === "rapor") raporGoster(); // her açılışta önbellekten yeniden hesaplanır (ucuz)
  }

  // -----------------------------------------------------------------------
  // Ödevler
  // -----------------------------------------------------------------------

  async function odevleriYukle() {
    durumYaz("odevler-durum", "Yükleniyor…");
    try {
      const liste = await window.ADMIN.odevleriListele();
      onbellek.odevler = liste;
      odevleriCiz(liste);
      durumYaz("odevler-durum", "");
      gruplarSecenekleriDoldur();
      filtreSecenekleriDoldur();
    } catch (e) {
      durumYaz("odevler-durum", e.message, "hata");
    }
  }

  function odevleriCiz(liste) {
    const govde = $("#odevler-tablo tbody");
    if (!liste.length) {
      govde.innerHTML = '<tr><td colspan="7" class="yon-bos">Henüz ödev yok (bank verisi Supabase\'e yüklenmemiş olabilir).</td></tr>';
      return;
    }
    govde.innerHTML = liste
      .map(
        (o) => `
      <tr data-id="${o.id}">
        <td>Ödev ${o.odev_no}</td>
        <td>v${o.versiyon}</td>
        <td class="yon-genis">${kacis(o.baslik)}</td>
        <td><input type="checkbox" class="f-aktif" ${o.aktif ? "checked" : ""} /></td>
        <td><input type="datetime-local" class="f-deadline" value="${isoToLocalInput(o.deadline)}" /></td>
        <td><input type="number" class="f-deneme" min="1" value="${o.deneme_limiti}" /></td>
        <td><button class="yon-btn-kucuk btn-odev-kaydet">Kaydet</button></td>
      </tr>`
      )
      .join("");

    $$(".btn-odev-kaydet", govde).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const id = Number(tr.dataset.id);
        const aktif = $(".f-aktif", tr).checked;
        const deadline = localInputToIso($(".f-deadline", tr).value);
        const denemeLimiti = Number($(".f-deneme", tr).value);
        if (!(denemeLimiti > 0)) {
          durumYaz("odevler-durum", "Deneme limiti 0'dan büyük olmalı.", "hata");
          return;
        }
        btn.disabled = true;
        await calistir(
          async () => {
            await window.ADMIN.odevGuncelle(id, { aktif, deadline, deneme_limiti: denemeLimiti });
            const kayit = onbellek.odevler.find((o) => o.id === id);
            if (kayit) Object.assign(kayit, { aktif, deadline, deneme_limiti: denemeLimiti });
          },
          "odevler-durum",
          "Kaydedildi."
        ).catch(() => {});
        btn.disabled = false;
      });
    });
  }

  // -----------------------------------------------------------------------
  // Gruplar
  // -----------------------------------------------------------------------

  function gruplarSecenekleriDoldur() {
    const odevSelect = $("#grup-odev");
    if (!odevSelect || !onbellek.odevler) return;
    const odevNolar = Array.from(new Set(onbellek.odevler.map((o) => o.odev_no))).sort((a, b) => a - b);
    const secili = odevSelect.value;
    odevSelect.innerHTML = odevNolar.map((n) => `<option value="${n}">Ödev ${n}</option>`).join("");
    if (odevNolar.includes(Number(secili))) odevSelect.value = secili;
    versiyonSecenekleriDoldur();
  }

  function versiyonSecenekleriDoldur() {
    const odevSelect = $("#grup-odev");
    const versiyonSelect = $("#grup-versiyon");
    if (!odevSelect || !versiyonSelect || !onbellek.odevler) return;
    const odevNo = Number(odevSelect.value);
    const versiyonlar = onbellek.odevler
      .filter((o) => o.odev_no === odevNo)
      .map((o) => o.versiyon)
      .sort((a, b) => a - b);
    versiyonSelect.innerHTML = versiyonlar.map((v) => `<option value="${v}">Versiyon ${v}</option>`).join("");
  }

  async function gruplariYukle() {
    durumYaz("gruplar-durum", "Yükleniyor…");
    try {
      const liste = await window.ADMIN.gruplariListele();
      onbellek.gruplar = liste;
      gruplariCiz(liste);
      durumYaz("gruplar-durum", "");
    } catch (e) {
      durumYaz("gruplar-durum", e.message, "hata");
    }
  }

  function gruplariCiz(liste) {
    const govde = $("#gruplar-tablo tbody");
    if (!liste.length) {
      govde.innerHTML = '<tr><td colspan="4" class="yon-bos">Henüz atama yok.</td></tr>';
      return;
    }
    govde.innerHTML = liste
      .map(
        (g) => `
      <tr data-grup="${kacis(g.grup)}" data-odev="${g.odev_no}">
        <td>${kacis(g.grup)}</td>
        <td>Ödev ${g.odev_no}</td>
        <td>v${g.versiyon}</td>
        <td><button class="yon-btn-kucuk tehlike btn-grup-sil">Sil</button></td>
      </tr>`
      )
      .join("");

    $$(".btn-grup-sil", govde).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const grup = tr.dataset.grup;
        const odevNo = Number(tr.dataset.odev);
        if (!confirm(`${grup} grubunun Ödev ${odevNo} ataması silinsin mi?`)) return;
        btn.disabled = true;
        await calistir(
          async () => {
            await window.ADMIN.grupSil(grup, odevNo);
            onbellek.gruplar = onbellek.gruplar.filter((g) => !(g.grup === grup && g.odev_no === odevNo));
            gruplariCiz(onbellek.gruplar);
          },
          "gruplar-durum",
          "Silindi."
        ).catch(() => {
          btn.disabled = false;
        });
      });
    });
  }

  function grupFormBaslat() {
    $("#grup-odev").addEventListener("change", versiyonSecenekleriDoldur);
    $("#grup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const grup = $("#grup-grup").value.trim();
      const odevNo = Number($("#grup-odev").value);
      const versiyon = Number($("#grup-versiyon").value);
      if (!grup) return;
      await calistir(
        async () => {
          await window.ADMIN.grupAta(grup, odevNo, versiyon);
          await gruplariYukle();
          $("#grup-grup").value = "";
        },
        "gruplar-durum",
        "Atandı."
      ).catch(() => {});
    });
  }

  // -----------------------------------------------------------------------
  // Öğrenciler
  // -----------------------------------------------------------------------

  async function ogrencileriYukle() {
    durumYaz("ogrenciler-durum", "Yükleniyor…");
    try {
      const liste = await window.ADMIN.ogrencileriListele();
      onbellek.ogrenciler = liste;
      ogrencileriCiz(liste);
      durumYaz("ogrenciler-durum", "");
    } catch (e) {
      durumYaz("ogrenciler-durum", e.message, "hata");
    }
  }

  function ogrencileriCiz(liste) {
    const govde = $("#ogrenciler-tablo tbody");
    if (!liste.length) {
      govde.innerHTML = '<tr><td colspan="5" class="yon-bos">Henüz öğrenci yok.</td></tr>';
      return;
    }
    govde.innerHTML = liste
      .map(
        (o) => `
      <tr data-id="${o.id}">
        <td>${kacis(o.okul_no)}</td>
        <td>${kacis(o.ad)}</td>
        <td><input type="text" class="f-grup" value="${kacis(o.grup)}" /> <button class="yon-btn-kucuk btn-grup-kaydet">Kaydet</button></td>
        <td><input type="text" class="f-pin yon-pin" placeholder="yeni PIN (en az 4)" /></td>
        <td><button class="yon-btn-kucuk btn-pin-sifirla">PIN sıfırla</button></td>
      </tr>`
      )
      .join("");

    $$(".btn-grup-kaydet", govde).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const id = tr.dataset.id;
        const grup = $(".f-grup", tr).value.trim();
        if (!grup) return;
        btn.disabled = true;
        await calistir(
          async () => {
            await window.ADMIN.ogrenciGrupGuncelle(id, grup);
            const kayit = onbellek.ogrenciler.find((o) => String(o.id) === id);
            if (kayit) kayit.grup = grup;
          },
          "ogrenciler-durum",
          "Grup güncellendi."
        ).catch(() => {});
        btn.disabled = false;
      });
    });

    $$(".btn-pin-sifirla", govde).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const okulNo = tr.children[0].textContent;
        const pinInput = $(".f-pin", tr);
        const yeniPin = pinInput.value.trim();
        if (yeniPin.length < 4) {
          durumYaz("ogrenciler-durum", "PIN en az 4 karakter olmalı.", "hata");
          return;
        }
        if (!confirm(`${okulNo} numaralı öğrencinin PIN'i sıfırlansın mı?`)) return;
        btn.disabled = true;
        await calistir(
          async () => {
            await window.ADMIN.pinSifirla(okulNo, yeniPin);
            pinInput.value = "";
          },
          "ogrenciler-durum",
          `${okulNo} için PIN sıfırlandı.`
        ).catch(() => {});
        btn.disabled = false;
      });
    });
  }

  function ogrenciAramaBaslat() {
    $("#ogrenci-ara").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!onbellek.ogrenciler) return;
      const filtreli = !q
        ? onbellek.ogrenciler
        : onbellek.ogrenciler.filter(
            (o) => o.okul_no.toLowerCase().includes(q) || o.ad.toLowerCase().includes(q)
          );
      ogrencileriCiz(filtreli);
    });
  }

  // -----------------------------------------------------------------------
  // Gönderimler
  // -----------------------------------------------------------------------

  function filtreSecenekleriDoldur() {
    if (!onbellek.odevler) return;
    const html = ['<option value="">Tüm ödevler</option>']
      .concat(onbellek.odevler.map((o) => `<option value="${o.id}">${odevEtiket(o.odev_no, o.versiyon)} — ${kacis(o.baslik)}</option>`))
      .join("");
    const s1 = $("#gonderim-odev-filtre");
    const s2 = $("#rapor-odev-filtre");
    if (s1) s1.innerHTML = html;
    if (s2) s2.innerHTML = html;
  }

  async function gonderimleriYukle() {
    durumYaz("gonderimler-durum", "Yükleniyor…");
    try {
      const liste = await window.ADMIN.gonderimleriListele();
      onbellek.gonderimler = liste;
      gonderimleriUygula();
      durumYaz("gonderimler-durum", liste.length >= 5000 ? "İlk 5000 gönderim gösteriliyor (üst sınır)." : "");
    } catch (e) {
      durumYaz("gonderimler-durum", e.message, "hata");
    }
  }

  function gonderimleriUygula() {
    if (!onbellek.gonderimler) return;
    const odevFiltre = $("#gonderim-odev-filtre").value;
    const ogrFiltre = $("#gonderim-ogrenci-filtre").value.trim().toLowerCase();
    let liste = onbellek.gonderimler;
    if (odevFiltre) {
      liste = liste.filter((s) => s.questions && String(s.questions.assignment_id) === odevFiltre);
    }
    if (ogrFiltre) {
      liste = liste.filter((s) => s.students && s.students.okul_no.toLowerCase().includes(ogrFiltre));
    }
    gonderimleriCiz(liste);
  }

  function gonderimleriCiz(liste) {
    const govde = $("#gonderimler-tablo tbody");
    if (!liste.length) {
      govde.innerHTML = '<tr><td colspan="8" class="yon-bos">Kayıt bulunamadı.</td></tr>';
      return;
    }
    govde.innerHTML = liste
      .map((s, i) => {
        const ogr = s.students || {};
        const soru = s.questions || {};
        const odev = soru.assignments || {};
        const yuzde = Math.round((Number(s.oran) || 0) * 100);
        return `
      <tr data-idx="${i}">
        <td>${tarihGoster(s.created_at)}</td>
        <td>${kacis(ogr.okul_no)} — ${kacis(ogr.ad)}</td>
        <td>${kacis(ogr.grup)}</td>
        <td>${odev.odev_no ? odevEtiket(odev.odev_no, odev.versiyon) : "—"}</td>
        <td>${kacis(soru.soru_id)} (${soru.sira != null ? "s" + soru.sira : "?"})</td>
        <td>${s.deneme_no}</td>
        <td><span class="yon-oran ${oranSinifi(s.oran)}">%${yuzde}</span></td>
        <td><button class="yon-btn-kucuk btn-kod-gor">Kod/Çıktı</button></td>
      </tr>`;
      })
      .join("");

    $$(".btn-kod-gor", govde).forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.closest("tr").dataset.idx);
        kodModalAc(liste[idx]);
      });
    });
  }

  function kodModalAc(kayit) {
    const ogr = kayit.students || {};
    const soru = kayit.questions || {};
    const odev = soru.assignments || {};
    $("#kod-modal-baslik").textContent =
      `${ogr.okul_no || "?"} — ${odev.odev_no ? odevEtiket(odev.odev_no, odev.versiyon) : ""} / ${soru.soru_id || "?"} (deneme ${kayit.deneme_no}, %${Math.round((kayit.oran || 0) * 100)})`;
    $("#kod-modal-kod").textContent = kayit.kod || "(boş)";
    $("#kod-modal-cikti").textContent = kayit.cikti || "(boş)";
    $("#kod-modal").classList.remove("gizli");
  }

  function modalBaslat() {
    $("#kod-modal-kapat").addEventListener("click", () => $("#kod-modal").classList.add("gizli"));
    $("#kod-modal").addEventListener("click", (e) => {
      if (e.target.id === "kod-modal") $("#kod-modal").classList.add("gizli");
    });
  }

  function gonderimFiltreBaslat() {
    $("#gonderim-odev-filtre").addEventListener("change", gonderimleriUygula);
    $("#gonderim-ogrenci-filtre").addEventListener("input", gonderimleriUygula);
  }

  // -----------------------------------------------------------------------
  // Rapor — her öğrencinin SON gönderimi puanlanan gönderim sayılır
  // -----------------------------------------------------------------------

  // submissions listesinden (question_id, student_id) başına en yüksek deneme_no'lu
  // kaydı seçer; bu, sistemin "son gönderim puanlanır" kuralıyla birebir aynıdır.
  function sonDenemeleriCikar(gonderimler) {
    const map = new Map(); // key: question_id|student_id -> kayıt
    (gonderimler || []).forEach((s) => {
      const key = s.question_id + "|" + s.student_id;
      const mevcut = map.get(key);
      if (!mevcut || s.deneme_no > mevcut.deneme_no) map.set(key, s);
    });
    return Array.from(map.values());
  }

  function raporHesapla(gonderimler, odevFiltre) {
    let liste = sonDenemeleriCikar(gonderimler);
    if (odevFiltre) liste = liste.filter((s) => s.questions && String(s.questions.assignment_id) === odevFiltre);

    const gruplar = new Map(); // question_id -> {soru, odev, kayitlar: []}
    liste.forEach((s) => {
      const soru = s.questions || {};
      if (!gruplar.has(s.question_id)) gruplar.set(s.question_id, { soru, odev: soru.assignments || {}, kayitlar: [] });
      gruplar.get(s.question_id).kayitlar.push(s);
    });

    const satirlar = [];
    gruplar.forEach((g) => {
      const n = g.kayitlar.length;
      const ortalamaOran = g.kayitlar.reduce((t, s) => t + (Number(s.oran) || 0), 0) / n;
      const tamPuan = g.kayitlar.filter((s) => Number(s.oran) >= 1).length;
      const sifirPuan = g.kayitlar.filter((s) => Number(s.oran) <= 0).length;
      satirlar.push({
        odevNo: g.odev.odev_no,
        versiyon: g.odev.versiyon,
        baslik: g.odev.baslik,
        soruId: g.soru.soru_id,
        sira: g.soru.sira,
        gonderenSayisi: n,
        ortalamaYuzde: Math.round(ortalamaOran * 100),
        tamPuanYuzde: Math.round((tamPuan / n) * 100),
        sifirPuanYuzde: Math.round((sifirPuan / n) * 100),
      });
    });

    satirlar.sort((a, b) => (a.odevNo - b.odevNo) || (a.versiyon - b.versiyon) || (a.sira - b.sira));
    return satirlar;
  }

  async function raporGoster() {
    if (!onbellek.gonderimler) {
      durumYaz("rapor-durum", "Yükleniyor…");
      try {
        onbellek.gonderimler = await window.ADMIN.gonderimleriListele();
      } catch (e) {
        durumYaz("rapor-durum", e.message, "hata");
        return;
      }
    }
    const odevFiltre = $("#rapor-odev-filtre").value;
    const satirlar = raporHesapla(onbellek.gonderimler, odevFiltre);
    raporCiz(satirlar);
    durumYaz("rapor-durum", satirlar.length ? "" : "Bu ödev için henüz gönderim yok.");
  }

  function raporCiz(satirlar) {
    const govde = $("#rapor-tablo tbody");
    if (!satirlar.length) {
      govde.innerHTML = '<tr><td colspan="6" class="yon-bos">Kayıt yok.</td></tr>';
      return;
    }
    govde.innerHTML = satirlar
      .map(
        (r) => `
      <tr>
        <td>${odevEtiket(r.odevNo, r.versiyon)} — ${kacis(r.baslik)}</td>
        <td>${kacis(r.soruId)} (s${r.sira})</td>
        <td>${r.gonderenSayisi}</td>
        <td><span class="yon-oran ${oranSinifi(r.ortalamaYuzde / 100)}">%${r.ortalamaYuzde}</span></td>
        <td>%${r.tamPuanYuzde}</td>
        <td>%${r.sifirPuanYuzde}</td>
      </tr>`
      )
      .join("");
  }

  function raporFiltreBaslat() {
    $("#rapor-odev-filtre").addEventListener("change", raporGoster);
  }

  // -----------------------------------------------------------------------
  // Excel çıktısı (SheetJS) — Gönderimler + Rapor sayfaları
  // -----------------------------------------------------------------------

  async function excelIndir() {
    if (!window.XLSX) {
      durumYaz("rapor-durum", "Excel kütüphanesi yüklenemedi (CDN engelli olabilir).", "hata");
      return;
    }
    if (!onbellek.gonderimler) {
      try {
        onbellek.gonderimler = await window.ADMIN.gonderimleriListele();
      } catch (e) {
        durumYaz("rapor-durum", e.message, "hata");
        return;
      }
    }

    const odevFiltre = $("#rapor-odev-filtre").value;
    const gonderimSatirlari = onbellek.gonderimler
      .filter((s) => !odevFiltre || (s.questions && String(s.questions.assignment_id) === odevFiltre))
      .map((s) => {
        const ogr = s.students || {};
        const soru = s.questions || {};
        const odev = soru.assignments || {};
        return {
          Tarih: tarihGoster(s.created_at),
          "Okul No": ogr.okul_no || "",
          Ad: ogr.ad || "",
          Grup: ogr.grup || "",
          Ödev: odev.odev_no || "",
          Versiyon: odev.versiyon || "",
          Soru: soru.soru_id || "",
          Deneme: s.deneme_no,
          "Puan (%)": Math.round((Number(s.oran) || 0) * 100),
        };
      });

    const raporSatirlari = raporHesapla(onbellek.gonderimler, odevFiltre).map((r) => ({
      Ödev: `Ödev ${r.odevNo} (v${r.versiyon})`,
      Başlık: r.baslik,
      Soru: r.soruId,
      "Gönderen Öğrenci": r.gonderenSayisi,
      "Ortalama Puan (%)": r.ortalamaYuzde,
      "Tam Puan (%)": r.tamPuanYuzde,
      "Sıfır Puan (%)": r.sifirPuanYuzde,
    }));

    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(raporSatirlari), "Rapor");
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(gonderimSatirlari), "Gönderimler");

    const tarih = new Date().toISOString().slice(0, 10);
    window.XLSX.writeFile(wb, `pyhome_rapor_${tarih}.xlsx`);
  }

  // -----------------------------------------------------------------------
  // Başlangıç
  // -----------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    girisBaslat();
    sekmeleriBaslat();
    grupFormBaslat();
    ogrenciAramaBaslat();
    gonderimFiltreBaslat();
    raporFiltreBaslat();
    modalBaslat();

    $("#btn-odev-yenile").addEventListener("click", odevleriYukle);
    $("#btn-grup-yenile").addEventListener("click", gruplariYukle);
    $("#btn-ogrenci-yenile").addEventListener("click", ogrencileriYukle);
    $("#btn-gonderim-yenile").addEventListener("click", gonderimleriYukle);
    $("#btn-rapor-yenile").addEventListener("click", () => {
      onbellek.gonderimler = null;
      raporGoster();
    });
    $("#btn-excel").addEventListener("click", excelIndir);

    baslangicKontrol();
  });
})();
