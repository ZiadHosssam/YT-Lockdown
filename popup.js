// Firefox uses `browser` instead of `chrome`, but chrome is aliased — this handles both
const ext = typeof browser !== 'undefined' ? browser : chrome;
const GLOBAL_LOCK_KEY = 'global_lockdown';

function getVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

function getLockKeyForTab(tab) {
  const videoId = getVideoIdFromUrl(tab && tab.url);
  return `lockdown_${videoId || ''}`;
}

async function getCurrentTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function isYouTubeVideo(tab) {
  return tab && tab.url && tab.url.includes('youtube.com/watch');
}

async function getLockdownStateForVideo(tab) {
  const key = getLockKeyForTab(tab);
  if (key === 'lockdown_') return false;

  return new Promise((resolve) => {
    ext.storage.local.get([key], (result) => {
      resolve(result[key] || false);
    });
  });
}

async function getGlobalLockState() {
  return new Promise((resolve) => {
    ext.storage.local.get([GLOBAL_LOCK_KEY], (result) => {
      resolve(result[GLOBAL_LOCK_KEY] || { active: false });
    });
  });
}

function isOwnerForGlobalLock(tab, globalLock) {
  if (!globalLock || !globalLock.active) return false;
  return getVideoIdFromUrl(tab && tab.url) === globalLock.videoId;
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getCurrentTab();
  const mainUI = document.getElementById('mainUI');
  const notYT = document.getElementById('notYT');
  const lockBtn = document.getElementById('lockBtn');
  const unlockBtn = document.getElementById('unlockBtn');
  const statusText = document.getElementById('statusText');
  const videoTitle = document.getElementById('videoTitle');

  if (!await isYouTubeVideo(tab)) {
    notYT.style.display = 'block';
    return;
  }

  mainUI.style.display = 'block';

  if (tab.title) {
    const title = tab.title.replace(' - YouTube', '');
    videoTitle.textContent = title;
  }

  let isLocked = await getLockdownStateForVideo(tab);
  let globalLock = await getGlobalLockState();
  let blockedByOtherTab = false;

  try {
    const live = await ext.tabs.sendMessage(tab.id, { action: 'getState' });
    if (live && typeof live.locked === 'boolean') {
      isLocked = live.locked;
    }
    if (live && live.globalLock) {
      globalLock = live.globalLock;
    }
    if (live && typeof live.blockedByOtherTab === 'boolean') {
      blockedByOtherTab = live.blockedByOtherTab;
    }
  } catch {
    // Content script may not be ready yet on a fresh navigation.
  }

  function setLockedUI(locked, lockState, blockedElsewhere = false) {
    const isBlockedByOther = blockedElsewhere || !!(lockState && lockState.active && !isOwnerForGlobalLock(tab, lockState));

    if (isBlockedByOther) {
      statusText.textContent = 'LOCKED IN ANOTHER TAB';
      statusText.className = 'status-text active';
      lockBtn.disabled = true;
      lockBtn.textContent = '🔒 Blocked by active lock';
      unlockBtn.disabled = false;
      unlockBtn.textContent = '↩ Force Unlock All Tabs';
      return;
    }

    if (locked || (lockState && lockState.active)) {
      statusText.textContent = 'LOCKED IN';
      statusText.className = 'status-text active';
      lockBtn.disabled = true;
      lockBtn.textContent = '🔴 Lockdown Active';
      unlockBtn.disabled = false;
      unlockBtn.textContent = '↩ Force Unlock';
    } else {
      statusText.textContent = 'Standby';
      statusText.className = 'status-text idle';
      lockBtn.disabled = false;
      lockBtn.textContent = '⬛ Engage Lockdown';
      unlockBtn.disabled = true;
      unlockBtn.textContent = '↩ Force Unlock';
    }
  }

  setLockedUI(isLocked, globalLock, blockedByOtherTab);

  lockBtn.addEventListener('click', async () => {
    const videoId = getVideoIdFromUrl(tab.url);
    const ownerToken = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const key = getLockKeyForTab(tab);
    if (key !== 'lockdown_') {
      await ext.storage.local.set({ [key]: true });
    }

    await ext.storage.local.set({
      [GLOBAL_LOCK_KEY]: {
        active: true,
        videoId,
        ownerToken,
        url: tab.url,
        title: tab.title || null,
        startedAt: Date.now()
      }
    });

    try {
      await ext.tabs.sendMessage(tab.id, { action: 'engage', ownerToken });
    } catch {
      const rollback = {
        [GLOBAL_LOCK_KEY]: {
          active: false,
          videoId: null,
          ownerToken: null,
          url: null,
          title: null,
          startedAt: null
        }
      };

      if (key !== 'lockdown_') {
        rollback[key] = false;
      }

      await ext.storage.local.set(rollback);
      statusText.textContent = 'Page loading... try again';
      statusText.className = 'status-text idle';
      return;
    }

    setLockedUI(true, {
      active: true,
      videoId,
      ownerToken,
      url: tab.url,
      title: tab.title || null,
      startedAt: Date.now()
    });
  });

  unlockBtn.addEventListener('click', async () => {
    const currentVideoId = getVideoIdFromUrl(tab.url);
    const currentKey = getLockKeyForTab(tab);
    const updates = {
      [GLOBAL_LOCK_KEY]: {
        active: false,
        videoId: null,
        ownerToken: null,
        url: null,
        title: null,
        startedAt: null
      }
    };

    if (globalLock && globalLock.videoId) {
      updates[`lockdown_${globalLock.videoId}`] = false;
    }

    if (currentVideoId && currentKey !== 'lockdown_') {
      updates[currentKey] = false;
    }

    await ext.storage.local.set(updates);

    try {
      await ext.tabs.sendMessage(tab.id, { action: 'disengage' });
    } catch {
      // If messaging fails, still clear the persisted lock flag.
    }

    globalLock = { active: false };
    setLockedUI(false, globalLock);
  });
});
