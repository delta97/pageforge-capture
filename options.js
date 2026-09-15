const DEFAULTS = {
  captureDelayMs: 650,
  imageFormat: 'png',
  jpegQuality: 0.92,
  autoDownload: false,
  filenameTemplate: '{host}_{date}_{time}',
  maxMegapixelsPerPart: 30,
  maxPartWidth: 16384,
  maxPartHeight: 16384,
  detectInnerScroller: true,
  handleFixedElements: true,
  handleStickyElements: true,
  pauseAnimations: true,
  pdfPaper: 'letter',
  pdfOrientation: 'portrait'
};

const ids = Object.keys(DEFAULTS);
const savedText = document.getElementById('savedText');

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('resetBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  populate(DEFAULTS);
  flash('Reset to defaults.');
});

load();

async function load() {
  const values = await chrome.storage.sync.get(DEFAULTS);
  populate({ ...DEFAULTS, ...values });
}

function populate(values) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(values[id]);
    else el.value = values[id];
  }
}

async function save() {
  const values = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') values[id] = el.checked;
    else if (el.type === 'number') values[id] = Number(el.value);
    else values[id] = el.value;
  }
  values.captureDelayMs = Math.max(550, values.captureDelayMs || 650);
  values.jpegQuality = clamp(values.jpegQuality || .92, .55, 1);
  values.maxMegapixelsPerPart = clamp(values.maxMegapixelsPerPart || 30, 4, 120);
  values.maxPartWidth = clamp(values.maxPartWidth || 16384, 512, 32767);
  values.maxPartHeight = clamp(values.maxPartHeight || 16384, 512, 32767);
  await chrome.storage.sync.set(values);
  populate(values);
  flash('Settings saved.');
}

function flash(text) {
  savedText.textContent = text;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { savedText.textContent = ''; }, 2200);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
