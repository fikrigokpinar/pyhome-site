/* PyHome — Öğrenci arayüzü uygulama mantığı (Faz 3, Part 2: Supabase'e bağlı)
 *
 * Akış: Supabase yapılandırması kontrol edilir -> giriş (okul no + PIN) -> veri
 * Supabase'ten RLS ile çekilir (yalnızca öğrencinin grubuna atanmış AKTİF versiyon;
 * çözümler deadline öncesi İNMEZ) -> Pyodide bir Web Worker'da yüklenir -> "Çalıştır"
 * yerelde çalışır, "Gönder" yerelde puanlar VE gonder() RPC ile kaydeder (deneme
 * sayacı sunucuda). Deadline sonrası "Çözümü göster" ile çözüm çekilir.
 *
 * Sonsuz döngü koruması (Faz 2): kod Web Worker'da çalışır; belirli sürede bitmezse
 * worker terminate edilip yeniden kurulur. Bu katman DEĞİŞMEDİ.
 */

(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const el = (s) => document.getElementById(s);

  // ---------- Ayarlar ----------
  const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/";
  const HAZIRLIK_ASIMI = 90000; // istek gönderildi -> hesaplama başladı (paket indirme dahil)
  const KOSU_ASIMI = 10000; // hesaplama başladı -> sonuç (aşılırsa sonsuz döngü sayılır)

  // ---------- Worker durumu (DEĞİŞMEDİ) ----------
  let worker = null;
  let workerHazir = false;
  let mesgul = false;
  let istekSayaci = 0;
  let bekleyen = null;
  let initResolve = null;
  let initReject = null;

  // ---------- Uygulama durumu ----------
  let editor = null;
  let veri = {};
  let odevAnahtar = null;
  let sorular = [];
  let aktif = 0;

  const ogrenciKod = {};
  const soruDurum = {};
  const acikIpucu = {};

  // ============================================================================
  // Worker katmanı (Faz 2'de doğrulandı — birebir korunuyor)
  // ============================================================================
  function durumAyarla(metin, sinif) {
    el("durum-metin").textContent = metin;
    const nokta = el("durum-nokta");
    nokta.className = "durum-nokta" + (sinif ? " " + sinif : "");
  }

  function dugmeleriKilitle(kilitli) {
    ["btn-calistir", "btn-gonder"].forEach((id) => {
      const b = el(id);
      if (b) b.disabled = kilitli;
    });
  }

  function workeriYarat() {
    if (!window.PYHOME_WORKER) throw new Error("Worker kaynağı (data/engine.js) yüklenemedi.");
    const blob = new Blob([window.PYHOME_WORKER], { type: "text/javascript" });
    const w = new Worker(URL.createObjectURL(blob));
    w.onmessage = mesajAl;
    w.onerror = (ev) => console.error("Worker hatası:", ev.message || ev);
    return w;
  }

  function workeriKur() {
    worker = workeriYarat();
    return new Promise((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
      worker.postMessage({ type: "init", pyodideUrl: PYODIDE_URL, motorSrc: window.PYHOME_MOTOR });
    });
  }

  function mesajAl(e) {
    const m = e.data || {};
    if (m.type === "hazir") {
      workerHazir = true;
      if (initResolve) { initResolve(); initResolve = initReject = null; }
      return;
    }
    if (m.type === "init_hata") {
      workerHazir = false;
      if (initReject) { initReject(new Error(m.hata || "Ortam başlatılamadı.")); initResolve = initReject = null; }
      return;
    }
    if (!bekleyen || m.id !== bekleyen.id) return;
    if (m.type === "paket") { durumAyarla("paketler yükleniyor…", ""); return; }
    if (m.type === "basladi") {
      clearTimeout(bekleyen.hazirlikTimer);
      bekleyen.kosuTimer = setTimeout(() => zamanAsimi("kosu"), KOSU_ASIMI);
      durumAyarla("çalışıyor…", "");
      return;
    }
    if (m.type === "sonuc") {
      const b = bekleyen; bekleyen = null;
      clearTimeout(b.hazirlikTimer); clearTimeout(b.kosuTimer);
      b.resolve(m.veri);
      return;
    }
    if (m.type === "hata") {
      const b = bekleyen; bekleyen = null;
      clearTimeout(b.hazirlikTimer); clearTimeout(b.kosuTimer);
      b.reject(new Error(m.hata || "Bilinmeyen worker hatası."));
      return;
    }
  }

  function istek(tip, yuk) {
    return new Promise((resolve, reject) => {
      const id = ++istekSayaci;
      bekleyen = {
        id, tip, resolve, reject,
        hazirlikTimer: setTimeout(() => zamanAsimi("hazirlik"), HAZIRLIK_ASIMI),
        kosuTimer: null,
      };
      worker.postMessage(Object.assign({ type: tip, id }, yuk));
    });
  }

  function zamanAsimi(faz) {
    const sn = (faz === "kosu" ? KOSU_ASIMI : HAZIRLIK_ASIMI) / 1000;
    const sebep =
      faz === "kosu"
        ? `Kodunuz ${sn} saniyede bitmedi — büyük olasılıkla sonsuz döngü (örn. koşulu hiç yanlış olmayan bir while) var. Döngü koşulunuzu kontrol edin.`
        : `Ortam ${sn} saniyede yanıt vermedi; yeniden başlatılıyor.`;
    workeriYenidenBaslat(sebep);
  }

  async function workeriYenidenBaslat(sebep) {
    workerHazir = false;
    dugmeleriKilitle(true);
    if (worker) { try { worker.terminate(); } catch (_) {} worker = null; }
    if (bekleyen) {
      const b = bekleyen; bekleyen = null;
      clearTimeout(b.hazirlikTimer); clearTimeout(b.kosuTimer);
      b.reject(new Error(sebep));
    }
    el("perde-metin").textContent = "Ortam yeniden başlatılıyor…";
    const acik = el("perde").querySelector(".aciklama");
    if (acik) acik.textContent = "Takılan kod durduruldu. Python ortamı yeniden hazırlanıyor.";
    el("perde").classList.remove("gizli");
    durumAyarla("yeniden başlatılıyor…", "");
    try {
      await workeriKur();
      durumAyarla("hazır", "hazir");
      el("perde").classList.add("gizli");
      dugmeleriKilitle(false);
    } catch (e) {
      durumAyarla("başlatma hatası", "hata");
      el("perde-metin").textContent = "Yeniden başlatma hatası: " + e.message;
    }
  }

  // ============================================================================
  // Ödev / soru arayüzü
  // ============================================================================
  function odevleriDoldur() {
    const sec = el("odev-secim");
    sec.innerHTML = "";
    const anahtarlar = Object.keys(veri).sort();
    for (const a of anahtarlar) {
      const o = veri[a];
      const no = parseInt(String(o.odev_id).replace(/\D/g, ""), 10) || o.odev_id;
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = `Ödev ${no}: ${o.baslik} (v${o.versiyon})`;
      sec.appendChild(opt);
    }
    sec.value = anahtarlar[0];
    odevAnahtar = anahtarlar[0];
    sec.onchange = () => odevSec(sec.value);
  }

  function odevSec(anahtar) {
    odevAnahtar = anahtar;
    sorular = veri[anahtar].sorular;
    aktif = 0;
    seridiCiz();
    soruyuGoster(0);
  }

  function seridiCiz() {
    const serit = el("soru-serit");
    serit.querySelectorAll(".soru-btn").forEach((n) => n.remove());
    sorular.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "soru-btn";
      const d = soruDurum[s.id];
      let imge = "";
      if (d && d.gonderildi) {
        if (d.oran >= 0.999) { b.classList.add("tamam"); imge = '<span class="imge">✓</span>'; }
        else if (d.oran > 0) { b.classList.add("kismi"); imge = '<span class="imge">◑</span>'; }
        else { imge = '<span class="imge">✗</span>'; }
      }
      if (i === aktif) b.classList.add("aktif");
      b.innerHTML = `${i + 1}${imge}`;
      b.title = s.metin_md.replace(/[*`#]/g, "").slice(0, 60);
      b.addEventListener("click", () => { kaydetAktifKod(); aktif = i; soruyuGoster(i); });
      serit.appendChild(b);
    });
  }

  function soruyuGoster(i) {
    const s = sorular[i];
    el("puan-rozet").textContent = `${s.puan} puan`;
    const konular = veri[odevAnahtar].konular || [];
    el("konu-rozetleri").innerHTML = konular.slice(0, 4).map((k) => `<span class="konu-rozet">${k}</span>`).join("");
    el("soru-baslik").textContent = `Soru ${i + 1}`;
    el("soru-metin").innerHTML = marked.parse(s.metin_md);

    ipuclariCiz(s);
    denemeRozetiCiz(s);
    cozumKutusuCiz(s);

    const kod = ogrenciKod[s.id] != null ? ogrenciKod[s.id] : s.baslangic_kodu;
    editor.setValue(kod);
    editor.clearHistory();

    el("konsol").innerHTML = '<span class="bos">Kodunuzu çalıştırınca çıktı burada görünür.</span>';
    sonucAlaniCiz(s);
    seridiCiz();
    sekmeSec("konsol");
  }

  function ipuclariCiz(s) {
    const kutu = el("ipucu-kutu");
    const ipuclari = s.ipuclari || [];
    if (ipuclari.length === 0) { kutu.innerHTML = ""; return; }
    const acik = acikIpucu[s.id] || 0;
    let html = '<div class="ipucu-baslik">İpuçları</div>';
    ipuclari.forEach((ip, idx) => { if (idx < acik) html += `<div class="ipucu">${marked.parseInline(ip)}</div>`; });
    if (acik < ipuclari.length) {
      const kalan = ipuclari.length - acik;
      html += `<button class="ipucu-ac" id="ipucu-ac">💡 İpucu göster (${kalan} ipucu kaldı)</button>`;
    }
    kutu.innerHTML = html;
    const btn = el("ipucu-ac");
    if (btn) btn.addEventListener("click", () => { acikIpucu[s.id] = (acikIpucu[s.id] || 0) + 1; ipuclariCiz(s); });
  }

  // Kalan deneme rozeti (soru başına)
  function denemeRozetiCiz(s) {
    const rozet = el("deneme-rozet");
    if (!rozet) return;
    const limit = veri[odevAnahtar]._deneme_limiti || 0;
    const kullanilan = s._denemeKullanilan || 0;
    const kalan = Math.max(0, limit - kullanilan);
    rozet.textContent = `Deneme: ${kalan}/${limit} kaldı`;
    rozet.className = "deneme-rozet" + (kalan === 0 ? " bitti" : "");
  }

  // Çözüm kutusu (deadline sonrası açılır)
  function cozumKutusuCiz(s) {
    const kutu = el("cozum-kutu");
    if (!kutu) return;
    kutu.innerHTML =
      '<button class="cozum-ac" id="btn-cozum">📖 Çözümü göster</button>' +
      '<div class="cozum-alan" id="cozum-alan"></div>';
    const btn = el("btn-cozum");
    if (btn) btn.addEventListener("click", () => cozumAc(s));
  }

  async function cozumAc(s) {
    const alan = el("cozum-alan");
    alan.innerHTML = '<span class="bos">Çözüm alınıyor…</span>';
    try {
      const c = await SB.cozumGetir(s._dbId);
      if (!c) {
        alan.innerHTML = '<div class="cozum-kilit">🔒 Çözüm, teslim süresi (deadline) geçtikten sonra açılır.</div>';
        return;
      }
      let html = `<pre class="cozum-kod">${kacisla(c.kod)}</pre>`;
      if (c.aciklama_md) html += `<div class="cozum-aciklama">${marked.parse(c.aciklama_md)}</div>`;
      alan.innerHTML = html;
    } catch (e) {
      alan.innerHTML = `<span class="hata">Çözüm alınamadı: ${kacisla(e.message || e)}</span>`;
    }
  }

  function sekmeSec(ad) {
    document.querySelectorAll(".sekme").forEach((t) => t.classList.toggle("aktif", t.dataset.sekme === ad));
    document.querySelectorAll(".sekme-icerik").forEach((c) => c.classList.toggle("aktif", c.dataset.icerik === ad));
  }
  document.querySelectorAll(".sekme").forEach((t) => t.addEventListener("click", () => sekmeSec(t.dataset.sekme)));

  function kaydetAktifKod() {
    if (!sorular[aktif]) return;
    ogrenciKod[sorular[aktif].id] = editor.getValue();
  }

  // ---------- Çalıştır (yerel) ----------
  async function calistir() {
    if (mesgul || !workerHazir) return;
    const kod = editor.getValue();
    kaydetAktifKod();
    const girdiMetni = el("girdiler").value;
    const girdiler = girdiMetni.split("\n").filter((x, i, arr) => !(x === "" && i === arr.length - 1));

    sekmeSec("konsol");
    el("konsol").innerHTML = '<span class="bos">Çalışıyor…</span>';
    mesgul = true; dugmeleriKilitle(true); durumAyarla("çalışıyor…", "");
    try {
      const dosyalar = (sorular[aktif] && sorular[aktif].veri_dosyalari) || [];
      const sonucStr = await istek("calistir", { kod, girdiler, dosyalar });
      const sonuc = JSON.parse(sonucStr);
      if (sonuc.ok) {
        el("konsol").innerHTML = sonuc.stdout.trim() === ""
          ? '<span class="bos">(çıktı yok — print() kullandınız mı?)</span>'
          : kacisla(sonuc.stdout);
      } else {
        let html = `<span class="hata">${kacisla(sonuc.hata)}</span>`;
        if (/fazla input\(\) istedi/.test(sonuc.hata || "")) {
          html += '\n\n<span class="bos">İpucu: Bu kod input() kullanıyor. "Girdiler" sekmesine, ' +
                  "her input() için bir satır olacak şekilde değerleri yazıp tekrar Çalıştır'a basın. " +
                  "(Gönder'de buna gerek yok — testler kendi girdilerini kullanır.)</span>";
        }
        el("konsol").innerHTML = html;
      }
    } catch (e) {
      el("konsol").innerHTML = `<span class="hata">${kacisla(e.message || String(e))}</span>`;
    } finally {
      mesgul = false;
      if (workerHazir) { dugmeleriKilitle(false); durumAyarla("hazır", "hazir"); }
    }
  }

  // ---------- Gönder (yerel puanla + Supabase kaydet) ----------
  async function gonder() {
    if (mesgul || !workerHazir) return;
    const s = sorular[aktif];
    const limit = veri[odevAnahtar]._deneme_limiti || 0;
    const kullanilan = s._denemeKullanilan || 0;
    if (kullanilan >= limit) {
      sekmeSec("sonuc");
      el("sonuc-alan").innerHTML = `<div class="bos-durum">Bu soru için deneme hakkınız bitti (${limit}/${limit}). Yeni gönderim kaydedilmez.</div>`;
      return;
    }

    const kod = editor.getValue();
    kaydetAktifKod();
    sekmeSec("sonuc");
    el("sonuc-alan").innerHTML = '<div class="bos-durum">Testler çalışıyor…</div>';
    mesgul = true; dugmeleriKilitle(true); durumAyarla("puanlanıyor…", "");

    let sonuc = null;
    try {
      const sonucStr = await istek("puanla", { kod, testler: s.testler, dosyalar: s.veri_dosyalari || [] });
      sonuc = JSON.parse(sonucStr);
    } catch (e) {
      el("sonuc-alan").innerHTML = `<div class="bos-durum">${kacisla(e.message || String(e))}</div>`;
      mesgul = false;
      if (workerHazir) { dugmeleriKilitle(false); durumAyarla("hazır", "hazir"); }
      return;
    }

    // Yerel puan gösterilir (anında geri bildirim)
    soruDurum[s.id] = { oran: sonuc.oran, gonderildi: true };
    sonucGoster(s, sonuc);
    seridiCiz();

    // Supabase'e kaydet (deneme sayacı sunucuda)
    durumAyarla("kaydediliyor…", "");
    try {
      const r = await SB.gonder(s._dbId, kod, "", sonuc.oran);
      s._denemeKullanilan = r.deneme_no; // sunucu doğrusu
      denemeRozetiCiz(s);
      gonderimNotu(`✓ Kaydedildi (deneme ${r.deneme_no}/${r.limit}, kalan ${r.kalan}).`, "ok");
    } catch (e) {
      // DB reddetti (limit/deadline/grup). Yerel puan görünür ama kaydedilmedi.
      gonderimNotu("⚠ Kaydedilemedi: " + (e.message || e), "uyari");
    } finally {
      mesgul = false;
      if (workerHazir) { dugmeleriKilitle(false); durumAyarla("hazır", "hazir"); }
    }
  }

  function gonderimNotu(metin, sinif) {
    const not = el("gonderim-notu");
    if (!not) return;
    not.textContent = metin;
    not.className = "gonderim-notu " + (sinif || "");
  }

  function sonucGoster(s, sonuc) {
    const puan = Math.round(sonuc.oran * s.puan * 100) / 100;
    const yuzde = Math.round(sonuc.oran * 100);
    let sinif = "sifir", baslik = "Testler geçilemedi";
    if (sonuc.oran >= 0.999) { sinif = "tam"; baslik = "Tüm testler geçti!"; }
    else if (sonuc.oran > 0) { sinif = "kismi"; baslik = "Kısmen doğru"; }

    let html = `<div class="sonuc-ozet ${sinif}">
      <span class="buyuk">${puan} / ${s.puan}</span>
      <span>puan · ${baslik} (%${yuzde})</span>
    </div>
    <div class="gonderim-notu" id="gonderim-notu"></div>`;

    sonuc.sonuclar.forEach((r, i) => {
      const gecti = r.gecti;
      html += `<div class="test-kart ${gecti ? "gecti" : "kaldi"}">
        <span class="imge">${gecti ? "✓" : "✗"}</span>
        <span class="icerik">
          <div>Test ${i + 1}${gecti ? " geçti" : " geçemedi"} <span class="test-tip">(${r.tip} · ağırlık ${r.agirlik})</span></div>
          ${!gecti && r.mesaj ? `<div>${kacisla(r.mesaj)}</div>` : ""}
        </span>
      </div>`;
    });

    el("sonuc-alan").innerHTML = html;
    const rozet = el("sonuc-rozet");
    rozet.style.display = "inline-block";
    rozet.textContent = `${puan}/${s.puan}`;
  }

  function sonucAlaniCiz(s) {
    const d = soruDurum[s.id];
    const rozet = el("sonuc-rozet");
    if (d && d.gonderildi) {
      rozet.style.display = "inline-block";
      rozet.textContent = `${Math.round(d.oran * s.puan * 100) / 100}/${s.puan}`;
    } else {
      rozet.style.display = "none";
      el("sonuc-alan").innerHTML =
        '<div class="bos-durum">Henüz gönderim yok.<br>Kodunuzu yazıp <strong>Gönder</strong>\'e basın; testler çalışır, puanınız kaydedilir.</div>';
    }
  }

  function sifirla() {
    const s = sorular[aktif];
    editor.setValue(s.baslangic_kodu);
    ogrenciKod[s.id] = s.baslangic_kodu;
    editor.focus();
  }

  function kacisla(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ============================================================================
  // Giriş / oturum
  // ============================================================================
  function girisDurum(metin, hata) {
    const d = el("giris-durum");
    if (d) { d.textContent = metin; d.className = "giris-durum" + (hata ? " hata" : ""); }
  }

  function girisEkraniGoster() {
    el("giris").classList.remove("gizli");
    el("perde").classList.add("gizli");
    const btn = el("giris-btn");
    const form = el("giris-form");
    const gonderFn = async (ev) => {
      if (ev) ev.preventDefault();
      const no = el("giris-okulno").value.trim();
      const pin = el("giris-pin").value;
      if (!no || !pin) { girisDurum("Okul numarası ve PIN gerekli.", true); return; }
      btn.disabled = true;
      girisDurum("Giriş yapılıyor…", false);
      const r = await SB.giris(no, pin);
      if (!r.ok) { girisDurum(r.hata, true); btn.disabled = false; return; }
      await basla();
    };
    if (form) form.onsubmit = gonderFn;
    if (btn) btn.onclick = gonderFn;
  }

  async function cikisYap() {
    await SB.cikis();
    location.reload();
  }

  // ============================================================================
  // Başlatma
  // ============================================================================
  async function basla() {
    el("giris").classList.add("gizli");
    el("perde").classList.remove("gizli");
    el("perde-metin").textContent = "Ödevler ve Python ortamı yükleniyor…";
    dugmeleriKilitle(true);
    try {
      const isler = [SB.veriYukle(), SB.profil().catch(() => null)];
      if (!workerHazir) isler.push(workeriKur());
      const [yeniVeri, prof] = await Promise.all(isler);
      veri = yeniVeri || {};

      if (prof) {
        el("kullanici-ad").textContent = `${prof.ad} · ${prof.grup}`;
        el("kullanici").classList.remove("gizli");
      }

      if (Object.keys(veri).length === 0) {
        el("perde-metin").textContent = "Şu an size atanmış aktif ödev yok.";
        const acik = el("perde").querySelector(".aciklama");
        if (acik) acik.textContent = "Hocanız bir ödevi aktifleştirip grubunuza versiyon atadığında burada görünecek.";
        return;
      }

      odevleriDoldur();
      odevSec(Object.keys(veri).sort()[0]);
      durumAyarla("hazır", "hazir");
      dugmeleriKilitle(false);
      el("perde").classList.add("gizli");
    } catch (e) {
      durumAyarla("yükleme hatası", "hata");
      el("perde-metin").textContent = "Yükleme hatası: " + (e.message || String(e));
      console.error(e);
    }
  }

  function arayuzKur() {
    editor = CodeMirror.fromTextArea(el("editor"), {
      mode: "python",
      theme: "material-darker",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      matchBrackets: true,
      extraKeys: {
        "Ctrl-Enter": calistir,
        "Cmd-Enter": calistir,
        Tab: (cm) => cm.replaceSelection("    "),
      },
    });
    el("btn-calistir").addEventListener("click", calistir);
    el("btn-gonder").addEventListener("click", gonder);
    el("btn-sifirla").addEventListener("click", sifirla);
    const cikisBtn = el("btn-cikis");
    if (cikisBtn) cikisBtn.addEventListener("click", cikisYap);
    dugmeleriKilitle(true);
    bolucuKur();
  }

  // ---------- Editör/konsol bölücüsü (sürükleyerek boyutlandırma) ----------
  function bolucuKur() {
    const bolucu = el("bolucu");
    const editorSar = document.querySelector(".editor-sar");
    const sag = document.querySelector(".sag");
    if (!bolucu || !editorSar || !sag) return;

    function uygula(px) {
      const ust = editorSar.getBoundingClientRect().top;
      const enFazla = sag.getBoundingClientRect().bottom - ust - 160; // konsola en az ~160px
      const h = Math.max(90, Math.min(px, enFazla));
      editorSar.style.flex = "0 0 auto";
      editorSar.style.height = h + "px";
      if (editor) editor.refresh();
      return h;
    }

    try {
      const kayitli = parseInt(localStorage.getItem("pyhome_editor_h"), 10);
      if (kayitli > 0) uygula(kayitli);
    } catch (_) {}

    window.addEventListener("resize", () => {
      const h = parseInt(editorSar.style.height, 10);
      if (h > 0) uygula(h); // pencere küçülünce konsol payını koru
    });

    bolucu.addEventListener("mousedown", (e) => {
      e.preventDefault();
      bolucu.classList.add("aktif");
      document.body.style.cursor = "row-resize";
      const ust = editorSar.getBoundingClientRect().top;
      function hareket(ev) { uygula(ev.clientY - ust); }
      function birak(ev) {
        document.removeEventListener("mousemove", hareket);
        document.removeEventListener("mouseup", birak);
        bolucu.classList.remove("aktif");
        document.body.style.cursor = "";
        const h = uygula(ev.clientY - ust);
        try { localStorage.setItem("pyhome_editor_h", String(h)); } catch (_) {}
      }
      document.addEventListener("mousemove", hareket);
      document.addEventListener("mouseup", birak);
    });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    if (!window.SB || !SB.yapilandirilmisMi()) {
      el("perde").classList.add("gizli");
      el("giris").classList.remove("gizli");
      girisDurum(
        "Supabase yapılandırması yok. site/js/supabase_config.js oluşturun (örnek: supabase_config.ornek.js · kılavuz: supabase/KURULUM.md).",
        true
      );
      const btn = el("giris-btn");
      if (btn) btn.disabled = true;
      return;
    }
    arayuzKur();
    let s = null;
    try { s = await SB.oturum(); } catch (_) {}
    if (s) await basla();
    else girisEkraniGoster();
  });
})();
