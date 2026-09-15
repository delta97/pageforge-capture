const DB_NAME = 'pageforge-captures';
const DB_VERSION = 1;
const params = new URLSearchParams(location.search);
const sessionId = params.get('session');

const els = {
  statusCard: document.getElementById('statusCard'),
  statusTitle: document.getElementById('statusTitle'),
  statusText: document.getElementById('statusText'),
  errorCard: document.getElementById('errorCard'),
  errorText: document.getElementById('errorText'),
  viewer: document.getElementById('viewer'),
  captureMeta: document.getElementById('captureMeta'),
  partSummary: document.getElementById('partSummary'),
  dimensionSummary: document.getElementById('dimensionSummary'),
  imageStage: document.getElementById('imageStage'),
  zoomSelect: document.getElementById('zoomSelect'),
  copyBtn: document.getElementById('copyBtn'),
  pdfBtn: document.getElementById('pdfBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  pdfDialog: document.getElementById('pdfDialog'),
  pdfPaper: document.getElementById('pdfPaper'),
  pdfOrientation: document.getElementById('pdfOrientation'),
  pdfQuality: document.getElementById('pdfQuality'),
  exportPdfBtn: document.getElementById('exportPdfBtn')
};

let session = null;
let tiles = [];
let decodedTiles = [];
let output = null;
let partUrls = [];

els.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.zoomSelect.addEventListener('change', updateZoom);
els.downloadBtn.addEventListener('click', () => downloadParts(session?.settings?.imageFormat || 'png'));
els.copyBtn.addEventListener('click', copyCapture);
els.pdfBtn.addEventListener('click', () => els.pdfDialog.showModal());
els.exportPdfBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  els.exportPdfBtn.disabled = true;
  const old = els.exportPdfBtn.textContent;
  els.exportPdfBtn.textContent = 'Building…';
  try {
    await exportPdf(els.pdfPaper.value, els.pdfOrientation.value, Number(els.pdfQuality.value));
    els.pdfDialog.close();
  } catch (error) {
    alert(`PDF export failed: ${error?.message || error}`);
  } finally {
    els.exportPdfBtn.disabled = false;
    els.exportPdfBtn.textContent = old;
  }
});

init().catch(showError);

async function init() {
  if (!sessionId) throw new Error('No capture session was provided.');
  session = await getSession(sessionId);
  if (!session) throw new Error('The capture session could not be found. It may have expired.');

  els.captureMeta.textContent = session.sourceUrl || session.title || 'Capture result';
  if (session.status === 'error') throw new Error(session.error || 'The capture failed.');
  if (session.status !== 'complete') throw new Error('The capture did not finish successfully.');

  tiles = await getTiles(sessionId);
  if (!tiles.length) throw new Error('No screenshot tiles were stored for this capture.');

  decodedTiles = await decodeTiles(tiles);
  output = calculateOutput(decodedTiles, session.meta, session.settings || {});

  els.statusTitle.textContent = 'Rendering screenshot';
  els.statusText.textContent = `Creating ${output.parts.length} image part${output.parts.length === 1 ? '' : 's'} at full captured resolution.`;

  await renderParts();
  showViewer();

  els.pdfPaper.value = session.settings?.pdfPaper || 'letter';
  els.pdfOrientation.value = session.settings?.pdfOrientation || 'portrait';
  els.copyBtn.disabled = output.parts.length !== 1 || !navigator.clipboard || !window.ClipboardItem;
  els.pdfBtn.disabled = false;
  els.downloadBtn.disabled = false;

  if (session.settings?.autoDownload) {
    await downloadParts(session.settings.imageFormat || 'png');
  }
}

async function decodeTiles(records) {
  const decoded = [];
  let i = 0;
  for (const record of records) {
    i += 1;
    els.statusText.textContent = `Decoding tile ${i} of ${records.length}…`;
    const bitmap = await createImageBitmap(record.blob);
    decoded.push({ ...record, bitmap });
  }
  return decoded;
}

function calculateOutput(records, meta, settings) {
  const first = records[0];
  const scaleX = first.bitmap.width / first.browserViewportWidth;
  const scaleY = first.bitmap.height / first.browserViewportHeight;
  const width = Math.max(1, Math.round(meta.contentWidth * scaleX));
  const height = Math.max(1, Math.round(meta.contentHeight * scaleY));
  const maxPixels = Math.max(4, Number(settings.maxMegapixelsPerPart) || 30) * 1_000_000;
  const maxDim = Math.max(2048, Number(settings.maxPartDimension) || 16384);

  let partWidth = Math.min(width, maxDim);
  let partHeight = Math.min(height, maxDim, Math.max(1, Math.floor(maxPixels / partWidth)));
  if (partHeight < 1) partHeight = 1;

  const parts = [];
  for (let y = 0; y < height; y += partHeight) {
    for (let x = 0; x < width; x += partWidth) {
      parts.push({ x, y, width: Math.min(partWidth, width - x), height: Math.min(partHeight, height - y) });
    }
  }

  return { width, height, scaleX, scaleY, parts };
}

async function renderParts() {
  clearPartUrls();
  els.imageStage.replaceChildren();
  const format = session.settings?.imageFormat || 'png';
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const quality = Number(session.settings?.jpegQuality) || .92;

  let count = 0;
  for (const region of output.parts) {
    count += 1;
    els.statusText.textContent = `Rendering image part ${count} of ${output.parts.length}…`;
    const canvas = await renderRegion(region, 1);
    const blob = await canvasToBlob(canvas, mime, quality);
    const url = URL.createObjectURL(blob);
    partUrls.push({ url, blob, region });

    const img = document.createElement('img');
    img.className = 'capture-part';
    img.src = url;
    img.alt = `Capture part ${count}`;
    img.draggable = true;
    img.dataset.part = String(count);
    els.imageStage.appendChild(img);
  }
}

async function renderRegion(region, renderScale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.width * renderScale));
  canvas.height = Math.max(1, Math.round(region.height * renderScale));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const tile of decodedTiles) {
    const rect = tile.captureRect;
    const tileX = Math.round(tile.x * output.scaleX);
    const tileY = Math.round(tile.y * output.scaleY);
    const tileW = Math.round(rect.width * output.scaleX);
    const tileH = Math.round(rect.height * output.scaleY);

    const intersection = intersect(
      { x: tileX, y: tileY, width: tileW, height: tileH },
      region,
      { x: 0, y: 0, width: output.width, height: output.height }
    );
    if (!intersection) continue;

    const sourceScaleX = tile.bitmap.width / tile.browserViewportWidth;
    const sourceScaleY = tile.bitmap.height / tile.browserViewportHeight;
    const cropBaseX = rect.left * sourceScaleX;
    const cropBaseY = rect.top * sourceScaleY;

    const sourceX = cropBaseX + (intersection.x - tileX);
    const sourceY = cropBaseY + (intersection.y - tileY);
    const sourceW = intersection.width;
    const sourceH = intersection.height;

    const destX = (intersection.x - region.x) * renderScale;
    const destY = (intersection.y - region.y) * renderScale;
    const destW = intersection.width * renderScale;
    const destH = intersection.height * renderScale;

    ctx.drawImage(tile.bitmap, sourceX, sourceY, sourceW, sourceH, destX, destY, destW, destH);
  }

  return canvas;
}

function intersect(...rects) {
  const left = Math.max(...rects.map(r => r.x));
  const top = Math.max(...rects.map(r => r.y));
  const right = Math.min(...rects.map(r => r.x + r.width));
  const bottom = Math.min(...rects.map(r => r.y + r.height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function showViewer() {
  els.statusCard.classList.add('hidden');
  els.viewer.classList.remove('hidden');
  els.partSummary.textContent = `${output.parts.length} image part${output.parts.length === 1 ? '' : 's'}`;
  els.dimensionSummary.textContent = ` · ${output.width.toLocaleString()} × ${output.height.toLocaleString()} px total`;
  updateZoom();
}

function updateZoom() {
  els.imageStage.classList.remove('zoom-50', 'zoom-100');
  if (els.zoomSelect.value === '0.5') els.imageStage.classList.add('zoom-50');
  if (els.zoomSelect.value === '1') els.imageStage.classList.add('zoom-100');
}

async function downloadParts(format) {
  const requested = format === 'jpeg' ? 'jpeg' : 'png';
  const mime = requested === 'jpeg' ? 'image/jpeg' : 'image/png';
  const quality = Number(session.settings?.jpegQuality) || .92;
  const base = buildFilenameBase(session);

  for (let i = 0; i < output.parts.length; i += 1) {
    const region = output.parts[i];
    let blob = partUrls[i]?.blob;
    const existingType = blob?.type;
    if (!blob || existingType !== mime) {
      const canvas = await renderRegion(region, 1);
      blob = await canvasToBlob(canvas, mime, quality);
    }
    const suffix = output.parts.length > 1 ? `_part-${String(i + 1).padStart(2, '0')}` : '';
    triggerDownload(blob, `${base}${suffix}.${requested === 'jpeg' ? 'jpg' : 'png'}`);
    await sleep(120);
  }
}

async function copyCapture() {
  if (output.parts.length !== 1) return;
  els.copyBtn.disabled = true;
  const old = els.copyBtn.textContent;
  els.copyBtn.textContent = 'Copying…';
  try {
    const canvas = await renderRegion(output.parts[0], 1);
    const blob = await canvasToBlob(canvas, 'image/png', 1);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    els.copyBtn.textContent = 'Copied';
    setTimeout(() => { els.copyBtn.textContent = old; els.copyBtn.disabled = false; }, 1200);
  } catch (error) {
    alert(`Copy failed: ${error?.message || error}`);
    els.copyBtn.textContent = old;
    els.copyBtn.disabled = false;
  }
}

async function exportPdf(paper, orientation, quality) {
  quality = clamp(quality || .9, .55, 1);
  const pages = [];
  const paperPoints = getPaperPoints(paper, orientation);
  const margin = paper === 'continuous' ? 0 : 18;

  if (paper === 'continuous') {
    const pageWidth = 612;
    let pageHeight = pageWidth * (output.height / output.width);
    if (pageHeight > 14400) {
      return exportPdf('letter', orientation, quality);
    }
    const targetPixelWidth = Math.min(4096, output.width);
    const renderScale = targetPixelWidth / output.width;
    const canvas = await renderRegion({ x: 0, y: 0, width: output.width, height: output.height }, renderScale);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    pages.push({ blob, pixelWidth: canvas.width, pixelHeight: canvas.height, pageWidth, pageHeight });
  } else {
    const availableWidth = paperPoints.width - margin * 2;
    const availableHeight = paperPoints.height - margin * 2;
    const pageRegionHeight = Math.max(1, Math.floor(output.width * (availableHeight / availableWidth)));
    const targetPixelWidth = Math.min(4096, output.width);
    const renderScale = targetPixelWidth / output.width;

    for (let y = 0; y < output.height; y += pageRegionHeight) {
      const region = { x: 0, y, width: output.width, height: Math.min(pageRegionHeight, output.height - y) };
      const canvas = await renderRegion(region, renderScale);
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      const usedHeight = availableWidth * (region.height / region.width);
      pages.push({
        blob,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        pageWidth: paperPoints.width,
        pageHeight: paperPoints.height,
        drawX: margin,
        drawY: paperPoints.height - margin - usedHeight,
        drawWidth: availableWidth,
        drawHeight: usedHeight
      });
    }
  }

  const pdfBlob = await buildPdf(pages);
  triggerDownload(pdfBlob, `${buildFilenameBase(session)}.pdf`);
}

function getPaperPoints(paper, orientation) {
  let size;
  if (paper === 'a4') size = { width: 595.28, height: 841.89 };
  else if (paper === 'legal') size = { width: 612, height: 1008 };
  else size = { width: 612, height: 792 };
  if (orientation === 'landscape') return { width: size.height, height: size.width };
  return size;
}

async function buildPdf(pages) {
  const objects = [];
  const pageRefs = [];

  const pageCount = pages.length;
  for (let i = 0; i < pageCount; i += 1) pageRefs.push(3 + i * 3);

  objects[1] = ascii('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = ascii(`<< /Type /Pages /Count ${pageCount} /Kids [${pageRefs.map(n => `${n} 0 R`).join(' ')}] >>`);

  for (let i = 0; i < pageCount; i += 1) {
    const page = pages[i];
    const pageObj = 3 + i * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const imageBytes = new Uint8Array(await page.blob.arrayBuffer());

    const drawX = page.drawX ?? 0;
    const drawY = page.drawY ?? 0;
    const drawWidth = page.drawWidth ?? page.pageWidth;
    const drawHeight = page.drawHeight ?? page.pageHeight;

    objects[pageObj] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(page.pageWidth)} ${fmt(page.pageHeight)}] ` +
      `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
    );
    objects[imageObj] = streamObject(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>`,
      imageBytes
    );
    const content = ascii(`q\n${fmt(drawWidth)} 0 0 ${fmt(drawHeight)} ${fmt(drawX)} ${fmt(drawY)} cm\n/Im0 Do\nQ\n`);
    objects[contentObj] = streamObject(`<< /Length ${content.length} >>`, content);
  }

  const chunks = [ascii('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')];
  const offsets = [0];
  let byteOffset = chunks[0].length;

  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = byteOffset;
    const header = ascii(`${i} 0 obj\n`);
    const footer = ascii('\nendobj\n');
    chunks.push(header, objects[i], footer);
    byteOffset += header.length + objects[i].length + footer.length;
  }

  const xrefOffset = byteOffset;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(ascii(xref));

  return new Blob(chunks, { type: 'application/pdf' });

  function ascii(text) {
    const normalized = text.replace(/\\xFF/g, 'ÿ');
    const out = new Uint8Array(normalized.length);
    for (let i = 0; i < normalized.length; i += 1) out[i] = normalized.charCodeAt(i) & 0xff;
    return out;
  }

  function streamObject(dict, bytes) {
    return concatBytes(ascii(`${dict}\nstream\n`), bytes, ascii('\nendstream'));
  }

  function concatBytes(...arrays) {
    const length = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const array of arrays) { out.set(array, offset); offset += array.length; }
    return out;
  }
}

function buildFilenameBase(sessionData) {
  const template = sessionData.settings?.filenameTemplate || '{host}_{date}_{time}';
  let url;
  try { url = new URL(sessionData.sourceUrl); } catch { url = null; }
  const now = new Date(sessionData.completedAt || Date.now());
  const tokens = {
    host: url?.hostname || 'capture',
    title: sessionData.title || 'capture',
    path: url?.pathname?.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'page',
    date: formatDate(now),
    time: formatTime(now)
  };
  let name = template.replace(/\{(host|title|path|date|time)\}/g, (_, key) => tokens[key]);
  name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim();
  return name || 'capture';
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}-${m}-${s}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode image.')), type, quality);
  });
}

function clearPartUrls() {
  for (const part of partUrls) URL.revokeObjectURL(part.url);
  partUrls = [];
}

function showError(error) {
  console.error(error);
  els.statusCard.classList.add('hidden');
  els.viewer.classList.add('hidden');
  els.errorCard.classList.remove('hidden');
  els.errorText.textContent = error?.message || String(error);
  els.captureMeta.textContent = 'Capture error';
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmt(n) { return Number(n).toFixed(2).replace(/\.00$/, ''); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tiles')) {
        const tiles = db.createObjectStore('tiles', { keyPath: 'key' });
        tiles.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSession(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function getTiles(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const rows = [];
      const tx = db.transaction('tiles', 'readonly');
      const req = tx.objectStore('tiles').index('sessionId').openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        rows.push(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(rows.sort((a, b) => a.index - b.index));
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

window.addEventListener('beforeunload', () => {
  clearPartUrls();
  for (const tile of decodedTiles) tile.bitmap?.close?.();
});
