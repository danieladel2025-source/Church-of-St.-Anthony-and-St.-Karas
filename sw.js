// ============================================================
//  Service Worker - نظام تسجيل غياب ومتابعة مخدومين وخدام
// ============================================================

const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = `church-attendance-${CACHE_VERSION}`;

// الملفات الأساسية التي يتم تخزينها فوراً عند التثبيت (App Shell)
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ===== 1) التثبيت: تخزين الملفات الأساسية =====
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ===== 2) التفعيل: حذف أي كاش قديم من إصدار سابق =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ===== 3) الجلب: استراتيجية مختلطة =====
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // تجاهل الطلبات التي ليست GET (مثل POST لـ Supabase)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // ملفات التطبيق نفسه: Cache First مع تحديث في الخلفية
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  } else {
    // موارد خارجية (خطوط، مكتبات CDN): Network First مع تخزين احتياطي
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});

// ===== 4) استقبال رسائل من الصفحة (اختياري: لتحديث فوري) =====
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
