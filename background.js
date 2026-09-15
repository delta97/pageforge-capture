const DB_NAME = 'pageforge-captures';
const DB_VERSION = 1;
const DEFAULTS = {
  captureDelayMs: 650,
  imageFormat: 'png',
  jpegQuality: 0.92,
  autoDownload: false,
  filenameTemplate: '{host}_{date}_{time}',
  maxMegapixelsPerPart: 30,
  maxPartDimension: 16384,
  detectInnerScroller: true,
  handleFixedElements: true,
  handleStickyElements: true,
  pauseAnimations: true,
  pdfPaper: 'letter',
  pdfOrientation: 'portrait'
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(current);
  cleanupOldSessions().catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !tab?.windowId) return;
  captureFullPage(tab).catch(async (error) => {
    console.error('PageForge capture failed', error);
    await showErrorResult(error?.message || String(error));
  });
});

async function captureFullPage(tab) {
  const settings = await getSettings();
  const sessionId = crypto.randomUUID();
  const sourceUrl = tab.url || '';
  const title = tab.title || 'capture';

  await putSession({
    id: sessionId,
    createdAt: Date.now(),
    status: 'capturing',
    sourceUrl,
    title,
    settings
  });

  await setBadge('…');

  let prepared = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    const prep = await sendToTab(tab.id, {
      type: 'PFC_PREPARE',
      sessionId,
      settings
    });
    prepared = true;

    if (!prep?.ok) {
      throw new Error(prep?.error || 'This page could not be prepared for capture.');
    }

    const xPositions = makePositions(prep.contentWidth, prep.captureViewportWidth);
    const yPositions = makePositions(prep.contentHeight, prep.captureViewportHeight);
    const total = xPositions.length * yPositions.length;

    await updateSession(sessionId, {
      status: 'capturing',
      meta: {
        ...prep,
        xPositions,
        yPositions,
        totalTiles: total
      }
    });

    let index = 0;
    for (const y of yPositions) {
      for (const x of xPositions) {
        index += 1;

        const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (!active[0] || active[0].id !== tab.id) {
          throw new Error('Capture stopped because another tab became active. Keep the page being captured active until capture completes.');
        }

        const step = await sendToTab(tab.id, {
          type: 'PFC_SCROLL_TO',
          sessionId,
          x,
          y,
          tileIndex: index,
          totalTiles: total
        });
        if (!step?.ok) throw new Error(step?.error || 'The page stopped responding during capture.');

        // Chrome limits captureVisibleTab to 2 calls/sec. Enforce a safe floor.
        const delay = Math.max(550, Number(settings.captureDelayMs) || 650);
        await sleep(delay);

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const blob = await (await fetch(dataUrl)).blob();

        await putTile({
          key: `${sessionId}:${String(index).padStart(6, '0')}`,
          sessionId,
          index,
          x: step.actualX,
          y: step.actualY,
          captureRect: step.captureRect,
          browserViewportWidth: step.browserViewportWidth,
          browserViewportHeight: step.browserViewportHeight,
          blob
        });

        await sendToTab(tab.id, {
          type: 'PFC_MARK_CAPTURED',
          sessionId
        }).catch(() => {});

        await setBadge(`${Math.round((index / total) * 100)}%`);
      }
    }

    await sendToTab(tab.id, { type: 'PFC_RESTORE', sessionId });
    prepared = false;

    await updateSession(sessionId, { status: 'complete', completedAt: Date.now() });
    await clearBadge();
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?session=${encodeURIComponent(sessionId)}`),
      active: true
    });
  } catch (error) {
    if (prepared) {
      await sendToTab(tab.id, { type: 'PFC_RESTORE', sessionId }).catch(() => {});
    }
    await updateSession(sessionId, {
      status: 'error',
      error: error?.message || String(error),
      completedAt: Date.now()
    }).catch(() => {});
    await setBadge('!');
    setTimeout(() => clearBadge(), 2500);
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?session=${encodeURIComponent(sessionId)}`),
      active: true
    });
  }
}

function makePositions(totalSize, viewportSize) {
  totalSize = Math.max(1, Math.ceil(totalSize));
  viewportSize = Math.max(1, Math.floor(viewportSize));
  if (totalSize <= viewportSize) return [0];

  const positions = [];
  for (let pos = 0; pos < totalSize; pos += viewportSize) {
    const clamped = Math.min(pos, totalSize - viewportSize);
    if (positions[positions.length - 1] !== clamped) positions.push(clamped);
    if (clamped === totalSize - viewportSize) break;
  }
  return positions;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(`Unable to communicate with this page. ${error?.message || error}`);
  }
}

async function setBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  await chrome.action.setBadgeText({ text });
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
}

async function showErrorResult(message) {
  const sessionId = crypto.randomUUID();
  await putSession({
    id: sessionId,
    createdAt: Date.now(),
    completedAt: Date.now(),
    status: 'error',
    error: message,
    title: 'Capture error',
    sourceUrl: ''
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`result.html?session=${encodeURIComponent(sessionId)}`),
    active: true
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tiles')) {
        const tiles = db.createObjectStore('tiles', { keyPath: 'key' });
        tiles.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let value;
      try {
        value = fn(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function putSession(session) {
  await withStore('sessions', 'readwrite', (store) => store.put(session));
}

async function updateSession(id, patch) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result || { id };
        store.put({ ...existing, ...patch });
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function putTile(tile) {
  await withStore('tiles', 'readwrite', (store) => store.put(tile));
}

async function cleanupOldSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const db = await openDb();
  try {
    const oldIds = await new Promise((resolve, reject) => {
      const ids = [];
      const tx = db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if ((cursor.value.createdAt || 0) < cutoff) ids.push(cursor.key);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(ids);
      tx.onerror = () => reject(tx.error);
    });

    for (const id of oldIds) {
      await deleteSessionData(db, id);
    }
  } finally {
    db.close();
  }
}

async function deleteSessionData(db, sessionId) {
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'tiles'], 'readwrite');
    tx.objectStore('sessions').delete(sessionId);
    const index = tx.objectStore('tiles').index('sessionId');
    const req = index.openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
