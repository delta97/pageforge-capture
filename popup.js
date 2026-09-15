const UNSUPPORTED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:'];
const CHROME_WEB_STORE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

const els = {
  captureBtn: document.getElementById('captureBtn'),
  captureNote: document.getElementById('captureNote'),
  settingsBtn: document.getElementById('settingsBtn')
};

function getCaptureBlockReason(url) {
  if (!url) return 'This tab cannot be captured.';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'This tab cannot be captured.';
  }
  if (UNSUPPORTED_SCHEMES.includes(parsed.protocol)) return 'Chrome blocks extensions from capturing internal browser pages.';
  if (CHROME_WEB_STORE_HOSTS.includes(parsed.hostname)) return 'Chrome blocks extensions from capturing the Chrome Web Store.';
  return null;
}

function showNote(message) {
  els.captureNote.textContent = message;
  els.captureNote.classList.remove('hidden');
}

function triggerCapture(tabId) {
  els.captureBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'PFC_TRIGGER_CAPTURE', tabId }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const blockReason = getCaptureBlockReason(tab?.url);
  if (!tab?.id || blockReason) {
    els.captureBtn.disabled = true;
    showNote(blockReason || 'No active tab found to capture.');
  } else {
    els.captureBtn.disabled = false;
    els.captureBtn.addEventListener('click', () => triggerCapture(tab.id));
  }

  els.settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
