// Reddit PWA - Main Application Logic
// Updated with: Background updates, Offline sync queue, Bookmarking, Fixed gallery, Toast notifications

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    const CONFIG = {
        REQUESTS_PER_MINUTE: 10,
        REQUEST_INTERVAL: 6000, // 6 seconds between requests
        MAX_RETRIES: 3,
        INITIAL_BACKOFF: 1000,
        MAX_BACKOFF: 30000,
        POSTS_LIMIT: 25,
        UPDATE_CHECK_INTERVAL: 5 * 60 * 1000, // 5 minutes
        RATE_LIMIT_RESET_INTERVAL: 60 * 1000, // 1 minute
        REQUEST_TIMEOUT: 15000 // 15 seconds timeout
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================
    let subreddits = [];
    let cachedPosts = [];
    let popularPosts = [];
    let blockedSubreddits = [];
    let bookmarkedPosts = []; // NEW: Bookmarked posts
    let currentFeed = 'my'; // 'my', 'popular', or 'starred'
    let activeFilter = 'all';
    let rateLimitState = {
        lastRequestTime: 0,
        remainingRequests: CONFIG.REQUESTS_PER_MINUTE,
        resetTime: Date.now() + CONFIG.RATE_LIMIT_RESET_INTERVAL,
        requestCount: 0
    };
    let countrySuggestions = [];
    let selectedCountry = null;
    
    // NEW: Background update system
    let pendingUpdates = {
        my: { posts: [], count: 0 },
        popular: { posts: [], count: 0 }
    };
    
    // NEW: Offline sync queue
    let syncQueue = [];
    let isProcessingQueue = false;
    
    // NEW: Storage quota
    let storageQuota = 5 * 1024 * 1024; // Default 5MB
    const MAX_SAFE_STORAGE = 8 * 1024 * 1024; // Cap at 8MB
    
    // NEW: Periodic task intervals (for cleanup)
    let displayUpdateInterval = null;
    let updateCheckInterval = null;
    let rateLimitResetInterval = null;

    // ============================================================================
    // LOCAL STORAGE HELPERS
    // ============================================================================
    function safeGetItem(key, defaultValue) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (error) {
            console.error('Error reading from localStorage:', error);
            return defaultValue;
        }
    }

    function safeSetItem(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('Error writing to localStorage:', error);
            if (error.name === 'QuotaExceededError') {
                showToastMessage('Storage full! Old posts will be cleaned up.', 'warning');
            }
            return false;
        }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================
    async function initializeApp() {
        // Load data from localStorage
        subreddits = safeGetItem('subreddits', []);
        cachedPosts = safeGetItem('cachedPosts', []);
        popularPosts = safeGetItem('popularPosts', []);
        blockedSubreddits = safeGetItem('blockedSubreddits', []);
        bookmarkedPosts = safeGetItem('bookmarkedPosts', []); // NEW
        syncQueue = safeGetItem('syncQueue', []); // NEW
        currentFeed = safeGetItem('currentFeed', 'my');
        
        // NEW: Fix rate limit state corruption
        const savedRateLimitState = safeGetItem('rateLimitState', null);
        if (savedRateLimitState) {
            const now = Date.now();
            if (savedRateLimitState.resetTime && now >= savedRateLimitState.resetTime) {
                // Rate limit expired, reset it
                rateLimitState = {
                    lastRequestTime: 0,
                    remainingRequests: CONFIG.REQUESTS_PER_MINUTE,
                    resetTime: now + CONFIG.RATE_LIMIT_RESET_INTERVAL,
                    requestCount: 0
                };
            } else {
                rateLimitState = { ...rateLimitState, ...savedRateLimitState };
            }
        }

        // NEW: Initialize storage quota
        await initializeStorageQuota();

        // Load country suggestions
        await loadCountrySuggestions();

        // Set up event listeners
        setupEventListeners();

        // Register service worker
        registerServiceWorker();

        // Show feed tabs if user has subreddits
        updateFeedTabsVisibility();

        // Show welcome screen if no subreddits
        if (subreddits.length === 0) {
            showWelcomeScreen();
        } else {
            renderSubreddits();
            renderSubredditFilter();
            switchFeed(currentFeed);
            updateAllDisplays();
        }

        // Set up periodic tasks
        setupPeriodicTasks();

        // Monitor online/offline status
        setupOnlineOfflineListeners();

        // Check for updates
        checkForUpdates();
        
        // NEW: Process any pending sync jobs
        if (navigator.onLine && syncQueue.length > 0) {
            processSyncQueue();
        }
    }

    // ============================================================================
    // STORAGE QUOTA MANAGEMENT - NEW
    // ============================================================================
    async function initializeStorageQuota() {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            try {
                const estimate = await navigator.storage.estimate();
                const availableQuota = estimate.quota || storageQuota;
                
                // Use smaller of: browser quota or safety cap
                storageQuota = Math.min(availableQuota * 0.8, MAX_SAFE_STORAGE);
                
                console.log(`Storage quota: ${formatBytes(storageQuota)} (Browser: ${formatBytes(availableQuota)})`);
            } catch (error) {
                console.error('Could not estimate storage:', error);
            }
        }
    }

    // ============================================================================
    // EVENT LISTENERS
    // ============================================================================
    function setupEventListeners() {
        // Menu and sidebar
        const menuBtn = document.getElementById('menuBtn');
        const closeSidebar = document.getElementById('closeSidebar');
        const overlay = document.getElementById('overlay');
        const addSubredditBtn = document.getElementById('addSubredditBtn');
        const subredditInput = document.getElementById('subredditInput');
        const refreshPostsBtn = document.getElementById('refreshPostsBtn');
        const exportBtn = document.getElementById('exportBtn');
        const importBtn = document.getElementById('importBtn');
        const importFile = document.getElementById('importFile');
        const updateButton = document.getElementById('updateButton');

        if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
        if (closeSidebar) closeSidebar.addEventListener('click', toggleSidebar);
        if (overlay) overlay.addEventListener('click', toggleSidebar);

        // Subreddit management
        if (addSubredditBtn) addSubredditBtn.addEventListener('click', addSubreddit);
        if (subredditInput) {
            subredditInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    addSubreddit();
                }
            });
        }

        // Refresh posts
        if (refreshPostsBtn) refreshPostsBtn.addEventListener('click', refreshPosts);

        // Export/Import
        if (exportBtn) exportBtn.addEventListener('click', exportSubreddits);
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                if (importFile) importFile.click();
            });
        }
        if (importFile) importFile.addEventListener('change', importSubreddits);

        // Update button
        if (updateButton) updateButton.addEventListener('click', updatePWA);

        // Welcome screen
        const skipWelcome = document.getElementById('skipWelcome');
        const addDefaults = document.getElementById('addDefaults');
        if (skipWelcome) skipWelcome.addEventListener('click', hideWelcomeScreen);
        if (addDefaults) addDefaults.addEventListener('click', addDefaultSubreddits);

        // Feed tabs
        const myFeedTab = document.getElementById('myFeedTab');
        const popularFeedTab = document.getElementById('popularFeedTab');
        const starredFeedTab = document.getElementById('starredFeedTab'); // NEW
        if (myFeedTab) myFeedTab.addEventListener('click', () => switchFeed('my'));
        if (popularFeedTab) popularFeedTab.addEventListener('click', () => switchFeed('popular'));
        if (starredFeedTab) starredFeedTab.addEventListener('click', () => switchFeed('starred')); // NEW

        // Subreddit popup
        const popupCloseBtn = document.getElementById('popupCloseBtn');
        const popupFollowBtn = document.getElementById('popupFollowBtn');
        const popupBlockBtn = document.getElementById('popupBlockBtn');
        const subredditPopup = document.getElementById('subredditPopup');
        
        if (popupCloseBtn) popupCloseBtn.addEventListener('click', closeSubredditPopup);
        if (popupFollowBtn) popupFollowBtn.addEventListener('click', toggleFollowSubreddit);
        if (popupBlockBtn) popupBlockBtn.addEventListener('click', toggleBlockSubreddit);
        if (subredditPopup) {
            subredditPopup.addEventListener('click', (e) => {
                if (e.target === subredditPopup) closeSubredditPopup();
            });
        }
        
        // NEW: Gallery navigation with event delegation
        document.addEventListener('click', handleGalleryNavigation);
    }

    // NEW: Gallery navigation handler
    function handleGalleryNavigation(e) {
        const gallery = e.target.closest('.post-gallery');
        if (!gallery) return;
        
        if (e.target.classList.contains('gallery-nav')) {
            e.preventDefault();
            const direction = e.target.classList.contains('prev') ? -1 : 1;
            navigateGallery(gallery, direction);
        } else if (e.target.classList.contains('gallery-dot')) {
            e.preventDefault();
            const index = parseInt(e.target.dataset.index);
            setGalleryImage(gallery, index);
        }
    }

    // ============================================================================
    // SERVICE WORKER
    // ============================================================================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(registration => {
                    updateStatusDot();

                    // Listen for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showUpdateNotification();
                            }
                        });
                    });
                })
                .catch(error => {
                    console.error('Service Worker registration failed:', error);
                });

            // Listen for controller change (new SW activated)
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
            });
        }
    }

    function updateStatusDot() {
        const dot = document.getElementById('statusDot');
        const isOnline = navigator.onLine;
        
        if (isOnline && navigator.serviceWorker.controller) {
            dot.classList.add('online');
            dot.classList.remove('offline');
        } else {
            dot.classList.add('offline');
            dot.classList.remove('online');
        }
    }

    // ============================================================================
    // ONLINE/OFFLINE HANDLING
    // ============================================================================
    function setupOnlineOfflineListeners() {
        window.addEventListener('online', handleOnlineStatus);
        window.addEventListener('offline', handleOnlineStatus);
        
        // NEW: Process sync queue when coming online
        window.addEventListener('online', () => {
            if (syncQueue.length > 0) {
                showToastMessage('Back online! Syncing...', 'info');
                processSyncQueue();
            }
        });
        
        handleOnlineStatus(); // Initial check
    }

    function handleOnlineStatus() {
        const banner = document.getElementById('offlineBanner');
        const refreshBtn = document.getElementById('refreshPostsBtn');
        
        if (navigator.onLine) {
            banner.classList.remove('active');
            refreshBtn.disabled = false;
        } else {
            banner.classList.add('active');
            refreshBtn.disabled = true;
        }
        
        updateStatusDot();
    }

    // ============================================================================
    // UPDATE MANAGEMENT
    // ============================================================================
    function checkForUpdates() {
        if (!navigator.onLine || !('serviceWorker' in navigator)) {
            return;
        }

        navigator.serviceWorker.getRegistration()
            .then(registration => {
                if (registration) {
                    registration.update();
                }
            })
            .catch(error => {
                console.error('Error checking for updates:', error);
            });
    }

    function showUpdateNotification() {
        const notification = document.getElementById('updateNotification');
        notification.classList.add('active');
    }

    function updatePWA() {
        if (!navigator.serviceWorker.controller) {
            const now = new Date();
            safeSetItem('lastUpdateTime', now.toISOString());
            window.location.reload();
            return;
        }

        const now = new Date();
        safeSetItem('lastUpdateTime', now.toISOString());

        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
        
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
        }, { once: true });
    }

    // ============================================================================
    // SIDEBAR
    // ============================================================================
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');

        if (sidebar.classList.contains('open')) {
            updateStorageStats();
            updateVersionInfo();
        }
    }

    // ============================================================================
    // TOAST NOTIFICATION SYSTEM - NEW
    // ============================================================================
    function showToastMessage(message, type = 'info', duration = 3000) {
        const existingToast = document.querySelector('.toast-message');
        if (existingToast) existingToast.remove();
        
        const toast = document.createElement('div');
        toast.className = `toast-message toast-${type}`;
        toast.textContent = message;
        
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('visible'), 10);
        
        if (duration > 0) {
            setTimeout(() => {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
        
        return toast;
    }

    // ============================================================================
    // CONFIRMATION DIALOG SYSTEM - NEW
    // ============================================================================
    function showConfirmDialog(message, onConfirm, onCancel) {
        const dialog = document.createElement('div');
        dialog.className = 'confirm-dialog-overlay';
        dialog.innerHTML = `
            <div class="confirm-dialog">
                <div class="confirm-message">${message}</div>
                <div class="confirm-actions">
                    <button class="confirm-btn cancel">Cancel</button>
                    <button class="confirm-btn confirm">Confirm</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const cancelBtn = dialog.querySelector('.cancel');
        const confirmBtn = dialog.querySelector('.confirm');
        
        const cleanup = () => {
            dialog.classList.remove('visible');
            setTimeout(() => dialog.remove(), 300);
        };
        
        cancelBtn.onclick = () => {
            cleanup();
            if (onCancel) onCancel();
        };
        
        confirmBtn.onclick = () => {
            cleanup();
            if (onConfirm) onConfirm();
        };
        
        dialog.onclick = (e) => {
            if (e.target === dialog) {
                cleanup();
                if (onCancel) onCancel();
            }
        };
        
        setTimeout(() => dialog.classList.add('visible'), 10);
    }

    // ============================================================================
    // BACKGROUND UPDATE SYSTEM - NEW
    // ============================================================================
    async function fetchPostsInBackground() {
        if (subreddits.length === 0 || !navigator.onLine) return;

        const statusDot = document.getElementById('statusDot');
        if (statusDot) statusDot.className = 'status-dot loading';

        let totalNewPosts = 0;

        for (const sub of subreddits) {
            try {
                const posts = await fetchSubredditPostsWithTimeout(sub);
                
                if (posts && posts.length > 0) {
                    const existingIds = new Set(cachedPosts.map(p => p.id));
                    const newPosts = posts.filter(p => !existingIds.has(p.id));
                    
                    if (newPosts.length > 0) {
                        pendingUpdates.my.posts.push(...newPosts);
                        totalNewPosts += newPosts.length;
                    }
                }
            } catch (error) {
                console.error(`Background fetch failed for r/${sub}:`, error);
                // Continue with other subreddits
            }
        }

        if (statusDot) updateStatusDot();

        if (totalNewPosts > 0) {
            pendingUpdates.my.count = totalNewPosts;
            showUpdateToast();
        }
    }

    async function fetchPopularPostsInBackground() {
        if (!navigator.onLine) return;

        try {
            const posts = await fetchSubredditPostsWithTimeout('popular');
            
            if (posts && posts.length > 0) {
                const existingIds = new Set(popularPosts.map(p => p.id));
                const newPosts = posts.filter(p => !existingIds.has(p.id));
                
                if (newPosts.length > 0) {
                    pendingUpdates.popular.posts.push(...newPosts);
                    pendingUpdates.popular.count = newPosts.length;
                    showUpdateToast();
                }
            }
        } catch (error) {
            console.error('Background fetch failed for popular:', error);
        }
    }

    function showUpdateToast() {
        const existingToast = document.getElementById('updateToast');
        if (existingToast) {
            updateToastContent();
            return;
        }

        const toast = document.createElement('div');
        toast.id = 'updateToast';
        toast.className = 'update-toast';
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-message" id="toastMessage"></span>
                <button class="toast-action" onclick="window.applyPendingUpdates()">View Updates</button>
                <button class="toast-close" onclick="window.dismissToast()">×</button>
            </div>
        `;
        
        document.body.appendChild(toast);
        updateToastContent();
        
        setTimeout(() => toast.classList.add('visible'), 10);
    }

    function updateToastContent() {
        const messageEl = document.getElementById('toastMessage');
        if (!messageEl) return;
        
        const myCount = pendingUpdates.my.count;
        const popCount = pendingUpdates.popular.count;
        const total = myCount + popCount;
        
        if (currentFeed === 'my' && myCount > 0) {
            messageEl.textContent = `${myCount} new post${myCount > 1 ? 's' : ''}`;
        } else if (currentFeed === 'popular' && popCount > 0) {
            messageEl.textContent = `${popCount} new post${popCount > 1 ? 's' : ''}`;
        } else if (total > 0) {
            messageEl.textContent = `${total} new post${total > 1 ? 's' : ''} available`;
        }
    }

    function applyPendingUpdates() {
        if (pendingUpdates.my.posts.length > 0) {
            const allPosts = [...cachedPosts, ...pendingUpdates.my.posts];
            cachedPosts = removeDuplicatePosts(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            safeSetItem('cachedPosts', cachedPosts);
            cleanupOldPosts();
        }
        
        if (pendingUpdates.popular.posts.length > 0) {
            const allPosts = [...popularPosts, ...pendingUpdates.popular.posts];
            popularPosts = removeDuplicatePosts(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            safeSetItem('popularPosts', popularPosts);
            cleanupOldPosts();
        }
        
        pendingUpdates = {
            my: { posts: [], count: 0 },
            popular: { posts: [], count: 0 }
        };
        
        renderPosts();
        renderSubredditFilter();
        updateAllDisplays();
        
        dismissToast();
        showToastMessage('Feed updated!', 'success');
    }

    function dismissToast() {
        const toast = document.getElementById('updateToast');
        if (toast) {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }
    }

    // Expose globally
    window.applyPendingUpdates = applyPendingUpdates;
    window.dismissToast = dismissToast;

    // ============================================================================
    // OFFLINE SYNC QUEUE - NEW
    // ============================================================================
    function queueSyncJob(type, subreddit = null) {
        const job = {
            id: `${type}_${subreddit || 'all'}_${Date.now()}`,
            type: type,
            subreddit: subreddit,
            timestamp: Date.now(),
            retries: 0,
            status: 'pending'
        };
        
        syncQueue.push(job);
        safeSetItem('syncQueue', syncQueue);
        
        if (navigator.onLine && !isProcessingQueue) {
            processSyncQueue();
        }
        
        updateQueueStatus();
        return job;
    }

    async function processSyncQueue() {
        if (isProcessingQueue || syncQueue.length === 0) return;
        
        isProcessingQueue = true;
        updateQueueStatus();
        
        const pendingJobs = syncQueue.filter(j => j.status === 'pending' || j.status === 'failed');
        
        for (const job of pendingJobs) {
            if (!navigator.onLine) break;
            
            try {
                job.status = 'processing';
                safeSetItem('syncQueue', syncQueue);
                updateQueueStatus();
                
                if (job.type === 'fetch_subreddit' && job.subreddit) {
                    const posts = await fetchSubredditPostsWithTimeout(job.subreddit);
                    
                    if (posts && posts.length > 0) {
                        const existingIds = new Set(cachedPosts.map(p => p.id));
                        const newPosts = posts.filter(p => !existingIds.has(p.id));
                        
                        if (newPosts.length > 0) {
                            pendingUpdates.my.posts.push(...newPosts);
                            pendingUpdates.my.count += newPosts.length;
                        }
                    }
                    
                    job.status = 'completed';
                    
                } else if (job.type === 'fetch_popular') {
                    const posts = await fetchSubredditPostsWithTimeout('popular');
                    
                    if (posts && posts.length > 0) {
                        const existingIds = new Set(popularPosts.map(p => p.id));
                        const newPosts = posts.filter(p => !existingIds.has(p.id));
                        
                        if (newPosts.length > 0) {
                            pendingUpdates.popular.posts.push(...newPosts);
                            pendingUpdates.popular.count += newPosts.length;
                        }
                    }
                    
                    job.status = 'completed';
                }
                
            } catch (error) {
                console.error(`Sync job ${job.id} failed:`, error);
                job.retries++;
                
                if (job.retries >= 3) {
                    job.status = 'failed_max_retries';
                } else {
                    job.status = 'failed';
                }
            }
            
            safeSetItem('syncQueue', syncQueue);
            updateQueueStatus();
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        syncQueue = syncQueue.filter(j => j.status !== 'completed');
        safeSetItem('syncQueue', syncQueue);
        
        isProcessingQueue = false;
        updateQueueStatus();
        
        if (pendingUpdates.my.count > 0 || pendingUpdates.popular.count > 0) {
            showUpdateToast();
        }
    }

    function updateQueueStatus() {
        const queueIndicator = document.getElementById('queueIndicator');
        if (!queueIndicator) return;
        
        const pending = syncQueue.filter(j => j.status === 'pending' || j.status === 'processing').length;
        const failed = syncQueue.filter(j => j.status === 'failed').length;
        
        if (pending > 0) {
            queueIndicator.textContent = `Syncing ${pending}...`;
            queueIndicator.classList.add('active');
            queueIndicator.classList.remove('warning');
        } else if (failed > 0) {
            queueIndicator.textContent = `${failed} failed`;
            queueIndicator.classList.add('active', 'warning');
        } else {
            queueIndicator.classList.remove('active', 'warning');
        }
    }

    // ============================================================================
    // FETCH WITH TIMEOUT - NEW
    // ============================================================================
    async function fetchSubredditPostsWithTimeout(subreddit, timeout = CONFIG.REQUEST_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            await waitForRateLimit();
            
            const url = `https://www.reddit.com/r/${subreddit}.json?limit=${CONFIG.POSTS_LIMIT}&raw_json=1`;
            const response = await fetch(url, { signal: controller.signal });
            
            clearTimeout(timeoutId);
            
            rateLimitState.lastRequestTime = Date.now();
            rateLimitState.remainingRequests = Math.max(0, rateLimitState.remainingRequests - 1);
            rateLimitState.requestCount++;
            
            updateRateLimitFromHeaders(response.headers);
            
            if (response.status === 429) {
                throw new Error('Rate limited');
            }
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            const posts = data.data.children.map(child => stripPostData(child.data));
            
            safeSetItem('rateLimitState', rateLimitState);
            updateAllDisplays();
            
            return posts;
            
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                throw new Error('Request timeout');
            }
            throw error;
        }
    }

    // ============================================================================
    // BOOKMARKING SYSTEM - NEW
    // ============================================================================
    function toggleBookmark(postId) {
        const post = [...cachedPosts, ...popularPosts].find(p => p.id === postId);
        if (!post) return;
        
        const existingIndex = bookmarkedPosts.findIndex(p => p.id === postId);
        
        if (existingIndex > -1) {
            showConfirmDialog(
                'Remove this post from your starred posts?',
                () => {
                    bookmarkedPosts.splice(existingIndex, 1);
                    safeSetItem('bookmarkedPosts', bookmarkedPosts);
                    showToastMessage('Removed from starred posts', 'success');
                    renderPosts();
                    updateStorageStats();
                }
            );
        } else {
            bookmarkedPosts.push(post);
            safeSetItem('bookmarkedPosts', bookmarkedPosts);
            showToastMessage('Added to starred posts', 'success');
            renderPosts();
            updateStorageStats();
        }
    }

    window.toggleBookmark = toggleBookmark;

    // ============================================================================
    // SUBREDDIT FILTERING
    // ============================================================================
    function renderSubredditFilter() {
        const filterBar = document.getElementById('subredditFilter');
        if (!filterBar) return;

        if (currentFeed === 'my' && subreddits.length > 0) {
            filterBar.classList.add('active');
            
            const subsWithPosts = [...new Set(cachedPosts.map(p => p.subreddit))];
            const availableSubs = subreddits.filter(sub => 
                subsWithPosts.some(s => s.toLowerCase() === sub.toLowerCase())
            );
            
            if (availableSubs.length === 0) {
                filterBar.classList.remove('active');
                return;
            }
            
            const chips = ['<span class="filter-chip active" data-filter="all">All</span>'];
            availableSubs.forEach(sub => {
                chips.push(`<span class="filter-chip" data-filter="${sub}">r/${sub}</span>`);
            });
            
            filterBar.innerHTML = chips.join('');
            
            filterBar.querySelectorAll('.filter-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const filter = chip.dataset.filter;
                    setActiveFilter(filter);
                });
            });
        } else {
            filterBar.classList.remove('active');
        }
    }

    function setActiveFilter(filter) {
        activeFilter = filter;
        
        document.querySelectorAll('.filter-chip').forEach(chip => {
            if (chip.dataset.filter === filter) {
                chip.classList.add('active');
            } else {
                chip.classList.remove('active');
            }
        });
        
        renderPosts();
    }

    // ============================================================================
    // SUBREDDIT POPUP
    // ============================================================================
    let currentPopupSubreddit = null;

    async function openSubredditPopup(subredditName) {
        currentPopupSubreddit = subredditName;
        const popup = document.getElementById('subredditPopup');
        const nameEl = document.getElementById('popupSubredditName');
        const statsEl = document.getElementById('popupSubredditStats');
        const infoEl = document.getElementById('popupSubredditInfo');
        const iconEl = document.getElementById('popupIcon');
        const bannerEl = document.getElementById('popupBanner');
        const followBtn = document.getElementById('popupFollowBtn');
        const blockBtn = document.getElementById('popupBlockBtn');
        
        if (!popup || !nameEl || !infoEl) return;

        nameEl.textContent = `r/${subredditName}`;
        statsEl.textContent = 'Loading...';
        infoEl.textContent = 'Loading subreddit information...';
        iconEl.style.display = 'none';
        bannerEl.style.backgroundImage = '';
        bannerEl.style.background = 'linear-gradient(to bottom, #ff4500, rgba(255, 69, 0, 0))';
        
        const isFollowing = subreddits.some(s => s.toLowerCase() === subredditName.toLowerCase());
        const isBlocked = blockedSubreddits.some(s => s.toLowerCase() === subredditName.toLowerCase());
        
        if (followBtn) {
            followBtn.textContent = isFollowing ? 'Following' : 'Follow';
            followBtn.className = isFollowing ? 'popup-btn-follow following' : 'popup-btn-follow';
        }
        
        if (blockBtn) {
            blockBtn.textContent = isBlocked ? 'Blocked' : 'Block';
            blockBtn.className = isBlocked ? 'popup-btn-block blocked' : 'popup-btn-block';
        }
        
        popup.classList.add('active');

        try {
            const response = await fetch(`https://www.reddit.com/r/${subredditName}/about.json`);
            if (!response.ok) throw new Error('Failed to fetch subreddit info');
            
            const data = await response.json();
            const subData = data.data;
            
            nameEl.textContent = `r/${subData.display_name || subredditName}`;
            
            const subscribers = subData.subscribers ? formatNumber(subData.subscribers) : 'N/A';
            statsEl.textContent = `${subscribers} members`;
            
            infoEl.textContent = subData.public_description || subData.description || 'No description available.';
            
            if (subData.icon_img && subData.icon_img.trim()) {
                iconEl.src = subData.icon_img.replace(/&amp;/g, '&');
                iconEl.style.display = 'block';
            }
            
            if (subData.header_img && subData.header_img.trim()) {
                bannerEl.style.backgroundImage = `url(${subData.header_img.replace(/&amp;/g, '&')})`;
            } else if (subData.key_color) {
                bannerEl.style.background = `linear-gradient(to bottom, ${subData.key_color}, rgba(255, 255, 255, 0))`;
            }
        } catch (error) {
            console.error('Error fetching subreddit info:', error);
            statsEl.textContent = '';
            infoEl.textContent = `Community discussions from r/${subredditName}`;
        }
    }

    function closeSubredditPopup() {
        const popup = document.getElementById('subredditPopup');
        if (popup) popup.classList.remove('active');
        currentPopupSubreddit = null;
    }

    function toggleFollowSubreddit() {
        if (!currentPopupSubreddit) return;
        
        if (subreddits.includes(currentPopupSubreddit)) {
            // Unfollow
            subreddits = subreddits.filter(s => s !== currentPopupSubreddit);
        } else {
            // Follow
            subreddits.push(currentPopupSubreddit);
        }
        
        safeSetItem('subreddits', subreddits);
        renderSubreddits();
        renderSubredditFilter();
        updateFeedTabsVisibility();
        
        const followBtn = document.getElementById('popupFollowBtn');
        const isFollowing = subreddits.includes(currentPopupSubreddit);
        if (followBtn) {
            followBtn.textContent = isFollowing ? 'Following' : 'Follow';
            followBtn.className = isFollowing ? 'popup-btn-follow following' : 'popup-btn-follow';
        }
    }

    function toggleBlockSubreddit() {
        if (!currentPopupSubreddit) return;
        
        const isBlocked = blockedSubreddits.includes(currentPopupSubreddit);
        
        if (isBlocked) {
            blockedSubreddits = blockedSubreddits.filter(s => s !== currentPopupSubreddit);
            safeSetItem('blockedSubreddits', blockedSubreddits);
            renderSubreddits();
            renderPosts();
            
            const blockBtn = document.getElementById('popupBlockBtn');
            if (blockBtn) {
                blockBtn.textContent = 'Block';
                blockBtn.className = 'popup-btn-block';
            }
            
            showToastMessage(`Unblocked r/${currentPopupSubreddit}`, 'success');
        } else {
            showConfirmDialog(
                `Block r/${currentPopupSubreddit}? Posts from this subreddit will be hidden from your Popular feed.`,
                () => {
                    blockedSubreddits.push(currentPopupSubreddit);
                    safeSetItem('blockedSubreddits', blockedSubreddits);
                    renderSubreddits();
                    renderPosts();
                    
                    const blockBtn = document.getElementById('popupBlockBtn');
                    if (blockBtn) {
                        blockBtn.textContent = 'Blocked';
                        blockBtn.className = 'popup-btn-block blocked';
                    }
                    
                    showToastMessage(`Blocked r/${currentPopupSubreddit}`, 'success');
                }
            );
        }
    }

    function unblockSubreddit(sub) {
        blockedSubreddits = blockedSubreddits.filter(s => s.toLowerCase() !== sub.toLowerCase());
        safeSetItem('blockedSubreddits', blockedSubreddits);
        renderSubreddits();
        renderPosts();
        showToastMessage(`Unblocked r/${sub}`, 'success');
    }

    window.openSubredditPopup = openSubredditPopup;
    window.unblockSubreddit = unblockSubreddit;

    // ============================================================================
    // GALLERY NAVIGATION - FIXED
    // ============================================================================
    function navigateGallery(gallery, direction) {
        const images = gallery.querySelectorAll('.post-gallery-image');
        const currentIndex = parseInt(gallery.dataset.current || 0);
        const nextIndex = (currentIndex + direction + images.length) % images.length;
        
        setGalleryImage(gallery, nextIndex);
    }

    function setGalleryImage(gallery, index) {
        const images = gallery.querySelectorAll('.post-gallery-image');
        const dots = gallery.querySelectorAll('.gallery-dot');
        const counter = gallery.querySelector('.gallery-counter');
        const currentIndex = parseInt(gallery.dataset.current || 0);
        
        const currentImg = images[currentIndex];
        const nextImg = images[index];
        
        if (!nextImg.classList.contains('loaded') && !nextImg.complete) {
            gallery.classList.add('loading');
            
            nextImg.addEventListener('load', () => {
                performImageTransition(gallery, images, dots, counter, currentIndex, index);
                gallery.classList.remove('loading');
            }, { once: true });
        } else {
            performImageTransition(gallery, images, dots, counter, currentIndex, index);
        }
    }

    function performImageTransition(gallery, images, dots, counter, currentIndex, nextIndex) {
        images[currentIndex].classList.remove('active');
        images[nextIndex].classList.add('active');
        
        dots[currentIndex].classList.remove('active');
        dots[nextIndex].classList.add('active');
        
        gallery.dataset.current = nextIndex;
        
        if (counter) {
            counter.textContent = `${nextIndex + 1} / ${images.length}`;
        }
    }

    // ============================================================================
    // FEED SWITCHING
    // ============================================================================
    function updateFeedTabsVisibility() {
        const feedTabs = document.getElementById('feedTabs');
        if (feedTabs) {
            feedTabs.style.display = subreddits.length > 0 ? 'flex' : 'none';
        }
    }

    function switchFeed(feed) {
        currentFeed = feed;
        safeSetItem('currentFeed', currentFeed);
        activeFilter = 'all';

        const myFeedTab = document.getElementById('myFeedTab');
        const popularFeedTab = document.getElementById('popularFeedTab');
        const starredFeedTab = document.getElementById('starredFeedTab');

        if (myFeedTab && popularFeedTab && starredFeedTab) {
            myFeedTab.classList.toggle('active', feed === 'my');
            popularFeedTab.classList.toggle('active', feed === 'popular');
            starredFeedTab.classList.toggle('active', feed === 'starred');
        }

        renderSubredditFilter();
        renderPosts();

        if (feed === 'popular' && popularPosts.length === 0 && navigator.onLine) {
            queueSyncJob('fetch_popular');
            processSyncQueue();
        }
    }

    // ============================================================================
    // SUBREDDIT MANAGEMENT
    // ============================================================================
    function renderSubreddits() {
        const list = document.getElementById('subredditList');
        const blockedList = document.getElementById('blockedList');
        const blockedSection = document.getElementById('blockedSection');
        
        if (subreddits.length === 0) {
            list.innerHTML = '<span style="color: #7c7c7c;">No subreddits added yet</span>';
        } else {
            list.innerHTML = subreddits.map(sub => 
                `<span class="subreddit-tag" onclick="window.removeSubreddit('${sub}')">r/${sub} ×</span>`
            ).join('');
        }

        if (blockedList && blockedSection) {
            if (blockedSubreddits.length === 0) {
                blockedSection.style.display = 'none';
            } else {
                blockedSection.style.display = 'block';
                blockedList.innerHTML = blockedSubreddits.map(sub => 
                    `<span class="subreddit-tag blocked" onclick="window.unblockSubreddit('${sub}')">r/${sub} ×</span>`
                ).join('');
            }
        }
    }

    async function addSubreddit() {
        const input = document.getElementById('subredditInput');
        const sub = input.value.trim().replace(/^r\//, '');
        
        if (!sub) return;

        if (subreddits.includes(sub)) {
            showToastMessage('Subreddit already added', 'warning');
            return;
        }

        subreddits.push(sub);
        safeSetItem('subreddits', subreddits);
        input.value = '';
        renderSubreddits();
        
        toggleSidebar();
        
        // Queue fetch for new subreddit
        queueSyncJob('fetch_subreddit', sub);
        processSyncQueue();
    }

    function removeSubreddit(sub) {
        showConfirmDialog(
            `Remove r/${sub} from your feed? This will also delete all cached posts from this subreddit.`,
            () => {
                subreddits = subreddits.filter(s => s.toLowerCase() !== sub.toLowerCase());
                safeSetItem('subreddits', subreddits);
                
                cachedPosts = cachedPosts.filter(post => 
                    post.subreddit.toLowerCase() !== sub.toLowerCase()
                );
                safeSetItem('cachedPosts', cachedPosts);
                
                if (activeFilter.toLowerCase() === sub.toLowerCase()) {
                    activeFilter = 'all';
                }
                
                updateFeedTabsVisibility();
                renderSubreddits();
                renderSubredditFilter();
                renderPosts();
                
                showToastMessage(`Removed r/${sub}`, 'success');
            }
        );
    }

    window.removeSubreddit = removeSubreddit;

    // ============================================================================
    // RATE LIMITING
    // ============================================================================
    function canMakeRequest() {
        const now = Date.now();
        
        if (now >= rateLimitState.resetTime) {
            rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
            rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
            rateLimitState.requestCount = 0;
        }

        const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
        return timeSinceLastRequest >= CONFIG.REQUEST_INTERVAL && rateLimitState.remainingRequests > 0;
    }

    async function waitForRateLimit() {
        while (!canMakeRequest()) {
            const now = Date.now();
            const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
            const delay = Math.max(0, CONFIG.REQUEST_INTERVAL - timeSinceLastRequest);
            
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    function updateRateLimitFromHeaders(headers) {
        if (!headers) return;

        const remaining = headers.get('X-Ratelimit-Remaining');
        const reset = headers.get('X-Ratelimit-Reset');

        if (remaining !== null) {
            rateLimitState.remainingRequests = parseInt(remaining, 10);
        }

        if (reset !== null) {
            rateLimitState.resetTime = parseInt(reset, 10) * 1000;
        }

        safeSetItem('rateLimitState', rateLimitState);
        updateAllDisplays();
    }

    // ============================================================================
    // REFRESH POSTS - UPDATED
    // ============================================================================
    function refreshPosts() {
        if (!navigator.onLine) {
            showToastMessage('You are offline. Updates queued for when connection is restored.', 'info');
            if (currentFeed === 'my') {
                subreddits.forEach(sub => queueSyncJob('fetch_subreddit', sub));
            } else if (currentFeed === 'popular') {
                queueSyncJob('fetch_popular');
            }
            return;
        }
        
        toggleSidebar();
        
        if (currentFeed === 'my') {
            subreddits.forEach(sub => queueSyncJob('fetch_subreddit', sub));
            processSyncQueue();
        } else if (currentFeed === 'popular') {
            queueSyncJob('fetch_popular');
            processSyncQueue();
        }
    }

    function removeDuplicatePosts(posts) {
        const seen = new Set();
        return posts.filter(post => {
            if (seen.has(post.id)) {
                return false;
            }
            seen.add(post.id);
            return true;
        });
    }

    function stripPostData(post) {
        const result = {
            id: post.id,
            title: post.title,
            author: post.author,
            subreddit: post.subreddit,
            permalink: post.permalink,
            created_utc: post.created_utc,
            ups: post.ups,
            num_comments: post.num_comments,
            selftext: post.selftext || '',
            url: post.url || '',
            is_video: post.is_video || false,
            preview: null
        };

        if (post.gallery_data && post.media_metadata) {
            result.gallery = post.gallery_data.items.map(item => {
                const media = post.media_metadata[item.media_id];
                if (media && media.s) {
                    return media.s.u ? media.s.u.replace(/&amp;/g, '&') : null;
                }
                return null;
            }).filter(Boolean);
        }
        else if (post.preview?.images?.[0]?.source?.url) {
            result.gallery = [post.preview.images[0].source.url.replace(/&amp;/g, '&')];
        }

        if (post.is_video && post.media?.reddit_video?.fallback_url) {
            result.video_url = post.media.reddit_video.fallback_url;
        }

        return result;
    }

    // ============================================================================
    // RENDER POSTS - UPDATED
    // ============================================================================
    function renderPosts() {
        const container = document.getElementById('posts');
        const status = document.getElementById('status');

        let postsToShow;
        
        if (currentFeed === 'my') {
            postsToShow = cachedPosts;
        } else if (currentFeed === 'popular') {
            postsToShow = popularPosts;
        } else if (currentFeed === 'starred') {
            postsToShow = bookmarkedPosts;
        }

        if (currentFeed === 'my' && activeFilter !== 'all') {
            postsToShow = postsToShow.filter(post => 
                post.subreddit.toLowerCase() === activeFilter.toLowerCase()
            );
        }

        if (currentFeed === 'popular') {
            postsToShow = postsToShow.filter(post => 
                !blockedSubreddits.some(blocked => 
                    blocked.toLowerCase() === post.subreddit.toLowerCase()
                )
            );
        }

        if (postsToShow.length === 0) {
            status.textContent = '';
            
            let message = '';
            if (currentFeed === 'starred') {
                message = 'No starred posts yet. Tap the ★ icon on posts to save them here.';
            } else if (currentFeed === 'my') {
                message = navigator.onLine ? 
                    'No posts yet. Add subreddits and click "Refresh Posts".' : 
                    'No cached posts available. Connect to internet and refresh.';
            } else {
                message = navigator.onLine ? 
                    'No popular posts yet. They will load automatically.' : 
                    'No cached popular posts. Connect to internet to fetch.';
            }
            
            container.innerHTML = `
                <div class="post">
                    <div class="post-text" style="text-align: center; padding: 40px 20px; color: #7c7c7c;">
                        ${message}
                    </div>
                </div>
            `;
            return;
        }

        status.textContent = '';
        container.innerHTML = postsToShow.map(post => createPostHTML(post)).join('');
    }

    function createPostHTML(post) {
        const imageHtml = getImageHTML(post);
        const selftext = getSelftextHTML(post);
        const isBookmarked = bookmarkedPosts.some(p => p.id === post.id);
        
        const subredditHTML = `<span class="subreddit-name" onclick="window.openSubredditPopup('${escapeHTML(post.subreddit)}')">r/${escapeHTML(post.subreddit)}</span>`;

        return `
            <div class="post">
                <div class="post-header">
                    ${subredditHTML}
                    • Posted by <span class="post-author">u/${escapeHTML(post.author)}</span>
                    • ${formatTime(post.created_utc)}
                    <button class="bookmark-btn ${isBookmarked ? 'bookmarked' : ''}" 
                            onclick="window.toggleBookmark('${post.id}')" 
                            title="${isBookmarked ? 'Remove from starred' : 'Add to starred'}">
                        ${isBookmarked ? '★' : '☆'}
                    </button>
                </div>
                <div class="post-title">
                    <a href="https://reddit.com${escapeHTML(post.permalink)}" target="_blank" rel="noopener noreferrer">
                        ${escapeHTML(post.title)}
                    </a>
                </div>
                ${imageHtml}
                ${selftext}
                <div class="post-footer">
                    <span class="post-stat">⬆ ${formatNumber(post.ups)} upvotes</span>
                    <span class="post-stat">💬 ${formatNumber(post.num_comments)} comments</span>
                </div>
            </div>
        `;
    }

    function getImageHTML(post) {
        if (post.is_video && post.video_url) {
            return `<video class="post-image" controls preload="metadata"><source src="${escapeHTML(post.video_url)}" type="video/mp4">Your browser does not support video.</video>`;
        }

        if (post.gallery && post.gallery.length > 0) {
            if (post.gallery.length === 1) {
                return `<img class="post-image" src="${escapeHTML(post.gallery[0])}" alt="" loading="lazy" />`;
            }
            
            const galleryId = `gallery-${post.id}`;
            
            const images = post.gallery.map((url, index) => 
                `<img class="post-gallery-image ${index === 0 ? 'active' : ''} ${index > 0 ? 'preloading' : ''}" 
                     src="${escapeHTML(url)}" 
                     alt="" 
                     data-index="${index}"
                     onload="this.classList.remove('preloading'); this.classList.add('loaded');" />`
            ).join('');
            
            const dots = post.gallery.map((_, index) => 
                `<span class="gallery-dot ${index === 0 ? 'active' : ''}" data-index="${index}"></span>`
            ).join('');
            
            return `
                <div class="post-gallery" id="${galleryId}" data-current="0">
                    <div class="gallery-container">
                        ${images}
                    </div>
                    <button class="gallery-nav prev" aria-label="Previous">‹</button>
                    <button class="gallery-nav next" aria-label="Next">›</button>
                    <div class="gallery-indicators">${dots}</div>
                    <div class="gallery-counter">1 / ${post.gallery.length}</div>
                </div>
            `;
        }

        return '';
    }

    function getSelftextHTML(post) {
        if (!post.selftext) {
            return '';
        }

        let text = post.selftext;
        
        const parts = [];
        let lastIndex = 0;
        const linkRegex = /\[([^\]]+)\]\(([^\)]+)\)/g;
        let match;
        
        while ((match = linkRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(escapeHTML(text.substring(lastIndex, match.index)));
            }
            parts.push(`<a href="${escapeHTML(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHTML(match[1])}</a>`);
            lastIndex = match.index + match[0].length;
        }
        
        if (lastIndex < text.length) {
            parts.push(escapeHTML(text.substring(lastIndex)));
        }
        
        const html = parts.join('').replace(/\n/g, '<br>');
        return `<div class="post-text">${html}</div>`;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ============================================================================
    // FORMATTING HELPERS
    // ============================================================================
    function formatTime(timestamp) {
        const now = Date.now() / 1000;
        const diff = now - timestamp;
        
        if (diff < 0) return 'just now';
        if (diff < 60) return `${Math.floor(diff)}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
        
        const date = new Date(timestamp * 1000);
        return date.toLocaleDateString();
    }

    function formatNumber(num) {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
        return num.toString();
    }

    // ============================================================================
    // DISPLAY UPDATES
    // ============================================================================
    function updateAllDisplays() {
        updateRateLimitDisplay();
        updateStorageStats();
        updateVersionInfo();
    }

    function updateRateLimitDisplay() {
        const rateLimitInfo = document.getElementById('rateLimitInfo');
        
        if (rateLimitInfo) {
            const remaining = rateLimitState.remainingRequests;
            const total = CONFIG.REQUESTS_PER_MINUTE;
            rateLimitInfo.textContent = `${remaining}/${total}`;
            
            if (remaining <= 2) {
                rateLimitInfo.style.background = 'rgba(244, 67, 54, 0.8)';
            } else if (remaining <= 5) {
                rateLimitInfo.style.background = 'rgba(255, 152, 0, 0.8)';
            } else {
                rateLimitInfo.style.background = 'rgba(76, 175, 80, 0.8)';
            }
        }
    }

    function updateVersionInfo() {
        const versionElement = document.getElementById('versionInfo');
        if (!versionElement) return;

        const lastUpdate = safeGetItem('lastUpdateTime', null);
        
        if (lastUpdate) {
            const updateDate = new Date(lastUpdate);
            const formattedDate = updateDate.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });
            const formattedTime = updateDate.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit'
            });
            
            versionElement.innerHTML = `Last updated<br>${formattedDate} at ${formattedTime}`;
        } else {
            versionElement.innerHTML = 'No update history';
        }
    }

    // ============================================================================
    // EXPORT / IMPORT SUBREDDITS
    // ============================================================================
    function exportSubreddits() {
        const data = {
            subreddits: subreddits,
            exportDate: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `reddit-pwa-subreddits-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToastMessage('Subreddits exported!', 'success');
    }

    function importSubreddits(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                
                if (!data.subreddits || !Array.isArray(data.subreddits)) {
                    showToastMessage('Invalid file format', 'error');
                    return;
                }

                const normalizedExisting = subreddits.map(s => s.toLowerCase());
                const newSubs = data.subreddits.filter(sub => 
                    !normalizedExisting.includes(sub.toLowerCase())
                );
                
                subreddits = [...subreddits, ...newSubs];
                safeSetItem('subreddits', subreddits);
                
                const newCount = newSubs.length;
                
                renderSubreddits();
                renderSubredditFilter();
                updateFeedTabsVisibility();
                
                showToastMessage(`Imported ${data.subreddits.length} subreddits (${newCount} new)`, 'success');
                
                if (newCount > 0) {
                    toggleSidebar();
                    newSubs.forEach(sub => queueSyncJob('fetch_subreddit', sub));
                    processSyncQueue();
                }
                
                event.target.value = '';
            } catch (error) {
                showToastMessage('Error reading file: ' + error.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    // ============================================================================
    // WELCOME SCREEN & COUNTRY SUGGESTIONS
    // ============================================================================
    async function loadCountrySuggestions() {
        try {
            const response = await fetch('./subreddit-suggestions.json');
            const data = await response.json();
            countrySuggestions = data.countries;
        } catch (error) {
            console.error('Error loading country suggestions:', error);
            countrySuggestions = [];
        }
    }

    function showWelcomeScreen() {
        const welcomeScreen = document.getElementById('welcomeScreen');
        const countryList = document.getElementById('countryList');
        
        if (!welcomeScreen || !countryList) return;

        countryList.innerHTML = countrySuggestions.map((country, index) => `
            <div class="country-option" data-index="${index}">
                <div class="country-option-name">${country.name}</div>
                <div class="country-option-subs">${country.subreddits.join(', ')}</div>
            </div>
        `).join('');

        countryList.querySelectorAll('.country-option').forEach(option => {
            option.addEventListener('click', () => selectCountry(option));
        });

        welcomeScreen.classList.add('active');
    }

    function selectCountry(optionElement) {
        document.querySelectorAll('.country-option').forEach(opt => {
            opt.classList.remove('selected');
        });

        optionElement.classList.add('selected');
        selectedCountry = parseInt(optionElement.dataset.index);

        const addDefaultsBtn = document.getElementById('addDefaults');
        if (addDefaultsBtn) addDefaultsBtn.disabled = false;
    }

    function addDefaultSubreddits() {
        if (selectedCountry === null || !countrySuggestions[selectedCountry]) return;

        const defaultSubs = countrySuggestions[selectedCountry].subreddits;
        subreddits = [...defaultSubs];
        safeSetItem('subreddits', subreddits);

        hideWelcomeScreen();
        updateFeedTabsVisibility();
        renderSubreddits();
        renderSubredditFilter();
        
        // Queue fetch for default subreddits
        subreddits.forEach(sub => queueSyncJob('fetch_subreddit', sub));
        processSyncQueue();
    }

    function hideWelcomeScreen() {
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) {
            welcomeScreen.classList.remove('active');
        }
        
        renderSubreddits();
        renderPosts();
        updateAllDisplays();
    }

    // ============================================================================
    // STORAGE MANAGEMENT - UPDATED
    // ============================================================================
    function getLocalStorageSize() {
        let total = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                total += localStorage[key].length + key.length;
            }
        }
        return total * 2;
    }

    function getStorageUsagePercent() {
        const size = getLocalStorageSize();
        return (size / storageQuota) * 100;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    async function updateStorageStats() {
        const size = getLocalStorageSize();
        const percent = getStorageUsagePercent();

        const usageEl = document.getElementById('storageUsage');
        const barEl = document.getElementById('storageBar');
        const totalPostsEl = document.getElementById('totalPosts');
        const postsPerSubEl = document.getElementById('postsPerSub');

        if (usageEl) {
            usageEl.textContent = `${formatBytes(size)} / ${formatBytes(storageQuota)}`;
        }

        if (barEl) {
            barEl.style.width = `${Math.min(percent, 100)}%`;
            if (percent >= 90) {
                barEl.style.background = '#f44336';
            } else if (percent >= 80) {
                barEl.style.background = '#ff9800';
            } else {
                barEl.style.background = '#0079d3';
            }
        }

        if (totalPostsEl) {
            const totalCached = cachedPosts.length + popularPosts.length;
            const totalStarred = bookmarkedPosts.length;
            totalPostsEl.textContent = `${totalCached} cached + ${totalStarred} starred`;
        }

        if (postsPerSubEl) {
            const breakdown = {};
            
            cachedPosts.forEach(post => {
                breakdown[post.subreddit] = (breakdown[post.subreddit] || 0) + 1;
            });
            
            if (popularPosts.length > 0) {
                breakdown['popular'] = popularPosts.length;
            }
            
            if (bookmarkedPosts.length > 0) {
                breakdown['★ starred'] = bookmarkedPosts.length;
            }

            const lines = Object.entries(breakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([sub, count]) => `${sub.startsWith('★') ? sub : 'r/' + sub}: ${count}`)
                .join('<br>');

            postsPerSubEl.innerHTML = lines || '<em>No posts cached</em>';
        }
    }

    function cleanupOldPosts() {
        const usagePercent = getStorageUsagePercent();
        
        if (usagePercent < 80) {
            return;
        }

        console.log(`Storage at ${usagePercent.toFixed(1)}% - cleaning up old posts`);

        const bookmarkedIds = new Set(bookmarkedPosts.map(p => p.id));

        const allPosts = [...cachedPosts, ...popularPosts].filter(p => !bookmarkedIds.has(p.id));
        const sortedByAge = allPosts.sort((a, b) => a.created_utc - b.created_utc);

        const removeCount = Math.ceil(sortedByAge.length * 0.2);
        const postsToRemove = sortedByAge.slice(0, removeCount);
        const removeIds = new Set(postsToRemove.map(p => p.id));

        cachedPosts = cachedPosts.filter(post => !removeIds.has(post.id));
        safeSetItem('cachedPosts', cachedPosts);

        popularPosts = popularPosts.filter(post => !removeIds.has(post.id));
        safeSetItem('popularPosts', popularPosts);

        console.log(`Removed ${removeCount} oldest posts. Bookmarked posts: ${bookmarkedPosts.length} protected.`);
    }

    // ============================================================================
    // PERIODIC TASKS - FIXED
    // ============================================================================
    function setupPeriodicTasks() {
        // Clear existing intervals
        if (displayUpdateInterval) clearInterval(displayUpdateInterval);
        if (updateCheckInterval) clearInterval(updateCheckInterval);
        if (rateLimitResetInterval) clearInterval(rateLimitResetInterval);
        
        // Update displays every 10 seconds
        displayUpdateInterval = setInterval(updateAllDisplays, 10000);

        // Check for updates every 5 minutes
        if ('serviceWorker' in navigator) {
            updateCheckInterval = setInterval(checkForUpdates, CONFIG.UPDATE_CHECK_INTERVAL);
        }

        // Reset rate limit
        rateLimitResetInterval = setInterval(() => {
            const now = Date.now();
            if (now >= rateLimitState.resetTime) {
                rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
                rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
                rateLimitState.requestCount = 0;
                safeSetItem('rateLimitState', rateLimitState);
                updateAllDisplays();
            }
        }, 10000);
    }

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (displayUpdateInterval) clearInterval(displayUpdateInterval);
        if (updateCheckInterval) clearInterval(updateCheckInterval);
        if (rateLimitResetInterval) clearInterval(rateLimitResetInterval);
    });

    // ============================================================================
    // START APPLICATION
    // ============================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        initializeApp();
    }

})();