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
    currentlyVisibleSticky: [],
    expanded: [],
    clippedAncestors: []
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
    state.target = document.scrollingElement || document.documentElement;
    state.targetType = 'document';

    const root = document.documentElement;
    const body = document.body;
    state.original = {
      windowX: window.scrollX,
      windowY: window.scrollY,
      rootScrollBehavior: root.style.scrollBehavior,
      bodyScrollBehavior: body?.style.scrollBehavior || '',
      rootScrollbarWidth: root.style.scrollbarWidth,
      bodyScrollbarWidth: body?.style?.scrollbarWidth || ''
    };

    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';

    installCaptureStyles();
    if (state.settings.detectInnerScroller) {
      const candidates = findExpandableScrollContainers();
      state.clippedAncestors = expandClippingAncestors(collectClippingAncestors(candidates));
      state.expanded = expandScrollableRegions(candidates);
    } else {
      state.expanded = [];
      state.clippedAncestors = [];
    }
    collectPositionedElements();

    window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    await settle();

    const metrics = getMetrics();
    return {
      ok: true,
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

    window.scrollTo({ left: message.x, top: message.y, behavior: 'auto' });

    await settle();
    applyPositionedElementRules(message.tileIndex === 1);
    await nextFrame();

    const metrics = getMetrics();
    const actualX = window.scrollX;
    const actualY = window.scrollY;

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
    restoreScrollableRegions(state.expanded || []);
    state.expanded = [];
    restoreClippingAncestors(state.clippedAncestors || []);
    state.clippedAncestors = [];
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

      window.scrollTo({ left: state.original.windowX, top: state.original.windowY, behavior: 'auto' });
    }

    state.sessionId = null;
    state.settings = null;
    state.target = null;
    state.targetType = 'document';
    state.original = null;
    state.fixed = [];
    state.sticky = [];
    state.currentlyVisibleSticky = [];
    state.expanded = [];
    state.clippedAncestors = [];
    return { ok: true };
  }

  function getMetrics() {
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

  function findExpandableScrollContainers() {
    const candidates = [];
    const all = document.querySelectorAll('body *');
    const limit = Math.min(all.length, 7000);
    const viewportHeight = window.innerHeight;

    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      if (!(el instanceof HTMLElement)) continue;
      if (el.clientHeight < viewportHeight * 0.35) continue;
      if (el.scrollHeight <= el.clientHeight + 80) continue;

      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      if (!['auto', 'scroll', 'overlay'].includes(cs.overflowY)) continue;

      candidates.push({ el, targetHeight: el.scrollHeight });
    }
    return candidates;
  }

  function saveInlineProp(el, prop) {
    return {
      had: el.style.getPropertyValue(prop) !== '',
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop)
    };
  }

  function restoreInlineProp(el, prop, saved) {
    if (saved.had) el.style.setProperty(prop, saved.value, saved.priority);
    else el.style.removeProperty(prop);
  }

  function expandScrollableRegions(candidates) {
    const expanded = [];
    for (const { el, targetHeight } of candidates) {
      expanded.push({
        el,
        transition: saveInlineProp(el, 'transition'),
        flex: saveInlineProp(el, 'flex'),
        maxHeight: saveInlineProp(el, 'max-height'),
        height: saveInlineProp(el, 'height'),
        overflowY: saveInlineProp(el, 'overflow-y')
      });
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('flex', 'none', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', `${targetHeight}px`, 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
    }
    return expanded;
  }

  function restoreScrollableRegions(list) {
    for (const item of list) {
      restoreInlineProp(item.el, 'transition', item.transition);
      restoreInlineProp(item.el, 'flex', item.flex);
      restoreInlineProp(item.el, 'max-height', item.maxHeight);
      restoreInlineProp(item.el, 'height', item.height);
      restoreInlineProp(item.el, 'overflow-y', item.overflowY);
    }
  }

  // A qualifying container's own box can grow, but that growth only makes the
  // *document* taller if nothing between it and <html> clips or independently
  // scroll-contains it. SPA "app-shell" layouts commonly pin html/body (or a
  // #root/#app wrapper) to a fixed viewport height with overflow hidden so only
  // one inner pane scrolls — walk up and temporarily unclip that whole chain so
  // the expanded content bubbles up into the real, capturable document height.
  function collectClippingAncestors(candidates) {
    const seen = new Set();
    const ancestors = [];
    for (const { el } of candidates) {
      let node = el.parentElement;
      while (node) {
        if (seen.has(node)) break;
        seen.add(node);

        const cs = getComputedStyle(node);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          ancestors.push(node);
        }
        if (node === document.documentElement) break;
        node = node.parentElement;
      }
    }
    return ancestors;
  }

  function expandClippingAncestors(ancestors) {
    const expanded = [];
    for (const el of ancestors) {
      expanded.push({
        el,
        overflowX: saveInlineProp(el, 'overflow-x'),
        overflowY: saveInlineProp(el, 'overflow-y')
      });
      // Both axes are forced together: if only one of overflow-x/overflow-y is
      // 'visible', the UA computes the visible one as 'auto' instead (CSS2.1
      // 11.1.1), which would silently re-create a clipping scroll container.
      el.style.setProperty('overflow-x', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
    }
    return expanded;
  }

  function restoreClippingAncestors(list) {
    for (const item of list) {
      restoreInlineProp(item.el, 'overflow-x', item.overflowX);
      restoreInlineProp(item.el, 'overflow-y', item.overflowY);
    }
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
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      ${animationRules}
    `;
    document.documentElement.appendChild(style);
    state.styleTag = style;

    document.documentElement.style.scrollbarWidth = 'none';
    if (document.body) document.body.style.scrollbarWidth = 'none';
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
