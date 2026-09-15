(() => {
  if (window.__PAGEFORGE_CAPTURE_INSTALLED__) return;
  window.__PAGEFORGE_CAPTURE_INSTALLED__ = true;

  const state = {
    sessionId: null,
    settings: null,
    target: null,
    targetType: 'document',
    original: null,
    fixed: [],
    sticky: [],
    styleTag: null,
    currentlyVisibleSticky: []
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type?.startsWith('PFC_')) return;

    (async () => {
      switch (message.type) {
        case 'PFC_PREPARE':
          sendResponse(await prepare(message));
          break;
        case 'PFC_SCROLL_TO':
          sendResponse(await scrollToPosition(message));
          break;
        case 'PFC_MARK_CAPTURED':
          markCaptured(message);
          sendResponse({ ok: true });
          break;
        case 'PFC_RESTORE':
          sendResponse(await restore(message));
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown PageForge message.' });
      }
    })().catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

    return true;
  });

  async function prepare(message) {
    if (state.sessionId) await restore({ sessionId: state.sessionId });

    state.sessionId = message.sessionId;
    state.settings = message.settings || {};
    state.target = chooseScrollTarget(Boolean(state.settings.detectInnerScroller));
    state.targetType = state.target === document.scrollingElement ? 'document' : 'inner';

    const root = document.documentElement;
    const body = document.body;
    state.original = {
      windowX: window.scrollX,
      windowY: window.scrollY,
      targetX: state.target?.scrollLeft || 0,
      targetY: state.target?.scrollTop || 0,
      rootScrollBehavior: root.style.scrollBehavior,
      bodyScrollBehavior: body?.style.scrollBehavior || '',
      targetScrollBehavior: state.target?.style?.scrollBehavior || '',
      rootScrollbarWidth: root.style.scrollbarWidth,
      bodyScrollbarWidth: body?.style?.scrollbarWidth || '',
      targetScrollbarWidth: state.target?.style?.scrollbarWidth || '',
      targetMarker: state.target?.dataset?.pageforgeScrollTarget || ''
    };

    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';
    if (state.target?.style) state.target.style.scrollBehavior = 'auto';

    if (state.targetType === 'inner' && state.target?.dataset) state.target.dataset.pageforgeScrollTarget = 'true';
    installCaptureStyles();
    collectPositionedElements();

    if (state.targetType === 'document') {
      window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    } else {
      state.target.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }
    await settle();

    const metrics = getMetrics();
    return {
      ok: true,
      targetType: state.targetType,
      contentWidth: metrics.contentWidth,
      contentHeight: metrics.contentHeight,
      captureViewportWidth: metrics.captureViewportWidth,
      captureViewportHeight: metrics.captureViewportHeight,
      browserViewportWidth: window.innerWidth,
      browserViewportHeight: window.innerHeight,
      initialCaptureRect: metrics.captureRect,
      devicePixelRatio: window.devicePixelRatio,
      sourceUrl: location.href,
      pageTitle: document.title
    };
  }

  async function scrollToPosition(message) {
    if (message.sessionId !== state.sessionId) {
      return { ok: false, error: 'Capture session mismatch.' };
    }

    restoreElementVisibility();

    if (state.targetType === 'document') {
      window.scrollTo({ left: message.x, top: message.y, behavior: 'auto' });
    } else {
      state.target.scrollTo({ left: message.x, top: message.y, behavior: 'auto' });
    }

    await settle();
    applyPositionedElementRules(message.tileIndex === 1);
    await nextFrame();

    const metrics = getMetrics();
    const actualX = state.targetType === 'document' ? window.scrollX : state.target.scrollLeft;
    const actualY = state.targetType === 'document' ? window.scrollY : state.target.scrollTop;

    return {
      ok: true,
      actualX,
      actualY,
      captureRect: metrics.captureRect,
      browserViewportWidth: window.innerWidth,
      browserViewportHeight: window.innerHeight
    };
  }

  function markCaptured(message) {
    if (message.sessionId !== state.sessionId) return;
    for (const item of state.currentlyVisibleSticky) item.seen = true;
    state.currentlyVisibleSticky = [];
  }

  async function restore(message) {
    if (!state.sessionId || (message.sessionId && message.sessionId !== state.sessionId)) {
      return { ok: true };
    }

    restoreElementVisibility(true);
    state.styleTag?.remove();
    state.styleTag = null;

    const root = document.documentElement;
    const body = document.body;
    if (state.original) {
      root.style.scrollBehavior = state.original.rootScrollBehavior;
      root.style.scrollbarWidth = state.original.rootScrollbarWidth;
      if (body) {
        body.style.scrollBehavior = state.original.bodyScrollBehavior;
        body.style.scrollbarWidth = state.original.bodyScrollbarWidth;
      }
      if (state.target?.style) {
        state.target.style.scrollBehavior = state.original.targetScrollBehavior;
        state.target.style.scrollbarWidth = state.original.targetScrollbarWidth;
      }
      if (state.target?.dataset) {
        if (state.original.targetMarker) state.target.dataset.pageforgeScrollTarget = state.original.targetMarker;
        else delete state.target.dataset.pageforgeScrollTarget;
      }

      if (state.targetType === 'document') {
        window.scrollTo({ left: state.original.windowX, top: state.original.windowY, behavior: 'auto' });
      } else if (state.target) {
        state.target.scrollTo({ left: state.original.targetX, top: state.original.targetY, behavior: 'auto' });
      }
    }

    state.sessionId = null;
    state.settings = null;
    state.target = null;
    state.targetType = 'document';
    state.original = null;
    state.fixed = [];
    state.sticky = [];
    state.currentlyVisibleSticky = [];
    return { ok: true };
  }

  function getMetrics() {
    if (state.targetType === 'document') {
      const root = document.documentElement;
      const body = document.body;
      const contentWidth = Math.max(
        root.scrollWidth,
        root.clientWidth,
        body?.scrollWidth || 0,
        body?.clientWidth || 0
      );
      const contentHeight = Math.max(
        root.scrollHeight,
        root.clientHeight,
        body?.scrollHeight || 0,
        body?.clientHeight || 0
      );
      return {
        contentWidth,
        contentHeight,
        captureViewportWidth: window.innerWidth,
        captureViewportHeight: window.innerHeight,
        captureRect: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      };
    }

    const rect = state.target.getBoundingClientRect();
    return {
      contentWidth: state.target.scrollWidth,
      contentHeight: state.target.scrollHeight,
      captureViewportWidth: state.target.clientWidth,
      captureViewportHeight: state.target.clientHeight,
      captureRect: {
        left: rect.left + state.target.clientLeft,
        top: rect.top + state.target.clientTop,
        width: state.target.clientWidth,
        height: state.target.clientHeight
      }
    };
  }

  function chooseScrollTarget(allowInner) {
    const root = document.scrollingElement || document.documentElement;
    if (!allowInner) return root;

    const rootScrollable = root.scrollHeight > window.innerHeight + 64 || root.scrollWidth > window.innerWidth + 64;
    let best = null;
    let bestScore = 0;
    const all = document.querySelectorAll('body *');
    const limit = Math.min(all.length, 7000);

    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      if (!(el instanceof HTMLElement)) continue;
      if (el.clientHeight < window.innerHeight * 0.35 || el.clientWidth < window.innerWidth * 0.35) continue;
      if (el.scrollHeight <= el.clientHeight + 80 && el.scrollWidth <= el.clientWidth + 80) continue;

      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      const ox = cs.overflowX;
      const scrollableStyle = ['auto', 'scroll', 'overlay'].includes(oy) || ['auto', 'scroll', 'overlay'].includes(ox);
      if (!scrollableStyle) continue;

      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      if (visibleWidth * visibleHeight < window.innerWidth * window.innerHeight * 0.22) continue;

      const verticalGain = Math.max(1, el.scrollHeight / Math.max(1, el.clientHeight));
      const score = visibleWidth * visibleHeight * verticalGain;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    if (!best) return root;
    if (!rootScrollable) return best;

    const rootGain = Math.max(1, root.scrollHeight / Math.max(1, window.innerHeight));
    const bestGain = Math.max(1, best.scrollHeight / Math.max(1, best.clientHeight));
    return bestGain > rootGain * 1.6 ? best : root;
  }

  function collectPositionedElements() {
    state.fixed = [];
    state.sticky = [];
    if (!state.settings.handleFixedElements && !state.settings.handleStickyElements) return;

    const all = document.querySelectorAll('body *');
    const limit = Math.min(all.length, 10000);
    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      if (cs.position === 'fixed' && state.settings.handleFixedElements) {
        state.fixed.push({ el, visibility: el.style.visibility });
      } else if (cs.position === 'sticky' && state.settings.handleStickyElements) {
        state.sticky.push({ el, visibility: el.style.visibility, seen: false });
      }
    }
  }

  function applyPositionedElementRules(isFirstTile) {
    state.currentlyVisibleSticky = [];

    for (const item of state.fixed) {
      item.el.style.visibility = isFirstTile ? item.visibility : 'hidden';
    }

    for (const item of state.sticky) {
      const el = item.el;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const topValue = parsePx(cs.top);
      const bottomValue = parsePx(cs.bottom);
      const stuckAtTop = Number.isFinite(topValue) && Math.abs(rect.top - topValue) <= 2;
      const stuckAtBottom = Number.isFinite(bottomValue) && Math.abs((window.innerHeight - rect.bottom) - bottomValue) <= 2;
      const isStuck = stuckAtTop || stuckAtBottom;

      if (isStuck && item.seen) {
        el.style.visibility = 'hidden';
      } else {
        el.style.visibility = item.visibility;
        if (isStuck) state.currentlyVisibleSticky.push(item);
      }
    }
  }

  function restoreElementVisibility(resetSeen = false) {
    for (const item of state.fixed) item.el.style.visibility = item.visibility;
    for (const item of state.sticky) {
      item.el.style.visibility = item.visibility;
      if (resetSeen) item.seen = false;
    }
    state.currentlyVisibleSticky = [];
  }

  function installCaptureStyles() {
    state.styleTag?.remove();
    const style = document.createElement('style');
    style.dataset.pageforgeCapture = 'true';
    const animationRules = state.settings.pauseAnimations
      ? `*, *::before, *::after { animation-play-state: paused !important; transition-duration: 0s !important; caret-color: transparent !important; }`
      : '';
    style.textContent = `
      html, body { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, [data-pageforge-scroll-target="true"]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      ${animationRules}
    `;
    document.documentElement.appendChild(style);
    state.styleTag = style;

    document.documentElement.style.scrollbarWidth = 'none';
    if (document.body) document.body.style.scrollbarWidth = 'none';
    if (state.target?.style) state.target.style.scrollbarWidth = 'none';
  }

  async function settle() {
    await nextFrame();
    await nextFrame();
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function parsePx(value) {
    if (!value || value === 'auto') return NaN;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
})();
