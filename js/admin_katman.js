/* PyHome — Yönetici paneli Supabase köprüsü (Faz 4)
 *
 * admin.js ile Supabase arasındaki tek köprü. site/js/supabase_katman.js'in (öğrenci
 * arayüzü) admin karşılığı — kasıtlı olarak ayrı tutulur, iki rolün yetki/akışı farklı.
 *
 * Giriş: hocanın gerçek e-postası + parolası (Supabase Auth). Okul no + PIN DEĞİL —
 * o yalnızca öğrenci girişi (bkz. supabase/KURULUM.md "Yönetici hesabı"). Giriş sonrası
 * `yoneticiler` tablosunda kaydı olup olmadığı kontrol edilir; yoksa oturum kapatılır.
 *
 * Yetki modeli: RLS'te admin_mi() politikaları + 06_admin_yetki.sql'deki DML grantları
 * zaten her tabloyu yöneticiye açık tutuyor. Bu dosya yeni bir RLS/şema kuralı GETİRMEZ —
 * yalnızca var olan izinleri kullanan CRUD çağrıları içerir.
 *
 * Yapılandırma: site/js/supabase_config.js (öğrenci arayüzüyle aynı proje/anahtar).
 */
(function () {
  "use strict";

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

  function cevirHata(m) {
    m = String(m || "");
    if (/invalid login credentials/i.test(m)) return "E-posta veya parola hatalı.";
    if (/email not confirmed/i.test(m)) return "Hesap onaylanmamış.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sunucuya ulaşılamadı (internet?).";
    if (/PIN en az/i.test(m)) return m;
    if (/Yalnızca yönetici/i.test(m)) return "Bu işlem için yönetici yetkisi gerekir (oturumunuz düşmüş olabilir).";
    if (/Öğrenci bulunamadı/i.test(m)) return m;
    if (/row-level security/i.test(m)) return "Yetki hatası (RLS) — yönetici olarak giriş yaptığınızdan emin olun.";
    if (/duplicate key/i.test(m)) return "Bu kayıt zaten var.";
    return m;
  }

  // ---------------------------------------------------------------------------
  // Kimlik
  // ---------------------------------------------------------------------------

  async function oturum() {
    const { data } = await istemciAl().auth.getSession();
    return data.session || null;
  }

  async function yoneticiMi() {
    const { data, error } = await istemciAl().from("yoneticiler").select("id, ad").maybeSingle();
    if (error) return false;
    return !!data;
  }

  async function adminProfil() {
    const { data, error } = await istemciAl().from("yoneticiler").select("ad").maybeSingle();
    if (error) throw new Error(cevirHata(error.message));
    return data;
  }

  async function giris(eposta, sifre) {
    try {
      const { data, error } = await istemciAl().auth.signInWithPassword({
        email: String(eposta).trim(),
        password: String(sifre),
      });
      if (error) return { ok: false, hata: cevirHata(error.message) };
      const admin = await yoneticiMi();
      if (!admin) {
        await cikis();
        return { ok: false, hata: "Bu hesap yönetici olarak tanımlı değil (yoneticiler tablosuna eklenmemiş)." };
      }
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

  // ---------------------------------------------------------------------------
  // Ödevler (assignments) — admin_mi() sayesinde aktif=false olanlar da görünür
  // ---------------------------------------------------------------------------

  async function odevleriListele() {
    const { data, error } = await istemciAl()
      .from("assignments")
      .select("id, odev_no, versiyon, baslik, konular, aktif, deadline, deneme_limiti")
      .order("odev_no", { ascending: true })
      .order("versiyon", { ascending: true });
    if (error) throw new Error(cevirHata(error.message));
    return data || [];
  }

  async function odevGuncelle(id, alanlar) {
    const { error } = await istemciAl().from("assignments").update(alanlar).eq("id", id);
    if (error) throw new Error(cevirHata(error.message));
  }

  // ---------------------------------------------------------------------------
  // Grup → versiyon atamaları (group_versions)
  // ---------------------------------------------------------------------------

  async function gruplariListele() {
    const { data, error } = await istemciAl()
      .from("group_versions")
      .select("grup, odev_no, versiyon")
      .order("grup", { ascending: true })
      .order("odev_no", { ascending: true });
    if (error) throw new Error(cevirHata(error.message));
    return data || [];
  }

  async function grupAta(grup, odevNo, versiyon) {
    const { error } = await istemciAl()
      .from("group_versions")
      .upsert({ grup: String(grup).trim(), odev_no: odevNo, versiyon }, { onConflict: "grup,odev_no" });
    if (error) throw new Error(cevirHata(error.message));
  }

  async function grupSil(grup, odevNo) {
    const { error } = await istemciAl()
      .from("group_versions")
      .delete()
      .eq("grup", grup)
      .eq("odev_no", odevNo);
    if (error) throw new Error(cevirHata(error.message));
  }

  // ---------------------------------------------------------------------------
  // Öğrenciler (students) — ekleme yok (SQL Editor / ogrenci_ekle()); grup + PIN var
  // ---------------------------------------------------------------------------

  async function ogrencileriListele() {
    const { data, error } = await istemciAl()
      .from("students")
      .select("id, okul_no, ad, grup, created_at")
      .order("okul_no", { ascending: true });
    if (error) throw new Error(cevirHata(error.message));
    return data || [];
  }

  async function ogrenciGrupGuncelle(id, grup) {
    const { error } = await istemciAl().from("students").update({ grup: String(grup).trim() }).eq("id", id);
    if (error) throw new Error(cevirHata(error.message));
  }

  async function pinSifirla(okulNo, yeniPin) {
    const { error } = await istemciAl().rpc("pin_sifirla", { p_okul_no: okulNo, p_yeni_pin: yeniPin });
    if (error) throw new Error(cevirHata(error.message));
  }

  // ---------------------------------------------------------------------------
  // Gönderimler (submissions) — öğrenci/soru/ödev iç içe (embed) çekilir
  // ---------------------------------------------------------------------------

  const GONDERIM_LIMIT = 5000; // güvenlik/performans üst sınırı; sınıf ölçeğinde yeterli

  async function gonderimleriListele() {
    const { data, error } = await istemciAl()
      .from("submissions")
      .select(
        "id, kod, cikti, oran, deneme_no, created_at, student_id, question_id, " +
          "students(okul_no, ad, grup), " +
          "questions(soru_id, sira, puan, metin_md, assignment_id, assignments(odev_no, versiyon, baslik))"
      )
      .order("created_at", { ascending: false })
      .limit(GONDERIM_LIMIT);
    if (error) throw new Error(cevirHata(error.message));
    return data || [];
  }

  window.ADMIN = {
    yapilandirilmisMi,
    oturum,
    yoneticiMi,
    giris,
    cikis,
    adminProfil,
    odevleriListele,
    odevGuncelle,
    gruplariListele,
    grupAta,
    grupSil,
    ogrencileriListele,
    ogrenciGrupGuncelle,
    pinSifirla,
    gonderimleriListele,
  };
})();
