const CACHE_NAME = 'reddit-pwa-v3';

// Install event - cache the app shell immediately
self.addEventListener('install', event => {
  console.log('SW: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('SW: Caching app shell');
        return cache.addAll([
          './',
          './index.html'
        ]);
      })
      .then(() => {
        console.log('SW: Skip waiting');
        return self.skipWaiting();
      })
  );
});

// Activate event - take control immediately
self.addEventListener('activate', event => {
  console.log('SW: Activating...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('SW: Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('SW: Claiming clients');
        return self.clients.claim();
      })
  );
});

// Fetch event - cache first for app, network first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // For navigation requests (page loads)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html')
        .then(response => {
          return response || fetch(event.request);
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // For Reddit API requests
  if (url.hostname.includes('reddit.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful responses
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Return cached version if offline
          return caches.match(event.request);
        })
    );
    return;
  }

  // For images
  if (event.request.destination === 'image') {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          if (response) return response;
          
          return fetch(event.request).then(response => {
            if (response && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseClone);
              });
            }
            return response;
          });
        })
    );
    return;
  }

  // For everything else, try cache first
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});