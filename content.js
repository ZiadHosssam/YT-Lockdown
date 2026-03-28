// YT Lockdown — content script

const ext = typeof browser !== 'undefined' ? browser : chrome;

let locked = false;
let videoEndedListener = null;
let beforeUnloadListener = null;
let bannerEl = null;
let pollInterval = null;
let externalBlockEl = null;
let ownerToken = sessionStorage.getItem('yt_lockdown_owner_token') || null;

const GLOBAL_LOCK_KEY = 'global_lockdown';

function getCurrentVideoId() {
  return new URLSearchParams(window.location.search).get('v');
}

function getLockKey() {
  const videoId = getCurrentVideoId();
  return `lockdown_${videoId || window.location.pathname}`;
}

function getCurrentGlobalLockState() {
  return new Promise((resolve) => {
    ext.storage.local.get([GLOBAL_LOCK_KEY], (result) => {
      resolve(result[GLOBAL_LOCK_KEY] || { active: false });
    });
  });
}

function setOwnerToken(token) {
  ownerToken = token || null;
  if (ownerToken) {
    sessionStorage.setItem('yt_lockdown_owner_token', ownerToken);
  } else {
    sessionStorage.removeItem('yt_lockdown_owner_token');
  }
}

function isOwnerTabForLock(lockState) {
  if (!lockState || !lockState.active) return false;
  if (!lockState.ownerToken || !ownerToken) return false;
  return lockState.ownerToken === ownerToken;
}

function isAnyYouTubePage() {
  return window.location.hostname.includes('youtube.com');
}

function getVideoElement() {
  return document.querySelector('video');
}

function injectBanner() {
  if (document.getElementById('yt-lockdown-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'yt-lockdown-banner';
  banner.innerHTML = `
    <span class="lock-label">🔴 Lockdown Active</span>
    <span class="lock-hint">Finish the video to escape</span>
  `;
  document.body.appendChild(banner);
  bannerEl = banner;
}

function removeBanner() {
  const b = document.getElementById('yt-lockdown-banner');
  if (b) b.remove();
  bannerEl = null;
}

function injectExternalBlock(lockState) {
  if (!isAnyYouTubePage()) return;
  if (document.getElementById('yt-lockdown-tab-blocked')) return;

  const blocker = document.createElement('div');
  blocker.id = 'yt-lockdown-tab-blocked';
  blocker.innerHTML = `
    <div class="block-title">LOCKED IN ANOTHER TAB</div>
    <div class="block-sub">Finish the active video to continue browsing YouTube.</div>
  `;

  document.body.classList.add('yt-lockdown-tab-blocked-active');
  document.body.appendChild(blocker);
  externalBlockEl = blocker;
}

function removeExternalBlock() {
  const blocker = document.getElementById('yt-lockdown-tab-blocked');
  if (blocker) blocker.remove();
  externalBlockEl = null;
  document.body.classList.remove('yt-lockdown-tab-blocked-active');
}

function onVideoEnded() {
  if (!locked) return;
  disengage();
  // Flash a subtle message
  const flash = document.createElement('div');
  flash.style.cssText = `
    position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:#0a0a0a; border:1px solid #333; color:#888;
    font-family:monospace; font-size:12px; letter-spacing:.1em;
    padding:10px 20px; z-index:999999; pointer-events:none;
    transition: opacity 1s ease;
  `;
  flash.textContent = 'Video finished. Lockdown lifted.';
  document.body.appendChild(flash);
  setTimeout(() => { flash.style.opacity = '0'; }, 2000);
  setTimeout(() => { flash.remove(); }, 3000);
}

function attachVideoListeners() {
  const video = getVideoElement();
  if (!video) return false;

  videoEndedListener = onVideoEnded;
  video.addEventListener('ended', videoEndedListener);
  return true;
}

function detachVideoListeners() {
  const video = getVideoElement();
  if (video && videoEndedListener) {
    video.removeEventListener('ended', videoEndedListener);
    videoEndedListener = null;
  }
}

function blockNavigation(e) {
  e.preventDefault();
  e.returnValue = 'Lockdown is active. Finish the video first!';
  return e.returnValue;
}

function interceptLinks() {
  // Intercept clicks on links that would navigate away from current video
  document.addEventListener('click', linkInterceptor, true);
}

function removeInterceptLinks() {
  document.removeEventListener('click', linkInterceptor, true);
}

function linkInterceptor(e) {
  if (!locked) return;

  const anchor = e.target.closest('a');
  if (!anchor) return;

  const href = anchor.href || '';
  const currentVideoId = new URLSearchParams(window.location.search).get('v');

  // Allow clicks within the same video (timestamps, etc.)
  if (href.includes(`v=${currentVideoId}`)) return;

  // Block navigation to other pages
  if (href.includes('youtube.com') && !href.includes(`v=${currentVideoId}`)) {
    e.preventDefault();
    e.stopPropagation();
    showBlockedFlash();
    return;
  }
}

function showBlockedFlash() {
  const existing = document.getElementById('yt-lockdown-blocked');
  if (existing) return;

  const el = document.createElement('div');
  el.id = 'yt-lockdown-blocked';
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:#0a0a0a; border:1px solid #ff0000; color:#ff4444;
    font-family:monospace; font-size:13px; letter-spacing:.1em;
    padding:16px 28px; z-index:999999; pointer-events:none;
    text-align:center; line-height:1.8;
  `;
  el.innerHTML = `LOCKDOWN ACTIVE<br/><span style="color:#444;font-size:10px;">Finish the video first.</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function engage(options = {}) {
  const { syncGlobal = true, ownerToken: nextOwnerToken = null } = options;
  if (locked) return;
  locked = true;

  if (nextOwnerToken) {
    setOwnerToken(nextOwnerToken);
  }

  removeExternalBlock();
  document.body.classList.add('yt-lockdown-active');
  injectBanner();

  // Try to attach now, poll if video not ready yet
  if (!attachVideoListeners()) {
    pollInterval = setInterval(() => {
      if (attachVideoListeners()) clearInterval(pollInterval);
    }, 500);
  }

  beforeUnloadListener = blockNavigation;
  window.addEventListener('beforeunload', beforeUnloadListener);

  interceptLinks();

  // Save state
  ext.storage.local.set({ [getLockKey()]: true });

  if (syncGlobal) {
    ext.storage.local.set({
      [GLOBAL_LOCK_KEY]: {
        active: true,
        videoId: getCurrentVideoId(),
        ownerToken,
        url: window.location.href,
        title: document.title,
        startedAt: Date.now()
      }
    });
  }
}

function disengage(options = {}) {
  const { syncGlobal = true } = options;
  if (!locked) return;
  locked = false;

  document.body.classList.remove('yt-lockdown-active');
  removeBanner();
  detachVideoListeners();

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  if (beforeUnloadListener) {
    window.removeEventListener('beforeunload', beforeUnloadListener);
    beforeUnloadListener = null;
  }

  removeInterceptLinks();

  ext.storage.local.set({ [getLockKey()]: false });

  if (syncGlobal) {
    setOwnerToken(null);
    ext.storage.local.set({
      [GLOBAL_LOCK_KEY]: {
        active: false,
        videoId: null,
        ownerToken: null,
        url: null,
        title: null,
        startedAt: null
      }
    });
  }
}

function applyGlobalLockState(lockState) {
  if (!lockState || !lockState.active) {
    if (locked) disengage({ syncGlobal: false });
    setOwnerToken(null);
    removeExternalBlock();
    return;
  }

  if (isOwnerTabForLock(lockState)) {
    removeExternalBlock();
    if (!locked) engage({ syncGlobal: false });
    return;
  }

  if (locked) disengage({ syncGlobal: false });
  injectExternalBlock(lockState);
}

// Listen for messages from popup
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'engage') engage({ ownerToken: message.ownerToken || null });
  if (message.action === 'disengage') {
    disengage();
    removeExternalBlock();
  }
  if (message.action === 'getState') {
    getCurrentGlobalLockState().then((globalLock) => {
      sendResponse({
        locked,
        blockedByOtherTab: globalLock.active && !isOwnerTabForLock(globalLock),
        globalLock
      });
    });
    return true;
  }
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[GLOBAL_LOCK_KEY]) {
    applyGlobalLockState(changes[GLOBAL_LOCK_KEY].newValue || { active: false });
  }
});

// On page load, restore lockdown state if it was active
// (handles refreshes on same video)
(function restoreState() {
  const key = getLockKey();
  ext.storage.local.get([key, GLOBAL_LOCK_KEY], (result) => {
    const globalLock = result[GLOBAL_LOCK_KEY] || { active: false };

    if (globalLock.active) {
      applyGlobalLockState(globalLock);
      return;
    }

    if (result[key]) engage({ syncGlobal: true });
  });
})();
