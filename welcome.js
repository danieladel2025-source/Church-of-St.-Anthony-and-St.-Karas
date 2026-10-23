/* =====================================================================
   welcome.js — صفحة الترحيب وتحديد هوية المستخدم
   ---------------------------------------------------------------------
   • الخادم: يكتب اسمه + السنة (المرحلة الدراسية) + بنين/بنات
             → تظهر له الفصول المطابقة فقط.
   • المشرف العام: يجيب "نعم" ثم يدخل البريد وكلمة المرور (نفس لوحة المشرفين)
             → يرى كل الفصول ويدخلها دون كلمة سر الفصل.
   • الاسم يُستخدم في سجل النشاط (افتقاد / حذف مخدوم).
   يُحمَّل بعد السكربت الرئيسي في index.html مباشرة.
   ===================================================================== */
(function () {
  'use strict';

  var PROFILE_KEY     = 'church_user_profile_v1';   // بيانات الخادم (تبقى على الجهاز)
  var ADMIN_KEY       = 'church_admin_session_v1';  // جلسة المشرف العام (sessionStorage فقط)
  var ADMIN_EMAIL_KEY = 'church_admin_email_v1';    // لتعبئة البريد تلقائياً (بدون كلمة المرور)
  var FORCE_KEY       = 'church_welcome_force_v1';  // لفتح صفحة الترحيب بعد "تغيير بياناتي"
  var CHAPTER_SESSION = 'absence_active_chapter_v1';
  var DEVICE_KEY      = 'church_device_id_v1';      // معرّف الجهاز (يربط البيانات بالسيرفر)
  var UNLOCK_KEY      = 'church_welcome_unlock_v1'; // تفويض مؤقت من المشرف العام لتعديل بيانات الخادم
  var START_TS = Date.now();

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, key, v) { try { store.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function $(id) { return document.getElementById(id); }

  /* ---------------------- الربط مع السيرفر (Supabase) ---------------------- */
  function deviceId() {
    var id = '';
    try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch (e) {}
    if (id.length < 16) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
         : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {}
    }
    return id;
  }
  function anonClient() {
    return (typeof _supabaseClient !== 'undefined' && _supabaseClient) ? _supabaseClient : null;
  }
  // عميل المشرف: تبقى جلسته في sessionStorage (خاصة بهذا التبويب فقط) ولا تُحفظ كلمة المرور
  var _adminSb = null;
  function adminClient() {
    if (_adminSb) return _adminSb;
    if (!(window.supabase && window.supabase.createClient) || typeof SUPABASE_URL === 'undefined') return null;
    _adminSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
              storage: window.sessionStorage, storageKey: 'wg-admin-auth' }
    });
    return _adminSb;
  }
  function missingFn(err) {
    return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find|does not exist|schema cache/i.test(err.message || ''));
  }

  /* ---------------------------- الحالة ---------------------------- */
  function stageValid(id) { return typeof STAGE_INDEX !== 'undefined' && !!STAGE_INDEX[id]; }
  function profileValid(p) {
    return !!p && typeof p.name === 'string' && p.name.trim().length >= 2 &&
           stageValid(p.stage) && (p.gender === 'boys' || p.gender === 'girls');
  }

  var profile = readJSON(localStorage, PROFILE_KEY);
  if (!profileValid(profile)) profile = null;
  var admin = readJSON(sessionStorage, ADMIN_KEY);
  if (!(admin && admin.email)) admin = null;

  var forceOpen = false;
  var unlocked = false;   // المشرف العام سمح بتعديل بيانات الخادم في هذه الجلسة
  try {
    forceOpen = sessionStorage.getItem(FORCE_KEY) === '1'; sessionStorage.removeItem(FORCE_KEY);
    unlocked = !!sessionStorage.getItem(UNLOCK_KEY);
  } catch (e) {}
  if (unlocked) forceOpen = true;
  // البيانات مقفلة: الخادم سجّلها مرة واحدة ولا تُعدَّل إلا بإذن المشرف العام
  function locked() { return !!profile && !unlocked; }

  var mode = 'servant';   // الوضع المختار داخل النموذج
  var gender = '';
  var el = null;

  function role() { return admin ? 'admin' : (profile ? 'servant' : ''); }
  function adminName() { return (admin && (admin.name || String(admin.email || '').split('@')[0])) || 'المشرف'; }
  function actor() {
    if (admin) return adminName() + ' (مشرف عام)';
    return profile ? profile.name : '';
  }
  function stageName() { return profile && stageValid(profile.stage) ? STAGE_INDEX[profile.stage].stage.name : ''; }
  function genderName() { return profile ? (profile.gender === 'girls' ? 'بنات' : 'بنين') : ''; }
  function summary() { return profile ? (stageName() + ' - ' + genderName()) : ''; }

  // هل الفصل مناسب للخادم الحالي؟ (المشرف العام يرى الكل)
  function chapterAllowed(id) {
    var r = role();
    if (r === 'admin') return true;
    if (r !== 'servant') return false;
    return _genderOf(id) === profile.gender && _stageOf(id) === profile.stage;
  }

  // هل ما زالت بيانات الفصول (المرحلة/الجنس) قيد التحميل من السحابة؟
  function isLoading() {
    if (Date.now() - START_TS > 20000) return false;
    if (typeof _supabaseClient === 'undefined' || !_supabaseClient) return false;
    if (typeof _statsPending !== 'undefined' && _statsPending.size) return true;
    return _chaptersCache.some(function (c) {
      var id = String(c.chapter_id), m = _chapterMeta[id];
      return !_genderOf(id) && !(m && m.gChecked);
    });
  }

  /* ---------------------------- التنسيق ---------------------------- */
  function injectCss() {
    if ($('wgStyles')) return;
    var st = document.createElement('style');
    st.id = 'wgStyles';
    st.textContent = [
      '#welcomeGate{position:fixed;inset:0;z-index:999999;overflow-y:auto;display:flex;justify-content:center;',
      ' padding:22px 14px calc(36px + env(safe-area-inset-bottom,0px));direction:rtl;font-family:"Cairo",sans-serif;',
      ' background:radial-gradient(circle at 30% 10%,#1f2a3a 0%,#0d1117 60%);transition:opacity .3s,visibility .3s}',
      '#welcomeGate.wg-hide{opacity:0;visibility:hidden;pointer-events:none}',
      '#welcomeGate [hidden]{display:none !important}',
      '#welcomeGate .wg-card{background:var(--paper,#f5f0e8);width:100%;max-width:460px;margin:auto;border-radius:18px;',
      ' padding:26px 20px 24px;box-shadow:0 20px 60px rgba(0,0,0,.5);border-top:5px solid var(--gold,#d4a017)}',
      '#welcomeGate .wg-icon{font-size:46px;text-align:center;line-height:1}',
      '#welcomeGate .wg-warn{background:#fff7e0;color:#7a5600;border:1px solid #f0cf72;border-radius:10px;',
      ' padding:10px 12px;font-size:12.5px;font-weight:700;line-height:1.7;margin-top:14px}',
      '#welcomeGate .wg-warn.lock{background:#fde8e6;color:#8f2a20;border-color:#f3b3ac}',
      '#welcomeGate .wg-warn.adm{background:#e6f4ea;color:#17613a;border-color:#a8d9b9}',
      '#welcomeGate input:disabled,#welcomeGate select:disabled{background:#eee;color:#555;cursor:not-allowed}',
      '#welcomeGate .wg-seg button:disabled{cursor:not-allowed;opacity:.75}',
      '#welcomeGate .wg-cancel{display:block;width:100%;margin-top:10px;padding:11px;border:2px solid var(--line,#b5a98a);',
      ' border-radius:10px;background:transparent;color:#555;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer}',
      '#welcomeGate h1{font-size:22px;font-weight:900;text-align:center;color:var(--ink,#0d1117);margin:8px 0 4px}',
      '#welcomeGate .wg-sub{font-size:13px;text-align:center;color:#666;margin-bottom:18px;line-height:1.7}',
      '#welcomeGate .wg-q{font-size:14px;font-weight:900;color:var(--ink,#0d1117);margin-bottom:8px}',
      '#welcomeGate label{display:block;font-size:13px;font-weight:700;color:#444;margin:14px 0 6px}',
      '#welcomeGate input,#welcomeGate select{width:100%;padding:12px 14px;border:2px solid var(--line,#b5a98a);',
      ' border-radius:10px;font-family:inherit;font-size:16px;background:#fff;color:var(--ink,#0d1117);outline:none}',
      '#welcomeGate input:focus,#welcomeGate select:focus{border-color:var(--accent2,#2980b9)}',
      '#welcomeGate .wg-seg{display:flex;gap:10px}',
      '#welcomeGate .wg-seg button{flex:1;padding:12px 8px;border:2px solid var(--line,#b5a98a);border-radius:10px;',
      ' background:#fff;color:var(--ink,#0d1117);font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}',
      '#welcomeGate .wg-seg button.sel{color:#fff;background:var(--ink,#0d1117);border-color:var(--ink,#0d1117)}',
      '#welcomeGate .wg-seg button.sel[data-m="admin"]{background:var(--accent,#c8392b);border-color:var(--accent,#c8392b)}',
      '#welcomeGate .wg-seg button.sel[data-g="boys"]{background:var(--accent2,#2980b9);border-color:var(--accent2,#2980b9)}',
      '#welcomeGate .wg-seg button.sel[data-g="girls"]{background:#c2185b;border-color:#c2185b}',
      '#welcomeGate .wg-hint{font-size:12px;color:#888;margin-top:8px}',
      '#welcomeGate .wg-error{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:10px;',
      ' padding:10px 12px;font-size:13px;font-weight:700;margin-top:14px}',
      '#welcomeGate .wg-go{width:100%;margin-top:18px;padding:14px;border:none;border-radius:12px;background:var(--green,#1a7a4a);',
      ' color:#fff;font-family:inherit;font-size:16px;font-weight:900;cursor:pointer}',
      '#welcomeGate .wg-go:disabled{opacity:.6;cursor:wait}',
      '#welcomeGate .wg-guide{display:block;width:100%;margin-top:12px;padding:12px 14px;box-sizing:border-box;background:var(--ink,#0d1117);',
      ' color:var(--paper,#f5f0e8);border:2px solid var(--gold,#d4a017);border-radius:10px;font-family:inherit;font-size:15px;font-weight:800;',
      ' text-align:center;text-decoration:none;cursor:pointer;transition:background .2s,color .2s}',
      '#welcomeGate .wg-guide:hover{background:var(--gold,#d4a017);color:var(--ink,#0d1117)}',
      '#wgUserBar{display:flex;align-items:center;gap:12px;position:relative;overflow:hidden;',
      ' background:linear-gradient(135deg,#ffffff 0%,#eaf3fb 100%);border:1px solid rgba(41,128,185,.28);',
      ' border-right:5px solid var(--accent2,#2980b9);border-radius:14px;padding:12px 14px;margin-bottom:16px;',
      ' box-shadow:0 4px 14px rgba(41,128,185,.14);color:var(--ink,#0d1117);font-family:inherit}',
      '#wgUserBar.admin{background:linear-gradient(135deg,#ffffff 0%,#fdeeec 100%);border-color:rgba(200,57,43,.3);',
      ' border-right-color:var(--accent,#c8392b);box-shadow:0 4px 14px rgba(200,57,43,.14)}',
      '#wgUserBar.girls{background:linear-gradient(135deg,#ffffff 0%,#fdeaf2 100%);border-color:rgba(194,24,91,.28);',
      ' border-right-color:#c2185b;box-shadow:0 4px 14px rgba(194,24,91,.12)}',
      '#wgUserBar .wg-av{flex:0 0 auto;width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      ' font-size:21px;font-weight:900;color:#fff;background:linear-gradient(135deg,#3498db,#1f6fa5);',
      ' box-shadow:0 3px 10px rgba(41,128,185,.4);border:2px solid #fff}',
      '#wgUserBar.admin .wg-av{background:linear-gradient(135deg,#e74c3c,#a82a1e);box-shadow:0 3px 10px rgba(200,57,43,.4)}',
      '#wgUserBar.girls .wg-av{background:linear-gradient(135deg,#e91e8c,#a3134f);box-shadow:0 3px 10px rgba(194,24,91,.4)}',
      '#wgUserBar .wg-info{flex:1 1 auto;min-width:0;text-align:right}',
      '#wgUserBar .wg-hi{font-size:11px;font-weight:700;color:#7a7a7a;line-height:1.3}',
      '#wgUserBar .wg-name{font-size:16px;font-weight:900;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#wgUserBar .wg-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}',
      '#wgUserBar .wg-chip{font-size:11px;font-weight:800;padding:2px 9px;border-radius:20px;background:#fff;',
      ' border:1px solid rgba(0,0,0,.1);color:#444;white-space:nowrap}',
      '#wgUserBar .wg-chip.boys{background:#e3f1fb;color:#1f6fa5;border-color:#b9dcf3}',
      '#wgUserBar .wg-chip.girls{background:#fde4ef;color:#a3134f;border-color:#f6b8d2}',
      '#wgUserBar .wg-chip.admin{background:#fde4e1;color:#a82a1e;border-color:#f3b3ac}',
      '#wgUserBar .wg-btn{flex:0 0 auto;font-family:inherit;font-size:12.5px;font-weight:800;padding:9px 13px;border-radius:10px;',
      ' border:none;cursor:pointer;color:#fff;background:var(--ink,#0d1117);box-shadow:0 3px 8px rgba(0,0,0,.2);',
      ' display:inline-flex;align-items:center;gap:5px;transition:transform .15s,background .15s}',
      '#wgUserBar .wg-btn:hover{background:var(--gold,#d4a017);color:var(--ink,#0d1117);transform:translateY(-1px)}',
      '#wgUserBar.admin .wg-btn{background:var(--accent,#c8392b)}',
      '#wgUserBar.admin .wg-btn:hover{background:#a82a1e;color:#fff}',
      '@media(max-width:420px){#wgUserBar{flex-wrap:wrap}#wgUserBar .wg-btn{width:100%;justify-content:center}}',
      '#wgHeaderUser{display:inline-flex !important;align-items:center;gap:7px;max-width:190px;padding:4px 12px 4px 6px !important;',
      ' border-radius:30px !important;background:rgba(255,255,255,.14) !important;border:1px solid rgba(255,255,255,.35) !important}',
      '#wgHeaderUser .wg-hav{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;',
      ' justify-content:center;font-size:13px;font-weight:900;background:#3498db;color:#fff;border:1.5px solid #fff}',
      '#wgHeaderUser.admin .wg-hav{background:#e74c3c}',
      '#wgHeaderUser.girls .wg-hav{background:#e91e8c}',
      '#wgHeaderUser .wg-hname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;font-size:12.5px}',
      '#wgHeaderUser .wg-hedit{font-size:11px;opacity:.8}',
      '#wgServModal{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;',
      ' justify-content:center;direction:rtl;font-family:"Cairo",sans-serif}',
      '#wgServModal .wgs-box{background:var(--paper,#f5f0e8);width:100%;max-width:520px;max-height:92vh;display:flex;flex-direction:column;',
      ' border-radius:18px 18px 0 0;padding:16px 14px calc(14px + env(safe-area-inset-bottom,0px));border-top:5px solid var(--gold,#d4a017)}',
      '@media(min-width:560px){#wgServModal{align-items:center}#wgServModal .wgs-box{border-radius:18px}}',
      '#wgServModal .wgs-head{display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:900;margin-bottom:10px}',
      '#wgServModal .wgs-head button{border:none;background:#0d1117;color:#fff;width:32px;height:32px;border-radius:50%;font-size:15px;cursor:pointer}',
      '#wgServModal input,#wgServModal select{width:100%;box-sizing:border-box;padding:10px 12px;border:2px solid var(--line,#b5a98a);',
      ' border-radius:10px;font-family:inherit;font-size:15px;background:#fff;color:#0d1117;margin-bottom:8px}',
      '#wgServModal .wgs-body{overflow-y:auto;flex:1 1 auto;min-height:120px;font-size:14px}',
      '#wgServModal .wgs-item{background:#fff;border:1px solid var(--line,#b5a98a);border-radius:12px;padding:10px 12px;margin-bottom:8px}',
      '#wgServModal .wgs-row{display:flex;align-items:center;gap:8px}',
      '#wgServModal .wgs-nm{flex:1;font-weight:900;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#wgServModal .wgs-meta{font-size:12px;color:#666;margin-top:4px}',
      '#wgServModal .wgs-chip{display:inline-block;font-size:11px;font-weight:800;padding:2px 9px;border-radius:20px;margin-left:5px;background:#eee;color:#444}',
      '#wgServModal .wgs-chip.boys{background:#e3f1fb;color:#1f6fa5}#wgServModal .wgs-chip.girls{background:#fde4ef;color:#a3134f}',
      '#wgServModal .wgs-b{border:none;border-radius:9px;padding:7px 12px;font-family:inherit;font-size:12.5px;font-weight:800;cursor:pointer;',
      ' background:#0d1117;color:#fff}#wgServModal .wgs-b.g{background:#1a7a4a}#wgServModal .wgs-b.l{background:#ddd;color:#333}',
      '#wgServModal .wgs-ref{margin-top:8px;border:2px solid var(--line,#b5a98a);background:transparent;border-radius:10px;padding:10px;',
      ' font-family:inherit;font-weight:800;font-size:14px;cursor:pointer}',
      '#wgServModal .wgs-msg{padding:18px 8px;text-align:center;color:#666;line-height:1.8}',
      '#wgServModal .wgs-msg.err{color:#991b1b}',
      'body.role-servant #genderTabs,body.role-servant #stageChips{display:none !important}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ---------------------------- بناء الصفحة ---------------------------- */
  function stageOptionsHtml() {
    var h = '<option value="">— اختر السنة الدراسية —</option>';
    if (typeof STAGE_GROUPS === 'undefined') return h;
    STAGE_GROUPS.forEach(function (g) {
      h += '<optgroup label="' + esc(g.icon + ' ' + g.name) + '">' +
        g.stages.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('') +
        '</optgroup>';
    });
    return h;
  }

  function build() {
    if (el) return;
    injectCss();
    el = document.createElement('div');
    el.id = 'welcomeGate';
    el.className = 'wg-hide';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="wg-card">' +
        '<div class="wg-icon">⛪</div>' +
        '<h1>مرحباً بك 👋</h1>' +
        '<div class="wg-sub">من فضلك أدخل بياناتك ليظهر لك الفصل المناسب</div>' +

        '<div class="wg-q">هل أنت مشرف عام؟</div>' +
        '<div class="wg-seg" id="wgRole">' +
          '<button type="button" data-m="servant" class="sel">لا، أنا خادم / خادمة</button>' +
          '<button type="button" data-m="admin">نعم، مشرف عام</button>' +
        '</div>' +

        '<div id="wgServant">' +
          '<label for="wgName">اسمك</label>' +
          '<input id="wgName" type="text" autocomplete="name" placeholder="اكتب اسمك">' +
          '<label for="wgStage">السنة التي ستخدم فيها</label>' +
          '<select id="wgStage">' + stageOptionsHtml() + '</select>' +
          '<label>الفئة</label>' +
          '<div class="wg-seg" id="wgGender">' +
            '<button type="button" data-g="boys">👦 بنين</button>' +
            '<button type="button" data-g="girls">👧 بنات</button>' +
          '</div>' +
          '<div id="wgNote" class="wg-warn"></div>' +
        '</div>' +

        '<div id="wgAdmin" hidden>' +
          '<label for="wgEmail">البريد الإلكتروني</label>' +
          '<input id="wgEmail" type="email" dir="ltr" autocomplete="username" placeholder="name@example.com">' +
          '<label for="wgPass">كلمة المرور</label>' +
          '<input id="wgPass" type="password" dir="ltr" autocomplete="current-password" placeholder="********">' +
          '<label for="wgAdminName">اسمك (اختياري — يظهر في سجل النشاط)</label>' +
          '<input id="wgAdminName" type="text" autocomplete="name" placeholder="مثال: أبونا / أ. مينا">' +
          '<div class="wg-hint">نفس بيانات الدخول إلى لوحة المشرفين. ستظهر لك كل الفصول.</div>' +
        '</div>' +

        '<div id="wgError" class="wg-error" hidden></div>' +
        '<button type="button" id="wgSubmit" class="wg-go">متابعة ←</button>' +
        '<button type="button" id="wgCancel" class="wg-cancel" hidden>إلغاء والعودة</button>' +
        '<a href="./guide.html" class="wg-guide" title="شرح كامل لطريقة استخدام النظام">📖 طريقة شرح النظام</a>' +
      '</div>';
    document.body.insertBefore(el, document.body.firstChild);
    wire();
    prefill();
  }

  function setMode(m) {
    mode = m;
    $('wgServant').hidden = (m !== 'servant');
    $('wgAdmin').hidden = (m !== 'admin');
    Array.prototype.forEach.call($('wgRole').querySelectorAll('button'), function (b) {
      b.classList.toggle('sel', b.getAttribute('data-m') === m);
    });
    showError('');
    if ($('wgSubmit')) busy(false);
  }
  function setGender(g) {
    gender = g;
    Array.prototype.forEach.call($('wgGender').querySelectorAll('button'), function (b) {
      b.classList.toggle('sel', b.getAttribute('data-g') === g);
    });
  }
  function showError(msg) {
    var box = $('wgError');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }
  function busy(on, label) {
    var b = $('wgSubmit');
    b.disabled = !!on;
    b.textContent = on ? (label || '...') : (locked() && mode === 'servant' ? 'رجوع ←' : 'متابعة ←');
  }

  // يضبط حالة النموذج: مقفل / قابل للتعديل (بإذن المشرف) / تسجيل أول مرة
  function applyLock() {
    var lk = locked(), note = $('wgNote');
    $('wgName').disabled = lk;
    $('wgStage').disabled = lk;
    Array.prototype.forEach.call($('wgGender').querySelectorAll('button'), function (b) { b.disabled = lk; });
    if (lk) {
      note.className = 'wg-warn lock';
      note.innerHTML = '🔒 بياناتك مسجّلة ولا يمكن تغييرها من هنا.<br>لتغييرها اتجه إلى <b>المشرف العام</b> وسجّل دخوله من زر «نعم، مشرف عام» بالأعلى.';
    } else if (unlocked) {
      note.className = 'wg-warn adm';
      note.innerHTML = '🛡️ تم التفويض من المشرف العام — يمكنك الآن تعديل البيانات ثم الضغط على متابعة.';
    } else {
      note.className = 'wg-warn';
      note.innerHTML = '⚠️ <b>تنبيه:</b> بياناتك تُكتب <b>مرة واحدة فقط</b> ولن تستطيع تغييرها بعد ذلك. تأكد من صحتها قبل المتابعة. وإذا احتجت التغيير لاحقاً فاتجه إلى <b>المشرف العام</b>.';
    }
    $('wgCancel').hidden = !(profile && !unlocked ? true : unlocked);
    if (!role()) $('wgCancel').hidden = true;
    $('wgSubmit').textContent = lk ? 'رجوع ←' : 'متابعة ←';
  }

  function prefill() {
    if (profile) {
      $('wgName').value = profile.name;
      $('wgStage').value = profile.stage;
      setGender(profile.gender);
    }
    applyLock();
    try { $('wgEmail').value = localStorage.getItem(ADMIN_EMAIL_KEY) || ''; } catch (e) {}
  }

  function wire() {
    Array.prototype.forEach.call($('wgRole').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-m')); });
    });
    Array.prototype.forEach.call($('wgGender').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { setGender(b.getAttribute('data-g')); showError(''); });
    });
    $('wgSubmit').addEventListener('click', submit);
    $('wgCancel').addEventListener('click', function () {
      try { sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {}
      unlocked = false; applyLock(); hide();
      syncProfile();   // يعيد تسجيل البيانات القديمة على السيرفر
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
    });
  }

  /* ---------------------------- التحقق من المشرف العام ---------------------------- */
  // نستخدم عميلاً مؤقتاً (بدون حفظ جلسة) حتى لا نغيّر هوية العميل الذي يقرأ بيانات الفصول.
  async function verifyAdmin(email, password) {
    var c = adminClient();
    if (!c) throw new Error('تعذر تحميل خدمة الاتصال — تحقق من الإنترنت ثم أعد المحاولة');
    var res = await c.auth.signInWithPassword({ email: email, password: password });
    if (res.error) {
      var bad = res.error.status === 400 || /invalid login/i.test(res.error.message || '');
      throw new Error(bad ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة' : 'تعذر الاتصال — تحقق من الإنترنت ثم أعد المحاولة');
    }
    // نفس ما تقرأه لوحة المشرفين: سجلات كل الفصول
    var probe = await c.from('class_records').select('class_id').limit(1);
    if (probe.error) { try { await c.auth.signOut(); } catch (e) {} throw new Error('هذا الحساب لا يملك صلاحية المشرف العام'); }
    return res.data.user;
  }

  async function submit() {
    showError('');
    if (mode === 'servant') {
      if (locked()) { hide(); return; }   // مقفل: لا تغيير
      var name = $('wgName').value.trim().replace(/\s+/g, ' ');
      var stage = $('wgStage').value;
      if (name.length < 2) return showError('من فضلك اكتب اسمك');
      if (!stage) return showError('من فضلك اختر السنة التي ستخدم فيها');
      if (!gender) return showError('من فضلك اختر بنين أم بنات');
      var stName = (STAGE_INDEX[stage] && STAGE_INDEX[stage].stage.name) || '';
      if (!confirm('⚠️ تأكيد البيانات\n\nالاسم: ' + name + '\nالسنة: ' + stName + '\nالفئة: ' + (gender === 'girls' ? 'بنات' : 'بنين') +
        '\n\nلن تستطيع تغيير هذه البيانات بعد التأكيد إلا عن طريق المشرف العام.\nهل البيانات صحيحة؟')) return;
      var saved = { name: name, stage: stage, gender: gender, at: new Date().toISOString() };
      var c = anonClient();
      if (c) {
        busy(true, 'جاري الحفظ...');
        try {
          var rr = await c.rpc('register_servant', { p_device: deviceId(), p_name: name, p_stage: stage, p_gender: gender });
          if (!rr.error && rr.data && profileValid(rr.data)) {
            if (rr.data.name !== name || rr.data.stage !== stage || rr.data.gender !== gender) {
              alert('هذا الجهاز مسجّل مسبقاً باسم «' + rr.data.name + '» ولا يمكن تغيير بياناته إلا عن طريق المشرف العام.');
            }
            saved = rr.data;
          }
        } catch (e) {}
        busy(false);
      }
      profile = saved;
      name = profile.name;
      writeJSON(localStorage, PROFILE_KEY, profile);
      admin = null;
      unlocked = false;
      try { sessionStorage.removeItem(ADMIN_KEY); sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {}
      applyLock();
      finish('👋 أهلاً ' + name);
      return;
    }
    // مشرف عام
    var email = $('wgEmail').value.trim();
    var pass = $('wgPass').value;
    if (!email || !pass) return showError('من فضلك أدخل البريد الإلكتروني وكلمة المرور');
    busy(true, 'جاري التحقق...');
    try {
      var user = await verifyAdmin(email, pass);
      admin = { email: (user && user.email) || email, name: $('wgAdminName').value.trim() };
      writeJSON(sessionStorage, ADMIN_KEY, admin);
      try { localStorage.setItem(ADMIN_EMAIL_KEY, email); } catch (e) {}
      $('wgPass').value = '';
      busy(false);
      finish('🛡️ أهلاً ' + adminName() + ' — تظهر لك كل الفصول');
    } catch (e) {
      busy(false);
      showError(e && e.message ? e.message : 'تعذر التحقق، حاول مرة أخرى');
    }
  }

  function finish(msg) {
    try { sessionStorage.removeItem(CHAPTER_SESSION); } catch (e) {}
    hide();
    applyRole();
    if (typeof showToast === 'function') { try { showToast(msg); } catch (e) {} }
  }

  /* ---------------------------- إظهار / إخفاء ---------------------------- */
  function show() {
    build();
    applyLock();
    if (locked() && !admin) setMode('admin');
    else if (mode === 'admin' && !admin && !locked()) setMode('servant');
    el.classList.remove('wg-hide');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var f = mode === 'admin' ? $('wgEmail') : $('wgName');
      if (f && !f.value) { try { f.focus(); } catch (e) {} }
    }, 150);
  }
  function hide() {
    if (el) el.classList.add('wg-hide');
    document.body.style.overflow = '';
  }

  /* ---------------------------- شريط المستخدم ---------------------------- */
  function label() {
    if (admin) return adminName() + ' — مشرف عام (كل الفصول)';
    return profile ? (profile.name + ' — ' + stageName() + ' — ' + genderName()) : '';
  }

  // المشرف العام: تسجيل خروج (يعود الجهاز لبيانات الخادم المحفوظة إن وُجدت)
  async function adminLogout() {
    if (!confirm('هل تريد تسجيل الخروج من حساب المشرف العام؟')) return;
    try { var c = adminClient(); if (c) await c.auth.signOut(); } catch (e) {}
    try {
      sessionStorage.removeItem(ADMIN_KEY);
      sessionStorage.removeItem(UNLOCK_KEY);
      sessionStorage.removeItem(CHAPTER_SESSION);
    } catch (e) {}
    location.reload();
  }

  // المشرف العام: يفتح القفل على السيرفر ليتمكن هذا الجهاز من إعادة التسجيل
  async function adminUnlockProfile() {
    var who = profile ? ('«' + profile.name + '»') : 'هذا الجهاز';
    if (!confirm('هل تريد السماح بتعديل بيانات الخادم ' + who + ' على هذا الجهاز؟\n(بعد التعديل يعود الجهاز للعمل كخادم)')) return;
    var c = adminClient();
    if (c) {
      try {
        var r = await c.rpc('admin_unlock_servant', { p_device: deviceId() });
        if (r.error && !missingFn(r.error)) { alert('تعذر فتح القفل: ' + (r.error.message || 'خطأ غير معروف') + '\nسجّل خروج ثم ادخل كمشرف مرة أخرى.'); return; }
      } catch (e) { alert('تعذر الاتصال بالسيرفر — تحقق من الإنترنت.'); return; }
    }
    try {
      sessionStorage.removeItem(ADMIN_KEY);
      sessionStorage.removeItem(CHAPTER_SESSION);
      sessionStorage.setItem(UNLOCK_KEY, '1');
    } catch (e) {}
    location.reload();
  }

  // الخادم: البيانات مقفلة — يُوجَّه للمشرف العام
  function changeUser() {
    if (admin) return adminLogout();
    if (!confirm('🔒 بياناتك مسجّلة ولا يمكن تغييرها من هنا.\n\nلتغييرها اتجه إلى المشرف العام.\n\nهل أنت المشرف العام وتريد تسجيل الدخول؟')) return;
    show();
  }

  /* ---------------------------- شاشة الخدام المسجّلون (للمشرف العام) ---------------------------- */
  var servList = [], servEdit = -1;

  function closeServants() { var m = $('wgServModal'); if (m) m.remove(); servEdit = -1; }

  function openServants() {
    if (role() !== 'admin') return;
    injectCss(); closeServants();
    var m = document.createElement('div');
    m.id = 'wgServModal';
    m.innerHTML =
      '<div class="wgs-box">' +
        '<div class="wgs-head"><span>👥 الخدام المسجّلون <small id="wgsCount" style="font-weight:700;color:#777"></small></span>' +
          '<button type="button" id="wgsClose" aria-label="إغلاق">✕</button></div>' +
        '<input id="wgsSearch" type="search" placeholder="🔍 ابحث بالاسم أو السنة أو بنين/بنات">' +
        '<div id="wgsBody" class="wgs-body"></div>' +
        '<button type="button" id="wgsRefresh" class="wgs-ref">🔄 تحديث القائمة</button>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) closeServants(); });
    $('wgsClose').addEventListener('click', closeServants);
    $('wgsRefresh').addEventListener('click', loadServants);
    $('wgsSearch').addEventListener('input', function () { servEdit = -1; renderServants(); });
    $('wgsBody').addEventListener('click', onServClick);
    loadServants();
  }

  function sStage(id) { return stageValid(id) ? STAGE_INDEX[id].stage.name : String(id || ''); }
  function sGender(g) { return g === 'girls' ? 'بنات' : 'بنين'; }

  async function loadServants() {
    var body = $('wgsBody');
    if (!body) return;
    body.innerHTML = '<div class="wgs-msg">⏳ جاري التحميل...</div>';
    var c = adminClient();
    if (!c) { body.innerHTML = '<div class="wgs-msg err">تعذر تحميل خدمة الاتصال — تحقق من الإنترنت</div>'; return; }
    try {
      var r = await c.rpc('admin_list_servants');
      if (r.error) {
        body.innerHTML = '<div class="wgs-msg err">' + (missingFn(r.error)
          ? 'لم يتم تثبيت ملف servant_profiles.sql على Supabase بعد.'
          : 'تعذر جلب القائمة: ' + esc(r.error.message || '') + '<br>جرّب تسجيل الخروج ثم الدخول كمشرف من جديد.') + '</div>';
        return;
      }
      servList = r.data || [];
      servEdit = -1;
      renderServants();
    } catch (e) {
      body.innerHTML = '<div class="wgs-msg err">تعذر الاتصال بالسيرفر — تحقق من الإنترنت</div>';
    }
  }

  function renderServants() {
    var body = $('wgsBody');
    if (!body) return;
    var q = (($('wgsSearch') && $('wgsSearch').value) || '').trim().toLowerCase();
    var html = '', n = 0;
    servList.forEach(function (it, i) {
      var hay = (it.name + ' ' + sStage(it.stage) + ' ' + sGender(it.gender)).toLowerCase();
      if (q && hay.indexOf(q) < 0 && i !== servEdit) return;
      n++;
      var date = '';
      try { date = new Date(it.created_at).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) {}
      if (i === servEdit) {
        html += '<div class="wgs-item">' +
          '<input id="wgsEName" type="text" value="' + esc(it.name) + '" placeholder="الاسم">' +
          '<select id="wgsEStage">' + stageOptionsHtml() + '</select>' +
          '<select id="wgsEGender"><option value="boys">👦 بنين</option><option value="girls">👧 بنات</option></select>' +
          '<div class="wgs-row"><button type="button" class="wgs-b g" data-act="save" data-i="' + i + '">💾 حفظ</button>' +
          '<button type="button" class="wgs-b l" data-act="cancel">إلغاء</button></div></div>';
      } else {
        html += '<div class="wgs-item"><div class="wgs-row"><div class="wgs-nm">' + esc(it.name) + '</div>' +
          '<button type="button" class="wgs-b" data-act="edit" data-i="' + i + '">✏️ تعديل</button></div>' +
          '<div class="wgs-meta"><span class="wgs-chip">📚 ' + esc(sStage(it.stage)) + '</span>' +
          '<span class="wgs-chip ' + (it.gender === 'girls' ? 'girls' : 'boys') + '">' + (it.gender === 'girls' ? '👧 ' : '👦 ') + sGender(it.gender) + '</span>' +
          (date ? '<span>سُجّل: ' + esc(date) + '</span>' : '') + '</div></div>';
      }
    });
    body.innerHTML = html || '<div class="wgs-msg">' + (servList.length ? 'لا توجد نتائج مطابقة' : 'لا يوجد خدام مسجّلون بعد') + '</div>';
    var cnt = $('wgsCount');
    if (cnt) cnt.textContent = '(' + (q ? n + ' من ' : '') + servList.length + ')';
    if (servEdit >= 0 && servList[servEdit]) {
      $('wgsEStage').value = servList[servEdit].stage;
      $('wgsEGender').value = servList[servEdit].gender;
    }
  }

  async function onServClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act'), i = parseInt(b.getAttribute('data-i'), 10);
    if (act === 'edit') { servEdit = i; renderServants(); return; }
    if (act === 'cancel') { servEdit = -1; renderServants(); return; }
    if (act !== 'save') return;
    var it = servList[i], c = adminClient();
    var name = $('wgsEName').value.trim().replace(/\s+/g, ' ');
    var stage = $('wgsEStage').value, gender = $('wgsEGender').value;
    if (name.length < 2) return alert('من فضلك اكتب الاسم');
    if (!stage) return alert('من فضلك اختر السنة');
    if (!c || !it) return;
    b.disabled = true; b.textContent = 'جاري الحفظ...';
    try {
      var r = await c.rpc('admin_update_servant', { p_device: it.device_id, p_name: name, p_stage: stage, p_gender: gender });
      if (r.error) {
        b.disabled = false; b.textContent = '💾 حفظ';
        return alert(missingFn(r.error) ? 'شغّل ملف servant_profiles.sql المحدّث على Supabase أولاً.' : 'تعذر الحفظ: ' + (r.error.message || ''));
      }
    } catch (err) {
      b.disabled = false; b.textContent = '💾 حفظ';
      return alert('تعذر الاتصال بالسيرفر — تحقق من الإنترنت.');
    }
    it.name = name; it.stage = stage; it.gender = gender;
    if (it.device_id === deviceId()) {      // الجهاز الحالي نفسه
      profile = { name: name, stage: stage, gender: gender, at: it.created_at };
      writeJSON(localStorage, PROFILE_KEY, profile);
    }
    servEdit = -1;
    renderServants();
    if (typeof showToast === 'function') { try { showToast('✅ تم تعديل بيانات ' + name + ' — تظهر على جهازه عند فتح التطبيق'); } catch (x) {} }
  }

  function initialOf(name) {
    var t = String(name || '').trim();
    return t ? Array.from(t)[0] : '👤';
  }

  function renderBars() {
    injectCss();
    var r = role();
    var isGirls = r === 'servant' && profile && profile.gender === 'girls';
    var nm = r === 'admin' ? adminName() : (profile ? profile.name : '');

    var card = document.querySelector('#chapterGate .gate-card');
    if (card) {
      var bar = $('wgUserBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'wgUserBar';
        card.insertBefore(bar, card.firstChild);
      }
      bar.className = r === 'admin' ? 'admin' : (isGirls ? 'girls' : '');
      bar.style.display = r ? 'flex' : 'none';
      if (r) {
        var chips = r === 'admin'
          ? '<span class="wg-chip admin">🛡️ مشرف عام</span><span class="wg-chip">📚 كل الفصول</span>'
          : '<span class="wg-chip">📚 ' + esc(stageName()) + '</span>' +
            '<span class="wg-chip ' + (isGirls ? 'girls' : 'boys') + '">' + (isGirls ? '👧 ' : '👦 ') + esc(genderName()) + '</span>';
        bar.innerHTML =
          '<div class="wg-av">' + (r === 'admin' ? '🛡️' : esc(initialOf(nm))) + '</div>' +
          '<div class="wg-info">' +
            '<div class="wg-hi">' + (r === 'admin' ? 'مسجّل الدخول كـ' : 'أهلاً بك 👋') + '</div>' +
            '<div class="wg-name">' + esc(nm) + '</div>' +
            '<div class="wg-chips">' + chips + '</div>' +
          '</div>' +
          '<button type="button" class="wg-btn" id="wgChangeBtn">' +
            (r === 'admin' ? '🚪 تسجيل الخروج' : '🔒 تغيير البيانات (للمشرف)') + '</button>' +
          (r === 'admin' ? '<button type="button" class="wg-btn" id="wgServBtn">👥 الخدام المسجّلون</button>' : '') +
          (r === 'admin' && profile ? '<button type="button" class="wg-btn" id="wgUnlockBtn">✏️ تعديل بيانات الخادم</button>' : '');
        $('wgChangeBtn').addEventListener('click', changeUser);
        if ($('wgUnlockBtn')) $('wgUnlockBtn').addEventListener('click', adminUnlockProfile);
        if ($('wgServBtn')) $('wgServBtn').addEventListener('click', openServants);
      }
    }
    var hdr = document.querySelector('.header > div:last-child');
    if (hdr) {
      var hb = $('wgHeaderUser');
      if (!hb) {
        hb = document.createElement('button');
        hb.id = 'wgHeaderUser';
        hb.type = 'button';
        hb.className = 'switch-chapter-btn';
        hb.addEventListener('click', changeUser);
        hdr.insertBefore(hb, hdr.firstChild);
      }
      hb.style.display = r ? '' : 'none';
      hb.className = 'switch-chapter-btn ' + (r === 'admin' ? 'admin' : (isGirls ? 'girls' : ''));
      hb.title = r === 'admin' ? 'تسجيل الخروج من المشرف العام' : 'البيانات مقفلة — التغيير عن طريق المشرف العام';
      hb.innerHTML = '<span class="wg-hav">' + (r === 'admin' ? '🛡️' : esc(initialOf(nm))) + '</span>' +
        '<span class="wg-hname">' + esc(nm) + '</span><span class="wg-hedit">' + (r === 'admin' ? '🚪' : '🔒') + '</span>';
    }
  }

  function applyRole() {
    var r = role();
    document.body.classList.toggle('role-servant', r === 'servant');
    document.body.classList.toggle('role-admin', r === 'admin');
    if (r === 'servant') {
      try { _genderFilter = profile.gender; _stageFilter = 'all'; } catch (e) {}
    }
    renderBars();
    if (typeof renderChapterCards === 'function' && typeof _chaptersCache !== 'undefined' && _chaptersCache.length) {
      try { renderChapterCards(); } catch (e) {}
    }
  }

  /* ---------------------------- ربط مع باقي النظام ---------------------------- */
  // المشرف العام يدخل أي فصل مباشرة دون كلمة سر الفصل
  var _origOpenPass = window.openChapterPasswordModal;
  if (typeof _origOpenPass === 'function') {
    window.openChapterPasswordModal = function (chapterId) {
      if (role() === 'admin') {
        var ch = (_chaptersCache || []).find(function (c) { return String(c.chapter_id) === String(chapterId); });
        return unlockChapter(String(chapterId), ch ? ch.chapter_name : '');
      }
      return _origOpenPass.apply(this, arguments);
    };
  }

  // الخادم عند إضافة فصل جديد: نملأ المرحلة والفئة من بياناته
  var _origAddChapter = window.openAddChapterModal;
  if (typeof _origAddChapter === 'function') {
    window.openAddChapterModal = function () {
      var out = _origAddChapter.apply(this, arguments);
      if (role() === 'servant' && profile) {
        try { populateStageSelect(profile.stage); setEditGender(profile.gender); } catch (e) {}
      }
      return out;
    };
  }

  window.WelcomeGate = {
    role: role,
    actor: actor,
    summary: summary,
    chapterAllowed: chapterAllowed,
    isLoading: isLoading,
    profile: function () { return profile; },
    change: changeUser,
    locked: locked,
    open: show
  };

  /* ---------------------------- التشغيل ---------------------------- */
  if (!role()) {
    // لا نترك فصلاً مفتوحاً من جلسة سابقة خلف صفحة الترحيب
    try { sessionStorage.removeItem(CHAPTER_SESSION); } catch (e) {}
  }
  // مزامنة مع السيرفر: السيرفر هو المرجع، فلا يفيد تعديل البيانات من المتصفح
  async function syncProfile() {
    var c = anonClient();
    if (!c || unlocked) return;
    try {
      var g = await c.rpc('get_servant', { p_device: deviceId() });
      if (g.error) return;                        // الجدول غير مثبّت → يعمل محلياً فقط
      var srv = g.data;
      if (srv && profileValid(srv)) {
        var diff = !profile || profile.name !== srv.name || profile.stage !== srv.stage || profile.gender !== srv.gender;
        profile = srv;
        writeJSON(localStorage, PROFILE_KEY, profile);
        if (diff && !admin) {
          applyRole();
          if (el) { applyLock(); prefill(); }
          if (!forceOpen) hide();
        }
      } else if (profile) {                       // مسجّل محلياً فقط (خادم قديم) → نرفعه للسيرفر
        var r = await c.rpc('register_servant', { p_device: deviceId(), p_name: profile.name, p_stage: profile.stage, p_gender: profile.gender });
        if (!r.error && r.data && profileValid(r.data)) { profile = r.data; writeJSON(localStorage, PROFILE_KEY, profile); }
      }
    } catch (e) {}
  }

  applyRole();
  if (!role() || forceOpen) show();
  syncProfile();
})();
