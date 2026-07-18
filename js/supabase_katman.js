/* PyHome — Supabase veri/kimlik katmanı (Faz 3, Part 2)
 *
 * Arayüz (app.js) ile Supabase arasındaki tek köprü. Giriş (okul no + PIN), veriyi
 * RLS ile çekme, gonder() RPC ve çözüm getirme burada. Global `window.SB` sunar.
 *
 * Yapılandırma: site/js/supabase_config.js içinde window.SUPABASE_URL ve
 * window.SUPABASE_ANON tanımlı olmalı (bkz. supabase_config.ornek.js). anon anahtar
 * herkese açıktır — RLS güvenliği sağlar, sızması sakıncasızdır.
 *
 * Giriş mimarisi: e-posta = "<okulno>@okul.local", parola = PIN (Supabase Auth).
 * Çözümler/beklenen değerler koda gömülmez; RLS ile deadline öncesi çözüm inmez.
 */
(function () {
  "use strict";

  const EPOSTA_SONU = "@okul.local";
  let istemci = null;

  function yapilandirilmisMi() {
    return !!(
      window.SUPABASE_URL &&
      window.SUPABASE_ANON &&
      !/BURAYA|<.*>/.test(window.SUPABASE_URL)
    );
  }

  function istemciAl() {
    if (!istemci) {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error("Supabase kütüphanesi yüklenemedi (CDN engelli olabilir).");
      }
      istemci = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);
    }
    return istemci;
  }

  function eposta(okulNo) {
    return String(okulNo).trim() + EPOSTA_SONU;
  }

  function cevirHata(m) {
    m = String(m || "");
    if (/invalid login credentials/i.test(m)) return "Okul numarası veya PIN hatalı.";
    if (/email not confirmed/i.test(m)) return "Hesap henüz onaylanmamış (hocanıza bildirin).";
    if (/deneme hakk/i.test(m)) return m; // gonder() Türkçe mesajı
    if (/atanmam/i.test(m)) return "Bu ödev versiyonu grubunuza atanmamış.";
    if (/doldu/i.test(m)) return "Teslim süresi doldu.";
    if (/aktif değil/i.test(m)) return "Bu ödev şu an aktif değil.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sunucuya ulaşılamadı (internet?).";
    return m;
  }

  async function oturum() {
    const { data } = await istemciAl().auth.getSession();
    return data.session || null;
  }

  async function giris(okulNo, pin) {
    try {
      const { data, error } = await istemciAl().auth.signInWithPassword({
        email: eposta(okulNo),
        password: String(pin),
      });
      if (error) return { ok: false, hata: cevirHata(error.message) };
      return { ok: true, session: data.session };
    } catch (e) {
      return { ok: false, hata: cevirHata(e.message) };
    }
  }

  async function cikis() {
    try {
      await istemciAl().auth.signOut();
    } catch (_) {}
  }

  // Giriş yapan öğrencinin profili {okul_no, ad, grup} (RLS: yalnızca kendi satırı).
  async function profil() {
    const { data, error } = await istemciAl()
      .from("students")
      .select("okul_no, ad, grup")
      .maybeSingle();
    if (error) throw new Error(cevirHata(error.message));
    return data;
  }

  // Aktif ödev/soru/test verisini Supabase'ten çekip arayüzün beklediği yapıya çevirir.
  // RLS sayesinde yalnızca öğrencinin grubuna atanmış AKTİF versiyonlar döner.
  // Çözümler ve deadline sonrası bilgi burada İNMEZ (ayrı cozumGetir ile).
  async function veriYukle() {
    const sb = istemciAl();

    const { data: odevler, error: e1 } = await sb
      .from("assignments")
      .select("id, odev_no, versiyon, baslik, konular, deadline, deneme_limiti")
      .eq("aktif", true)
      .order("odev_no");
    if (e1) throw new Error(cevirHata(e1.message));

    const veri = {};
    if (!odevler || odevler.length === 0) return veri;

    const odevIds = odevler.map((o) => o.id);
    const { data: sorular, error: e2 } = await sb
      .from("questions")
      .select("id, assignment_id, soru_id, sira, metin_md, baslangic_kodu, puan, ipuclari, veri_dosyalari")
      .in("assignment_id", odevIds)
      .order("sira");
    if (e2) throw new Error(cevirHata(e2.message));

    const soruIds = (sorular || []).map((s) => s.id);

    let testler = [];
    let denemeMap = {};
    if (soruIds.length) {
      const [{ data: t, error: e3 }, { data: subs }] = await Promise.all([
        sb.from("tests").select("question_id, sira, test").in("question_id", soruIds).order("sira"),
        sb.from("submissions").select("question_id").in("question_id", soruIds),
      ]);
      if (e3) throw new Error(cevirHata(e3.message));
      testler = t || [];
      (subs || []).forEach((r) => {
        denemeMap[r.question_id] = (denemeMap[r.question_id] || 0) + 1;
      });
    }

    const testMap = {};
    testler.forEach((r) => {
      (testMap[r.question_id] = testMap[r.question_id] || []).push(r.test);
    });
    const soruMap = {};
    (sorular || []).forEach((s) => {
      (soruMap[s.assignment_id] = soruMap[s.assignment_id] || []).push(s);
    });

    odevler.forEach((o) => {
      const no2 = String(o.odev_no).padStart(2, "0");
      const anahtar = `odev${no2}_v${o.versiyon}`;
      const ss = (soruMap[o.id] || []).map((s) => ({
        id: s.soru_id,
        _dbId: s.id,
        metin_md: s.metin_md,
        baslangic_kodu: s.baslangic_kodu || "",
        puan: Number(s.puan),
        ipuclari: s.ipuclari || [],
        veri_dosyalari: s.veri_dosyalari || [],
        testler: testMap[s.id] || [],
        _denemeKullanilan: denemeMap[s.id] || 0,
      }));
      veri[anahtar] = {
        odev_id: `odev${no2}`,
        versiyon: o.versiyon,
        baslik: o.baslik,
        konular: o.konular || [],
        sorular: ss,
        _deadline: o.deadline,
        _deneme_limiti: o.deneme_limiti,
      };
    });
    return veri;
  }

  // Gönderim kaydı + deneme sayacı (sunucu tarafında). Dönüş: {deneme_no, kalan, limit, oran}.
  async function gonder(dbId, kod, cikti, oran) {
    const { data, error } = await istemciAl().rpc("gonder", {
      p_question_id: dbId,
      p_kod: kod,
      p_cikti: cikti || "",
      p_oran: oran,
    });
    if (error) throw new Error(cevirHata(error.message));
    return data;
  }

  // Çözüm (RLS: deadline geçmemişse null döner).
  async function cozumGetir(dbId) {
    const { data, error } = await istemciAl()
      .from("solutions")
      .select("kod, aciklama_md")
      .eq("question_id", dbId)
      .maybeSingle();
    if (error) throw new Error(cevirHata(error.message));
    return data;
  }

  window.SB = {
    yapilandirilmisMi,
    oturum,
    giris,
    cikis,
    profil,
    veriYukle,
    gonder,
    cozumGetir,
  };
})();
