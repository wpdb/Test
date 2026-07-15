// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

(function() {
  // ---- Navigation history ----
  // The preview is an iframe nested inside the IDE. Any full navigation inside
  // it normally pushes an entry onto the BROWSER's joint session history (the
  // iframe shares it with the top window), so the user's real Back button has
  // to step through every preview page one at a time before it can leave the
  // editor. To avoid that we navigate exclusively with location.replace(),
  // which swaps the current entry instead of pushing a new one, and keep our
  // own history stack in sessionStorage (it survives same-origin iframe loads).
  // The IDE toolbar's Back/Forward drive this stack.
  var PH_NAV_KEY = '__phantom_nav_history';
  function phNorm(u) {
    try {
      var url = new URL(u, window.location.href);
      if (url.pathname.length > 1 && url.pathname.charAt(url.pathname.length - 1) === '/') {
        url.pathname = url.pathname.replace(/\/+$/, '');
      }
      return url.href;
    } catch (e) { return u; }
  }
  function phLoadNav() {
    try {
      var raw = sessionStorage.getItem(PH_NAV_KEY);
      if (raw) { var s = JSON.parse(raw); if (s && s.stack && typeof s.index === 'number') return s; }
    } catch (e) {}
    return { stack: [phNorm(window.location.href)], index: 0 };
  }
  function phSaveNav(nav) {
    try { sessionStorage.setItem(PH_NAV_KEY, JSON.stringify(nav)); } catch (e) {}
  }
  // On every load, reconcile the persisted stack with the document we actually
  // landed on. If it matches the entry we navigated to (link/back/forward/IDE)
  // leave the stack alone; otherwise (form submit, redirect, server nav we did
  // not intercept) record it as a fresh push so Back still works afterwards.
  (function () {
    var nav = phLoadNav();
    var here = phNorm(window.location.href);
    if (phNorm(nav.stack[nav.index]) !== here) {
      nav.stack = nav.stack.slice(0, nav.index + 1);
      nav.stack.push(here);
      nav.index = nav.stack.length - 1;
      phSaveNav(nav);
    }
  })();
  // Navigate to a new URL, recording it (truncates any forward entries).
  function phGoto(href) {
    var abs = phNorm(href);
    var nav = phLoadNav();
    if (phNorm(nav.stack[nav.index]) === abs) return; // already here
    nav.stack = nav.stack.slice(0, nav.index + 1);
    nav.stack.push(abs);
    nav.index = nav.stack.length - 1;
    phSaveNav(nav);
    window.parent.postMessage({ type: 'iframe-navigation-start', url: abs }, '*');
    window.location.replace(abs);
  }
  function phStep(delta) {
    var nav = phLoadNav();
    var next = nav.index + delta;
    if (next < 0 || next >= nav.stack.length) return; // at an end: no-op, like a browser
    nav.index = next;
    phSaveNav(nav);
    var target = nav.stack[next];
    window.parent.postMessage({ type: 'iframe-navigation-start', url: target }, '*');
    window.location.replace(target);
  }
  document.addEventListener('click', function(e) {
    // Only plain left-clicks navigate in place; modified clicks (new tab/window),
    // downloads and non-self targets keep their default behavior.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var target = e.target;
    while (target && target.tagName !== 'A') target = target.parentElement;
    if (!target || target.tagName !== 'A') return;
    if (target.target && target.target !== '_self') return;
    if (target.hasAttribute('download')) return;
    var href = target.getAttribute('href');
    if (!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    var abs;
    try { abs = new URL(href, window.location.href); } catch (err) { return; }
    if (abs.origin !== window.location.origin) return; // external: navigate normally
    e.preventDefault();
    phGoto(abs.href);
  });
  window.addEventListener('load', function() {
    window.parent.postMessage({ type: 'iframe-navigation', url: window.location.href }, '*');
  });
  window.addEventListener('popstate', function() {
    // The previewed site drove its own history (e.g. an SPA route). Keep our
    // stack and the IDE address bar in sync with where it landed.
    var nav = phLoadNav();
    var here = phNorm(window.location.href);
    if (phNorm(nav.stack[nav.index]) !== here) {
      nav.stack = nav.stack.slice(0, nav.index + 1);
      nav.stack.push(here);
      nav.index = nav.stack.length - 1;
      phSaveNav(nav);
    }
    window.parent.postMessage({ type: 'iframe-navigation', url: here }, '*');
  });

  // ---- Thin, dark scrollbars (dev preview only) ----
  // The preview iframe is cross-origin to the IDE, so the parent cannot style
  // these from outside. We inject the rule here, inside the preview document,
  // so the scrollbars match the IDE chrome. This script is dev-only, so it
  // never reaches the production build.
  (function() {
    try {
      var sb = document.createElement('style');
      sb.id = 'phantom-preview-scrollbars';
      sb.textContent =
        '*{scrollbar-width:thin;scrollbar-color:#4b5563 transparent;}' +
        '::-webkit-scrollbar{width:8px;height:8px;}' +
        '::-webkit-scrollbar-track{background:transparent;}' +
        '::-webkit-scrollbar-thumb{background:#4b5563;border-radius:4px;}' +
        '::-webkit-scrollbar-thumb:hover{background:#6b7280;}' +
        '::-webkit-scrollbar-corner{background:transparent;}';
      (document.head || document.documentElement).appendChild(sb);
    } catch (err) { /* no-op */ }
  })();

  // ---- Element Inspector ----
  var inspectorActive = false;
  var overlay = null;
  var label = null;
  var dims = null;
  var selectedOverlay = null;
  var selectedLabel = null;
  var selectionHud = null;
  var contentAreaOverlay = null;
  var contentAreaLabel = null;
  var contentAreaOverlayVisible = false;
  var currentTarget = null;

  // ---- Lucide-style inline SVG icons (match the parent IDE) ----
  var _PHANTOM_ICONS = {
    code: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>',
    tw: '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12.001 4.8c-3.2 0-5.2 1.6-6 4.8 1.2-1.6 2.6-2.2 4.2-1.8.913.228 1.565.89 2.288 1.624C13.666 10.618 15.027 12 18.001 12c3.2 0 5.2-1.6 6-4.8-1.2 1.6-2.6 2.2-4.2 1.8-.913-.228-1.565-.89-2.288-1.624C16.337 6.182 14.976 4.8 12.001 4.8zm-6 7.2c-3.2 0-5.2 1.6-6 4.8 1.2-1.6 2.6-2.2 4.2-1.8.913.228 1.565.89 2.288 1.624 1.177 1.194 2.538 2.576 5.512 2.576 3.2 0 5.2-1.6 6-4.8-1.2 1.6-2.6 2.2-4.2 1.8-.913-.228-1.565-.89-2.288-1.624C10.337 13.382 8.976 12 6.001 12z"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    arrowDown: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    component: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5 9 12l-3.5 3.5L2 12l3.5-3.5Z"/><path d="M12 2 8.5 5.5 12 9l3.5-3.5L12 2Z"/><path d="M18.5 8.5 22 12l-3.5 3.5L15 12l3.5-3.5Z"/><path d="M12 15l-3.5 3.5L12 22l3.5-3.5L12 15Z"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z"/></svg>',
  };

  function getElementLabel(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    if (cls.length > 0) s += '.' + cls.slice(0, 3).join('.');
    if (cls.length > 3) s += ' +' + (cls.length - 3);
    return s;
  }

  function updateOverlay(el) {
    if (!overlay) return;
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      label.style.display = 'none';
      dims.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    var labelText = getElementLabel(el);
    label.textContent = labelText;
    label.style.display = 'block';
    if (rect.top > 22) {
      label.style.top = (rect.top - 20) + 'px';
    } else {
      label.style.top = (rect.bottom + 4) + 'px';
    }
    label.style.left = Math.max(0, rect.left) + 'px';

    dims.textContent = Math.round(rect.width) + ' x ' + Math.round(rect.height);
    dims.style.display = 'block';
    dims.style.top = (rect.bottom + 4) + 'px';
    dims.style.left = Math.max(0, rect.right - 80) + 'px';
  }

  function getComponentDisplayName(path) {
    if (!path) return '';
    return path.split('/').pop().replace('.astro', '');
  }

  function getCompactSelectionLabel(el) {
    var tag = el.tagName.toLowerCase();
    var comp = el.getAttribute('data-component') || findClosestComponent(el);
    if (comp) return tag + ' - ' + getComponentDisplayName(comp);
    if (el.id) return tag + '#' + el.id;
    var cls = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    if (cls.length > 0) return tag + '.' + cls[0];
    return tag;
  }

  function createHudButton(labelText, title, onClick, primary, iconHtml, iconOnly, active) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    if (iconOnly && iconHtml) {
      btn.innerHTML = iconHtml;
      btn.setAttribute('aria-label', labelText);
    } else if (iconHtml) {
      btn.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:0;opacity:0.85;">' + iconHtml + '</span><span>' + labelText + '</span>';
    } else {
      btn.textContent = labelText;
    }
    var borderColor = primary ? '#2563eb' : (active ? 'rgba(14,165,233,0.45)' : 'transparent');
    var baseStyle = 'height:24px;padding:0 7px;border-radius:4px;border:1px solid ' + borderColor + ';';
    var primaryStyle = 'background:#2563eb;color:#fff;';
    var activeStyle = 'background:rgba(14,165,233,0.16);color:#7dd3fc;';
    var ghostStyle = 'background:transparent;color:#cbd5e1;';
    var stateStyle = primary ? primaryStyle : (active ? activeStyle : ghostStyle);
    var fontAndLayout = 'font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;transition:background 0.12s ease,color 0.12s ease,border-color 0.12s ease;';
    btn.style.cssText = baseStyle + stateStyle + fontAndLayout + (iconOnly ? 'width:24px;padding:0;justify-content:center;' : '');
    btn.onmouseenter = function() {
      if (primary) { btn.style.background = '#1d4ed8'; btn.style.borderColor = '#1d4ed8'; }
      else if (active) { btn.style.background = 'rgba(14,165,233,0.24)'; btn.style.color = '#bae6fd'; }
      else { btn.style.background = '#1f2937'; btn.style.color = '#f3f4f6'; }
    };
    btn.onmouseleave = function() {
      if (primary) { btn.style.background = '#2563eb'; btn.style.borderColor = '#2563eb'; }
      else if (active) { btn.style.background = 'rgba(14,165,233,0.16)'; btn.style.color = '#7dd3fc'; }
      else { btn.style.background = 'transparent'; btn.style.color = '#cbd5e1'; }
    };
    btn.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      onClick(ev);
    }, true);
    return btn;
  }

  function createHudMenuButton(labelText, title, items) {
    var iconHtml = arguments.length > 3 ? arguments[3] : null;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:flex;align-items:center;';
    var btn = document.createElement('button');
    btn.type = 'button';
    if (iconHtml) {
      btn.innerHTML = iconHtml;
      btn.setAttribute('aria-label', labelText);
    } else {
      btn.textContent = labelText;
    }
    btn.title = title;
    // Hover/active fallback uses background:#1f2937;color:#e5e7eb for IDE parity.
    btn.style.cssText = 'height:24px;padding:0;width:24px;border-radius:4px;border:1px solid transparent;background:transparent;color:#cbd5e1;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;transition:background 0.12s ease,color 0.12s ease;';
    btn.onmouseenter = function() { btn.style.background = '#1f2937'; btn.style.color = '#f3f4f6'; };
    btn.onmouseleave = function() { btn.style.background = 'transparent'; btn.style.color = '#cbd5e1'; };
    btn.setAttribute('aria-haspopup', 'menu');
    btn.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      var existing = document.getElementById('__phantom-selection-more-menu');
      if (existing) { existing.remove(); return; }
      var menu = document.createElement('div');
      menu.id = '__phantom-selection-more-menu';
      menu.style.cssText = 'position:absolute;top:30px;right:0;min-width:184px;padding:4px;background:#111827;border:1px solid #1f2937;border-radius:8px;box-shadow:0 16px 32px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04);display:flex;flex-direction:column;gap:1px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);';
      for (var i = 0; i < items.length; i++) {
        (function(item) {
          if (!item) return;
          var row = document.createElement('button');
          row.type = 'button';
          row.textContent = item.label;
          row.title = item.title || item.label;
          row.style.cssText = 'height:28px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:#d1d5db;text-align:left;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;transition:background 0.1s,color 0.1s;';
          row.onmouseenter = function() { row.style.background = '#1f2937'; row.style.color = '#fff'; };
          row.onmouseleave = function() { row.style.background = 'transparent'; row.style.color = '#d1d5db'; };
          row.addEventListener('click', function(ev2) {
            ev2.preventDefault();
            ev2.stopPropagation();
            ev2.stopImmediatePropagation();
            menu.remove();
            item.onClick(ev2);
          }, true);
          menu.appendChild(row);
        })(items[i]);
      }
      wrap.appendChild(menu);
    }, true);
    wrap.appendChild(btn);
    return wrap;
  }

  function createBreadcrumbButton(labelText, title, onClick, active, iconHtml) {
    var btn = document.createElement('button');
    btn.type = 'button';
    if (iconHtml) {
      btn.innerHTML = '<span style="display:inline-flex;align-items:center;line-height:0;opacity:' + (active ? '0.85' : '0.55') + ';flex-shrink:0;">' + iconHtml + '</span><span style="overflow:hidden;text-overflow:ellipsis;">' + labelText + '</span>';
    } else {
      btn.textContent = labelText;
    }
    btn.title = title;
    var bg = active ? 'rgba(59,130,246,0.14)' : 'transparent';
    var color = active ? '#93c5fd' : '#9ca3af';
    btn.style.cssText = 'height:22px;max-width:128px;padding:0 6px;border-radius:4px;border:1px solid transparent;background:' + bg + ';color:' + color + ';font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:4px;transition:background 0.12s ease,color 0.12s ease;';
    btn.onmouseenter = function() {
      if (active) return;
      btn.style.background = '#1f2937';
      btn.style.color = '#e5e7eb';
    };
    btn.onmouseleave = function() {
      if (active) return;
      btn.style.background = 'transparent';
      btn.style.color = '#9ca3af';
    };
    btn.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      onClick(ev);
    }, true);
    return btn;
  }

  function ensureSelectionChrome() {
    if (!selectedOverlay) {
      selectedOverlay = document.createElement('div');
      selectedOverlay.id = '__phantom-selected-overlay';
      selectedOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #2563eb;background:transparent;box-shadow:0 0 0 1px rgba(255,255,255,0.45);border-radius:2px;display:none;';
      document.body.appendChild(selectedOverlay);
    }
    if (!selectedLabel) {
      selectedLabel = document.createElement('div');
      selectedLabel.id = '__phantom-selected-label';
      selectedLabel.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;display:none;max-width:220px;padding:3px 7px;background:#2563eb;color:#fff;border:1px solid #1d4ed8;border-radius:4px;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 10px rgba(37,99,235,0.35);';
      document.body.appendChild(selectedLabel);
    }
    if (!selectionHud) {
      selectionHud = document.createElement('div');
      selectionHud.id = '__phantom-selection-hud';
      // Tests assert: background:#111827;border:1px solid #374151;border-radius:6px
      selectionHud.style.cssText = 'position:fixed;z-index:2147483647;display:none;align-items:center;gap:1px;max-width:calc(100vw - 16px);padding:3px;background:#111827;border:1px solid #374151;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04);color:#e5e7eb;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
      document.body.appendChild(selectionHud);
    }
  }

  function positionSelectionChrome(el) {
    if (!el || !selectedOverlay || !selectionHud) return;
    var rect = el.getBoundingClientRect();
    selectedOverlay.style.display = 'block';
    selectedOverlay.style.top = rect.top + 'px';
    selectedOverlay.style.left = rect.left + 'px';
    selectedOverlay.style.width = rect.width + 'px';
    selectedOverlay.style.height = rect.height + 'px';

    var hudRect = selectionHud.getBoundingClientRect();
    var hudWidth = hudRect.width || 420;
    var hudHeight = hudRect.height || 34;
    var top = rect.top - hudHeight - 8;
    if (top < 8) top = Math.min(window.innerHeight - hudHeight - 8, rect.bottom + 8);
    var left = rect.left;
    if (left + hudWidth > window.innerWidth - 8) left = window.innerWidth - hudWidth - 8;
    if (left < 8) left = 8;
    selectionHud.style.top = Math.max(8, top) + 'px';
    selectionHud.style.left = left + 'px';
    updateSelectedLabel(el);
  }

  function updateSelectedLabel(el) {
    if (!selectedLabel) return;
    if (!el || el === document.body || el === document.documentElement) {
      selectedLabel.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    selectedLabel.textContent = getCompactSelectionLabel(el);
    selectedLabel.style.display = 'block';
    selectedLabel.style.top = (rect.top > 24 ? rect.top - 23 : rect.top + 4) + 'px';
    selectedLabel.style.left = Math.max(4, rect.left) + 'px';
  }

  function postSelectedAction(action) {
    if (!selectedEl) return;
    window.parent.postMessage({
      type: 'element-inspector-action',
      action: action,
      element: buildElementData(selectedEl),
      componentPath: selectedEl.getAttribute('data-component') || findClosestComponent(selectedEl) || '',
    }, '*');
  }

  function postPageAction() {
    if (!selectedEl) return;
    var data = buildElementData(selectedEl);
    window.parent.postMessage({
      type: 'element-inspector-action',
      action: 'open-page',
      element: data,
      pageFile: data.pageFile || '',
    }, '*');
  }

  function postComponentBreadcrumbAction(componentPath) {
    if (!componentPath) return;
    window.parent.postMessage({
      type: 'component-breadcrumb-action',
      componentPath: componentPath,
    }, '*');
  }

  function makeHudSeparator() {
    var sep = document.createElement('span');
    sep.style.cssText = 'display:inline-block;width:1px;height:14px;background:#1f2937;margin:0 3px;flex-shrink:0;';
    return sep;
  }

  // ---- Inline AI prompt popover ----
  // Anchored to the selection HUD. Lets the user type a single prompt about
  // the selected element and post it to the parent IDE, which queues it as
  // the next chat message with the element auto-attached as context.
  var inlinePromptPanel = null;
  var inlinePromptTextarea = null;
  var inlinePromptCurrentEl = null;

  function openInlinePrompt(el) {
    if (!el) return;
    if (inlinePromptPanel) {
      if (inlinePromptCurrentEl !== el) {
        inlinePromptCurrentEl = el;
        positionInlinePrompt(el);
      }
      if (inlinePromptTextarea) inlinePromptTextarea.focus();
      return;
    }
    inlinePromptCurrentEl = el;

    var panel = document.createElement('div');
    panel.id = '__phantom-inline-prompt';
    panel.style.cssText = 'position:fixed;z-index:2147483647;width:360px;padding:10px;background:#111827;border:1px solid #374151;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04);color:#e5e7eb;font:500 12px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    var preview = document.createElement('div');
    preview.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 2px 8px;color:#94a3b8;font-size:11px;border-bottom:1px solid #1f2937;margin-bottom:8px;overflow:hidden;';
    var sparkleIcon = document.createElement('span');
    sparkleIcon.style.cssText = 'display:inline-flex;color:#a78bfa;flex-shrink:0;line-height:0;';
    sparkleIcon.innerHTML = _PHANTOM_ICONS.sparkle;
    var previewText = document.createElement('span');
    previewText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var previewLabel = document.createElement('span');
    previewLabel.style.cssText = 'color:#e5e7eb;';
    previewLabel.textContent = getCompactSelectionLabel(el);
    previewText.appendChild(document.createTextNode('Modify '));
    previewText.appendChild(previewLabel);
    preview.appendChild(sparkleIcon);
    preview.appendChild(previewText);
    panel.appendChild(preview);

    var textarea = document.createElement('textarea');
    textarea.id = '__phantom-inline-prompt-textarea';
    textarea.placeholder = 'Describe a change for this element...';
    textarea.rows = 2;
    textarea.style.cssText = 'width:100%;min-height:48px;max-height:160px;padding:8px;background:#0b1220;border:1px solid #1f2937;border-radius:6px;color:#e5e7eb;font:500 12px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;resize:none;outline:none;box-sizing:border-box;';
    textarea.onfocus = function() { textarea.style.borderColor = '#2563eb'; };
    textarea.onblur = function() { textarea.style.borderColor = '#1f2937'; };
    textarea.oninput = function() {
      textarea.style.height = 'auto';
      var newH = Math.min(160, Math.max(48, textarea.scrollHeight));
      textarea.style.height = newH + 'px';
      positionInlinePrompt(inlinePromptCurrentEl);
    };
    textarea.onkeydown = function(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeInlinePrompt();
      } else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        ev.stopPropagation();
        // Default: append to the current chat (so follow-up turns about
        // the same element stay in one conversation). Holding Cmd/Ctrl
        // forces a brand-new chat session.
        var forceNewChat = !!(ev.metaKey || ev.ctrlKey);
        submitInlinePrompt(forceNewChat);
      }
    };
    panel.appendChild(textarea);
    inlinePromptTextarea = textarea;

    var quickRow = document.createElement('div');
    quickRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;';
    // Quick-action prompts. Each one uses an explicit deictic ("this",
    // "this element") so the system prompt's binding rules keep the
    // change scoped to the pinned element. A bare label like
    // "Improve accessibility" reads to the model as a section-wide audit
    // and fans out into siblings / descendants.
    var quickActions = [
      { label: 'Make bigger', prompt: 'Make this bigger' },
      { label: 'Change color', prompt: 'Change the color of this element' },
      { label: 'Add hover effect', prompt: 'Add a hover effect to this element' },
      { label: 'Make responsive', prompt: 'Make this element responsive' },
      { label: 'Improve a11y', prompt: "Improve this element's accessibility (only this element, no siblings or children)" }
    ];
    quickActions.forEach(function(action) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = action.label;
      chip.style.cssText = 'height:22px;padding:0 9px;border-radius:11px;border:1px solid #1f2937;background:transparent;color:#cbd5e1;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background 0.12s,color 0.12s,border-color 0.12s;';
      chip.onmouseenter = function() { chip.style.background = '#1f2937'; chip.style.color = '#f3f4f6'; chip.style.borderColor = '#374151'; };
      chip.onmouseleave = function() { chip.style.background = 'transparent'; chip.style.color = '#cbd5e1'; chip.style.borderColor = '#1f2937'; };
      chip.addEventListener('click', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!inlinePromptTextarea) return;
        inlinePromptTextarea.value = action.prompt;
        inlinePromptTextarea.focus();
        // Trigger the auto-resize handler so the textarea grows to fit
        // the longer prompt text we just pasted in.
        if (typeof inlinePromptTextarea.oninput === 'function') {
          inlinePromptTextarea.oninput();
        }
      }, true);
      quickRow.appendChild(chip);
    });
    panel.appendChild(quickRow);

    // Destination note: clarifies that the inline prompt feeds into the
    // active chat session in the parent IDE (so follow-up turns stay
    // grouped). Cmd/Ctrl+Enter forces a fresh chat instead.
    var destinationNote = document.createElement('div');
    destinationNote.style.cssText = 'display:flex;align-items:center;gap:5px;margin-top:8px;padding:5px 8px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.18);border-radius:5px;color:#7dd3fc;font-size:10px;';
    destinationNote.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
      + '<span>Sends to your current chat. <span style="color:#94a3b8;">⌘↵ starts a new chat instead.</span></span>';
    panel.appendChild(destinationNote);

    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:8px;color:#64748b;font-size:10px;';
    var hint = document.createElement('span');
    hint.textContent = '↵ submit · ⇧↵ newline · Esc';
    footer.appendChild(hint);

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.style.cssText = 'height:22px;padding:0 10px;border-radius:4px;border:1px solid #2563eb;background:#2563eb;color:#fff;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:5px;';
    var submitLabel = document.createElement('span');
    submitLabel.textContent = 'Send';
    var submitKey = document.createElement('span');
    submitKey.style.cssText = 'opacity:0.7;font-size:10px;';
    submitKey.textContent = '↵';
    submit.appendChild(submitLabel);
    submit.appendChild(submitKey);
    submit.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var forceNewChat = !!(ev.metaKey || ev.ctrlKey);
      submitInlinePrompt(forceNewChat);
    }, true);
    footer.appendChild(submit);
    panel.appendChild(footer);

    document.body.appendChild(panel);
    inlinePromptPanel = panel;
    positionInlinePrompt(el);
    setTimeout(function() { if (inlinePromptTextarea) inlinePromptTextarea.focus(); }, 0);
    document.addEventListener('mousedown', onInlinePromptOutsideClick, true);
  }

  function onInlinePromptOutsideClick(ev) {
    if (!inlinePromptPanel) return;
    if (inlinePromptPanel.contains(ev.target)) return;
    if (selectionHud && selectionHud.contains(ev.target)) return;
    closeInlinePrompt();
  }

  function positionInlinePrompt(el) {
    if (!inlinePromptPanel || !el) return;
    var elRect = el.getBoundingClientRect();
    var hudRect = selectionHud && selectionHud.style.display !== 'none' ? selectionHud.getBoundingClientRect() : null;
    var W = inlinePromptPanel.offsetWidth || 360;
    var H = inlinePromptPanel.offsetHeight || 120;
    var GAP = 8;
    var topAnchor = hudRect ? hudRect.bottom : elRect.bottom;
    var leftAnchor = hudRect ? hudRect.left : elRect.left;
    var top = topAnchor + GAP;
    var left = leftAnchor;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    if (left < 8) left = 8;
    if (top + H > window.innerHeight - 8) {
      var topAbove = (hudRect ? hudRect.top : elRect.top) - GAP - H;
      top = topAbove > 8 ? topAbove : Math.max(8, window.innerHeight - H - 8);
    }
    inlinePromptPanel.style.top = top + 'px';
    inlinePromptPanel.style.left = left + 'px';
  }

  function submitInlinePrompt(newChat) {
    if (!inlinePromptPanel || !inlinePromptCurrentEl || !inlinePromptTextarea) return;
    var prompt = inlinePromptTextarea.value.trim();
    if (!prompt) {
      inlinePromptTextarea.focus();
      return;
    }
    window.parent.postMessage({
      type: 'element-inline-prompt',
      element: buildElementData(inlinePromptCurrentEl),
      prompt: prompt,
      newChat: !!newChat,
    }, '*');
    closeInlinePrompt();
  }

  function closeInlinePrompt() {
    if (inlinePromptPanel && inlinePromptPanel.parentNode) {
      inlinePromptPanel.parentNode.removeChild(inlinePromptPanel);
    }
    inlinePromptPanel = null;
    inlinePromptTextarea = null;
    inlinePromptCurrentEl = null;
    document.removeEventListener('mousedown', onInlinePromptOutsideClick, true);
  }

  function makeChevronIcon() {
    var span = document.createElement('span');
    span.innerHTML = _PHANTOM_ICONS.chevron;
    span.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;color:#475569;line-height:0;flex-shrink:0;padding:0 1px;';
    return span;
  }

  function renderComponentBreadcrumb(data) {
    if (!selectionHud) return;
    var chain = Array.isArray(data.componentChain) ? data.componentChain : [];
    if (!data.pageFile && chain.length === 0) return;

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:1px;max-width:260px;overflow:hidden;padding:0 2px 0 4px;flex-shrink:1;min-width:0;';

    if (data.pageFile) {
      var pageName = data.pageFile.split('/').pop().replace('.astro', '');
      row.appendChild(createBreadcrumbButton(pageName, 'Open page ' + data.pageFile, function() {
        postPageAction();
      }, false, _PHANTOM_ICONS.file));
    }

    var ordered = chain.slice().reverse().filter(function(path, index, arr) {
      return path && arr.indexOf(path) === index && path.indexOf('/layouts/') === -1;
    });
    for (var i = 0; i < ordered.length; i++) {
      row.appendChild(makeChevronIcon());

      (function(componentPath, isActive) {
        row.appendChild(createBreadcrumbButton(getComponentDisplayName(componentPath), 'Open ' + componentPath, function() {
          postComponentBreadcrumbAction(componentPath);
        }, isActive, _PHANTOM_ICONS.component));
      })(ordered[i], i === ordered.length - 1);
    }

    selectionHud.appendChild(row);
    selectionHud.appendChild(makeHudSeparator());
  }

  function renderSelectionHud(el) {
    ensureSelectionChrome();
    if (!selectionHud) return;
    selectionHud.innerHTML = '';

    var data = buildElementData(el);
    renderComponentBreadcrumb(data);

    // Tag pill: <span> in code-style colors
    var title = document.createElement('span');
    title.title = getElementLabel(el);
    title.style.cssText = 'display:inline-flex;align-items:center;max-width:96px;overflow:hidden;color:#7dd3fc;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;white-space:nowrap;flex-shrink:0;';
    var tagBracketL = document.createElement('span');
    tagBracketL.textContent = '<';
    tagBracketL.style.cssText = 'color:#475569;';
    var tagName = document.createElement('span');
    tagName.textContent = data.tag;
    tagName.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    var tagBracketR = document.createElement('span');
    tagBracketR.textContent = '>';
    tagBracketR.style.cssText = 'color:#475569;';
    title.appendChild(tagBracketL);
    title.appendChild(tagName);
    title.appendChild(tagBracketR);
    selectionHud.appendChild(title);

    selectionHud.appendChild(makeHudSeparator());

    // Code (open in editor). Ghost styling — the </> icon is enough to
    // mark it as a code action; a solid blue bg here was reading as
    // "selected" alongside the Classes active state.
    selectionHud.appendChild(createHudButton('Code', 'Open the selected element in the IDE (C)', function() {
      postSelectedAction('jump-to-code');
    }, false, _PHANTOM_ICONS.code));

    // Classes editor (toggles open/closed)
    var classesActive = !!classEditorPanel;
    selectionHud.appendChild(createHudButton('Classes', classesActive ? 'Hide class editor (E)' : 'Edit classes on this element (E)', function(ev) {
      if (classEditorPanel) {
        hideClassEditor();
      } else {
        originalClasses = Array.from(selectedEl.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
        showClassEditor(selectedEl, ev.clientX || 0, ev.clientY || 0);
      }
    }, false, _PHANTOM_ICONS.tw, false, classesActive));

    // Modify with AI: open an inline prompt anchored to this element.
    // Ghost styling — solid blue read as "selected" rather than "primary
    // action". The sparkle icon is enough to mark it visually.
    var modifyWithAiBtn = createHudButton('Modify with AI', 'Describe a change for this element (⌘K)', function() {
      openInlinePrompt(selectedEl);
    }, false, _PHANTOM_ICONS.sparkle);
    selectionHud.appendChild(modifyWithAiBtn);

    selectionHud.appendChild(makeHudSeparator());

    // Navigation: parent/child as compact icon-only buttons
    selectionHud.appendChild(createHudButton('Parent', 'Select parent element (↑)', function() { selectParent(); }, false, _PHANTOM_ICONS.arrowUp, true));
    selectionHud.appendChild(createHudButton('Child', 'Select first child element (↓)', function() { selectChild(); }, false, _PHANTOM_ICONS.arrowDown, true));

    var compPath = data.component || data.closestComponent || '';
    var moreItems = [];
    if (compPath) {
      moreItems.push({ label: 'Open component', title: 'Open ' + getComponentDisplayName(compPath), onClick: function() { postSelectedAction('open-component'); } });
    }
    if (data.pageFile) {
      moreItems.push({ label: 'Open page', title: 'Open ' + data.pageFile, onClick: function() { postPageAction(); } });
    }
    if (hasContentAreaForSelection(selectedEl)) {
      moreItems.push({ label: contentAreaOverlayVisible ? 'Hide area' : 'Show area', title: 'Highlight the selected component content area', onClick: function() {
        toggleContentAreaOverlay();
        renderSelectionHud(selectedEl);
      } });
    }
    if (moreItems.length > 0) {
      selectionHud.appendChild(createHudMenuButton('More', 'More selection actions', moreItems, _PHANTOM_ICONS.more));
    }

    selectionHud.appendChild(makeHudSeparator());

    var closeBtn = createHudButton('Close', 'Clear selection (Esc)', function() {
      clearSelectedElement();
      window.parent.postMessage({ type: 'element-inspector-clear' }, '*');
    }, false, _PHANTOM_ICONS.close, true);
    selectionHud.appendChild(closeBtn);

    selectionHud.style.display = 'flex';
    requestAnimationFrame(function() { positionSelectionChrome(el); });
  }

  function hideSelectionChrome() {
    if (selectedOverlay) selectedOverlay.style.display = 'none';
    if (selectedLabel) selectedLabel.style.display = 'none';
    if (selectionHud) selectionHud.style.display = 'none';
    hideContentAreaOverlay();
  }

  function findComponentRoot(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      if (node.getAttribute && node.getAttribute('data-component')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findContentAreaRegion(root, el) {
    if (!root || !el || root === el) return root;
    var node = el;
    while (node && node.parentElement && node.parentElement !== root) {
      node = node.parentElement;
    }
    return node && node.parentElement === root ? node : root;
  }

  function hasContentAreaForSelection(el) {
    var root = findComponentRoot(el);
    if (!root || root === el) return false;
    var region = findContentAreaRegion(root, el);
    return !!region && region !== root;
  }

  function showContentAreaOverlay() {
    if (!selectedEl) return;
    var root = findComponentRoot(selectedEl);
    if (!root) return;
    var region = findContentAreaRegion(root, selectedEl);
    if (!region) return;

    if (!contentAreaOverlay) {
      contentAreaOverlay = document.createElement('div');
      contentAreaOverlay.id = '__phantom-content-area-overlay';
      contentAreaOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483644;border:2px dashed rgba(168,85,247,0.95);background:rgba(168,85,247,0.07);border-radius:2px;display:none;';
      document.body.appendChild(contentAreaOverlay);
    }
    if (!contentAreaLabel) {
      contentAreaLabel = document.createElement('div');
      contentAreaLabel.id = '__phantom-content-area-label';
      contentAreaLabel.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1;padding:4px 7px;background:rgba(126,34,206,0.95);color:#fff;border-radius:4px;white-space:nowrap;display:none;';
      document.body.appendChild(contentAreaLabel);
    }

    contentAreaOverlayVisible = true;
    positionContentAreaOverlay();
  }

  function positionContentAreaOverlay() {
    if (!contentAreaOverlayVisible || !contentAreaOverlay || !contentAreaLabel || !selectedEl) return;
    var root = findComponentRoot(selectedEl);
    var region = root ? findContentAreaRegion(root, selectedEl) : null;
    if (!region) return;
    var rect = region.getBoundingClientRect();
    contentAreaOverlay.style.display = 'block';
    contentAreaOverlay.style.top = rect.top + 'px';
    contentAreaOverlay.style.left = rect.left + 'px';
    contentAreaOverlay.style.width = rect.width + 'px';
    contentAreaOverlay.style.height = rect.height + 'px';

    var comp = root.getAttribute('data-component') || '';
    contentAreaLabel.textContent = getComponentDisplayName(comp) + ' content area';
    contentAreaLabel.style.display = 'block';
    contentAreaLabel.style.top = (rect.top > 24 ? rect.top - 22 : rect.bottom + 6) + 'px';
    contentAreaLabel.style.left = Math.max(8, rect.left) + 'px';
  }

  function hideContentAreaOverlay() {
    contentAreaOverlayVisible = false;
    if (contentAreaOverlay) contentAreaOverlay.style.display = 'none';
    if (contentAreaLabel) contentAreaLabel.style.display = 'none';
  }

  function toggleContentAreaOverlay() {
    if (contentAreaOverlayVisible) hideContentAreaOverlay();
    else showContentAreaOverlay();
  }

  function updateFloatingChrome() {
    if (selectedEl) {
      positionSelectionChrome(selectedEl);
      positionContentAreaOverlay();
      if (inlinePromptPanel && inlinePromptCurrentEl) positionInlinePrompt(inlinePromptCurrentEl);
    }
  }

  function setSelectedElement(el, messageType) {
    selectedEl = el;
    originalClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    hideContentAreaOverlay();
    updateOverlay(el);
    renderSelectionHud(el);
    var data = buildElementData(el);
    data.type = messageType || 'element-inspector-select';
    window.parent.postMessage(data, '*');
    sendStyleData(el);
  }

  function clearSelectedElement() {
    selectedEl = null;
    hideSelectionChrome();
    updateOverlay(null);
    closeInlinePrompt();
  }

  function clearHoveredElement() {
    currentTarget = null;
    updateOverlay(null);
    window.parent.postMessage({ type: 'element-inspector-clear-hover' }, '*');
  }

  function buildElementData(el) {
    var rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; }),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: (el.textContent || '').trim().substring(0, 120),
      outerHtml: buildOuterHtmlSnippet(el),
      sourceFile: el.getAttribute('data-astro-source-file') || '',
      sourceLine: parseInt(el.getAttribute('data-astro-source-line') || '0', 10) || 0,
      component: el.getAttribute('data-component') || '',
      closestComponent: findClosestComponent(el),
      componentChain: buildComponentChain(el),
      pageFile: inferPageFile(),
      siblingIndex: getSiblingIndex(el),
      isMapRendered: isLikelyMapRendered(el),
    };
  }

  /**
   * Capture the element outerHTML, stripped of phantom inspector attributes
   * and astro source data attributes (which the agent will not see in source
   * files). Truncated to keep the prompt small. The agent uses this to grep
   * the source file when the element is rendered via set:html, a prop
   * default, or another raw-string mechanism where the line number cannot
   * point at the literal markup.
   */
  function buildOuterHtmlSnippet(el) {
    if (!el || typeof el.cloneNode !== 'function') return '';
    try {
      var clone = el.cloneNode(true);
      var allClones = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
      for (var i = 0; i < allClones.length; i++) {
        var node = allClones[i];
        if (!node.attributes) continue;
        var toRemove = [];
        for (var j = 0; j < node.attributes.length; j++) {
          var name = node.attributes[j].name;
          if (name.indexOf('data-astro-') === 0) toRemove.push(name);
          else if (name.indexOf('data-component') === 0) toRemove.push(name);
          else if (name.indexOf('data-phantom') === 0) toRemove.push(name);
        }
        for (var k = 0; k < toRemove.length; k++) node.removeAttribute(toRemove[k]);
        if (node.classList) {
          var phantomClasses = [];
          for (var c = 0; c < node.classList.length; c++) {
            var cls = node.classList[c];
            if (cls.indexOf('__phantom') === 0) phantomClasses.push(cls);
          }
          for (var p = 0; p < phantomClasses.length; p++) node.classList.remove(phantomClasses[p]);
        }
      }
      var html = clone.outerHTML || '';
      html = html.replace(/s+/g, ' ').trim();
      var MAX = 600;
      if (html.length > MAX) html = html.slice(0, MAX) + '…';
      return html;
    } catch (e) {
      return '';
    }
  }

  function isPhantomEl(el) {
    if (!el) return true;
    if (el.id && el.id.indexOf('__phantom') === 0) return true;
    if (el.closest && el.closest('[id^="__phantom"]')) return true;
    if (el.classList && el.classList.contains('__phantom-outline-label')) return true;
    return false;
  }

  function onMouseMove(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && selectedEl) { updateOverlay(selectedEl); return; }
    if (selectedEl) updateFloatingChrome();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) { clearHoveredElement(); return; }
    if (!el || el === document.body || el === document.documentElement) { clearHoveredElement(); return; }
    if (el === currentTarget) return;
    currentTarget = el;
    updateOverlay(el);
    var data = buildElementData(el);
    data.type = 'element-inspector-hover';
    window.parent.postMessage(data, '*');
  }

  function onMouseOutOfFrame(e) {
    if (!inspectorActive) return;
    if (!e.relatedTarget) clearHoveredElement();
  }

  // ---- Class Editor State ----
  var classEditorMode = false;
  var selectedEl = null;
  var classEditorPanel = null;
  var originalClasses = [];
  var twClasses = [];
  var twMap = {};
  var previewClass = null;

  // Standard Tailwind color palette for swatch previews
  var _twPalette = {black:'#000',white:'#fff',
    'slate-50':'#f8fafc','slate-100':'#f1f5f9','slate-200':'#e2e8f0','slate-300':'#cbd5e1','slate-400':'#94a3b8','slate-500':'#64748b','slate-600':'#475569','slate-700':'#334155','slate-800':'#1e293b','slate-900':'#0f172a','slate-950':'#020617',
    'gray-50':'#f9fafb','gray-100':'#f3f4f6','gray-200':'#e5e7eb','gray-300':'#d1d5db','gray-400':'#9ca3af','gray-500':'#6b7280','gray-600':'#4b5563','gray-700':'#374151','gray-800':'#1f2937','gray-900':'#111827','gray-950':'#030712',
    'zinc-50':'#fafafa','zinc-100':'#f4f4f5','zinc-200':'#e4e4e7','zinc-300':'#d4d4d8','zinc-400':'#a1a1aa','zinc-500':'#71717a','zinc-600':'#52525b','zinc-700':'#3f3f46','zinc-800':'#27272a','zinc-900':'#18181b','zinc-950':'#09090b',
    'neutral-50':'#fafafa','neutral-100':'#f5f5f5','neutral-200':'#e5e5e5','neutral-300':'#d4d4d4','neutral-400':'#a3a3a3','neutral-500':'#737373','neutral-600':'#525252','neutral-700':'#404040','neutral-800':'#262626','neutral-900':'#171717','neutral-950':'#0a0a0a',
    'stone-50':'#fafaf9','stone-100':'#f5f5f4','stone-200':'#e7e5e4','stone-300':'#d6d3d1','stone-400':'#a8a29e','stone-500':'#78716c','stone-600':'#57534e','stone-700':'#44403c','stone-800':'#292524','stone-900':'#1c1917','stone-950':'#0c0a09',
    'red-50':'#fef2f2','red-100':'#fee2e2','red-200':'#fecaca','red-300':'#fca5a5','red-400':'#f87171','red-500':'#ef4444','red-600':'#dc2626','red-700':'#b91c1c','red-800':'#991b1b','red-900':'#7f1d1d','red-950':'#450a0a',
    'orange-50':'#fff7ed','orange-100':'#ffedd5','orange-200':'#fed7aa','orange-300':'#fdba74','orange-400':'#fb923c','orange-500':'#f97316','orange-600':'#ea580c','orange-700':'#c2410c','orange-800':'#9a3412','orange-900':'#7c2d12','orange-950':'#431407',
    'amber-50':'#fffbeb','amber-100':'#fef3c7','amber-200':'#fde68a','amber-300':'#fcd34d','amber-400':'#fbbf24','amber-500':'#f59e0b','amber-600':'#d97706','amber-700':'#b45309','amber-800':'#92400e','amber-900':'#78350f','amber-950':'#451a03',
    'yellow-50':'#fefce8','yellow-100':'#fef9c3','yellow-200':'#fef08a','yellow-300':'#fde047','yellow-400':'#facc15','yellow-500':'#eab308','yellow-600':'#ca8a04','yellow-700':'#a16207','yellow-800':'#854d0e','yellow-900':'#713f12','yellow-950':'#422006',
    'lime-50':'#f7fee7','lime-100':'#ecfccb','lime-200':'#d9f99d','lime-300':'#bef264','lime-400':'#a3e635','lime-500':'#84cc16','lime-600':'#65a30d','lime-700':'#4d7c0f','lime-800':'#3f6212','lime-900':'#365314','lime-950':'#1a2e05',
    'green-50':'#f0fdf4','green-100':'#dcfce7','green-200':'#bbf7d0','green-300':'#86efac','green-400':'#4ade80','green-500':'#22c55e','green-600':'#16a34a','green-700':'#15803d','green-800':'#166534','green-900':'#14532d','green-950':'#052e16',
    'emerald-50':'#ecfdf5','emerald-100':'#d1fae5','emerald-200':'#a7f3d0','emerald-300':'#6ee7b7','emerald-400':'#34d399','emerald-500':'#10b981','emerald-600':'#059669','emerald-700':'#047857','emerald-800':'#065f46','emerald-900':'#064e3b','emerald-950':'#022c22',
    'teal-50':'#f0fdfa','teal-100':'#ccfbf1','teal-200':'#99f6e4','teal-300':'#5eead4','teal-400':'#2dd4bf','teal-500':'#14b8a6','teal-600':'#0d9488','teal-700':'#0f766e','teal-800':'#115e59','teal-900':'#134e4a','teal-950':'#042f2e',
    'cyan-50':'#ecfeff','cyan-100':'#cffafe','cyan-200':'#a5f3fc','cyan-300':'#67e8f9','cyan-400':'#22d3ee','cyan-500':'#06b6d4','cyan-600':'#0891b2','cyan-700':'#0e7490','cyan-800':'#155e75','cyan-900':'#164e63','cyan-950':'#083344',
    'sky-50':'#f0f9ff','sky-100':'#e0f2fe','sky-200':'#bae6fd','sky-300':'#7dd3fc','sky-400':'#38bdf8','sky-500':'#0ea5e9','sky-600':'#0284c7','sky-700':'#0369a1','sky-800':'#075985','sky-900':'#0c4a6e','sky-950':'#082f49',
    'blue-50':'#eff6ff','blue-100':'#dbeafe','blue-200':'#bfdbfe','blue-300':'#93c5fd','blue-400':'#60a5fa','blue-500':'#3b82f6','blue-600':'#2563eb','blue-700':'#1d4ed8','blue-800':'#1e40af','blue-900':'#1e3a8a','blue-950':'#172554',
    'indigo-50':'#eef2ff','indigo-100':'#e0e7ff','indigo-200':'#c7d2fe','indigo-300':'#a5b4fc','indigo-400':'#818cf8','indigo-500':'#6366f1','indigo-600':'#4f46e5','indigo-700':'#4338ca','indigo-800':'#3730a3','indigo-900':'#312e81','indigo-950':'#1e1b4b',
    'violet-50':'#f5f3ff','violet-100':'#ede9fe','violet-200':'#ddd6fe','violet-300':'#c4b5fd','violet-400':'#a78bfa','violet-500':'#8b5cf6','violet-600':'#7c3aed','violet-700':'#6d28d9','violet-800':'#5b21b6','violet-900':'#4c1d95','violet-950':'#2e1065',
    'purple-50':'#faf5ff','purple-100':'#f3e8ff','purple-200':'#e9d5ff','purple-300':'#d8b4fe','purple-400':'#c084fc','purple-500':'#a855f7','purple-600':'#9333ea','purple-700':'#7e22ce','purple-800':'#6b21a8','purple-900':'#581c87','purple-950':'#3b0764',
    'fuchsia-50':'#fdf4ff','fuchsia-100':'#fae8ff','fuchsia-200':'#f5d0fe','fuchsia-300':'#f0abfc','fuchsia-400':'#e879f9','fuchsia-500':'#d946ef','fuchsia-600':'#c026d3','fuchsia-700':'#a21caf','fuchsia-800':'#86198f','fuchsia-900':'#701a75','fuchsia-950':'#4a044e',
    'pink-50':'#fdf2f8','pink-100':'#fce7f3','pink-200':'#fbcfe8','pink-300':'#f9a8d4','pink-400':'#f472b6','pink-500':'#ec4899','pink-600':'#db2777','pink-700':'#be185d','pink-800':'#9d174d','pink-900':'#831843','pink-950':'#500724',
    'rose-50':'#fff1f2','rose-100':'#ffe4e6','rose-200':'#fecdd3','rose-300':'#fda4af','rose-400':'#fb7185','rose-500':'#f43f5e','rose-600':'#e11d48','rose-700':'#be123c','rose-800':'#9f1239','rose-900':'#881337','rose-950':'#4c0519'
  };

  function resolveColorToken(token) {
    var val = getComputedStyle(document.documentElement).getPropertyValue('--color-' + token).trim();
    if (val) return val;
    return _twPalette[token] || null;
  }

  function onClick(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && (classEditorPanel.contains(e.target) || e.target.closest('#__phantom-class-editor'))) return;
    var dropEl = document.getElementById('__phantom-class-dropdown');
    if (dropEl && (dropEl.contains(e.target) || e.target.closest('#__phantom-class-dropdown'))) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // In class editor mode, act immediately (no debounce needed)
    if (classEditorMode) {
      // Close old editor BEFORE changing selectedEl so it reverts the correct element
      hideClassEditor();
      setSelectedElement(el, 'element-inspector-select');
      showClassEditor(el, e.clientX, e.clientY);
      return false;
    }

    setSelectedElement(el, 'element-inspector-select');
    return false;
  }

  function onDblClick(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && (classEditorPanel.contains(e.target) || e.target.closest('#__phantom-class-editor'))) return;
    var dropEl2 = document.getElementById('__phantom-class-dropdown');
    if (dropEl2 && (dropEl2.contains(e.target) || e.target.closest('#__phantom-class-dropdown'))) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    setSelectedElement(el, 'element-inspector-dblclick');
    return false;
  }

  // Delayed overlay refresh: waits for newly added class styles to settle.
  function refreshOverlay() {
    updateOverlay(selectedEl);
    updateFloatingChrome();
    setTimeout(function() { if (selectedEl) updateOverlay(selectedEl); }, 80);
  }

  // ---- Class Editor Panel ----
  function getInlineClassEditorPosition(el, panelW, panelH) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var hudRect = selectionHud && selectionHud.style.display !== 'none' ? selectionHud.getBoundingClientRect() : null;
    var rect = el.getBoundingClientRect();
    var px, py;

    if (hudRect) {
      px = hudRect.right + 6;
      py = hudRect.top;
      if (px + panelW > vw - 8) px = hudRect.left - panelW - 6;
      if (px < 8) px = Math.max(8, vw - panelW - 8);
      if (py + panelH > vh - 8) py = Math.max(8, vh - panelH - 8);
      if (py < 8) py = 8;
      return { left: px, top: py };
    }

    px = rect.left;
    if (px + panelW > vw - 8) px = vw - panelW - 8;
    if (px < 8) px = 8;
    py = rect.bottom + 8;
    if (py + panelH > vh - 8) py = Math.max(8, rect.top - panelH - 8);
    return { left: px, top: py };
  }

  function showClassEditor(el, clickX, clickY) {
    hideClassEditor();
    selectedEl = el;
    var classes = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    var computedStyle = window.getComputedStyle(el);
    renderSelectionHud(el);

    classEditorPanel = document.createElement('div');
    classEditorPanel.id = '__phantom-class-editor';
    classEditorPanel.style.cssText = 'position:fixed;z-index:2147483647;background:#111827;border:1px solid #374151;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#d1d5db;width:320px;max-height:360px;display:flex;flex-direction:column;box-shadow:0 12px 24px rgba(0,0,0,0.5);overflow:hidden;';

    var panelW = 320, panelH = 340;
    var pos = getInlineClassEditorPosition(el, panelW, panelH);
    classEditorPanel.style.left = pos.left + 'px';
    classEditorPanel.style.top = pos.top + 'px';

    // Drag handle / header
    var dragBar = document.createElement('div');
    dragBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px 6px;cursor:grab;user-select:none;flex-shrink:0;';
    var tagRow = document.createElement('div');
    tagRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var tagIcon = document.createElement('span');
    tagIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    tagRow.appendChild(tagIcon);
    var tagName = document.createElement('span');
    tagName.style.cssText = 'color:#3b82f6;font-weight:600;font-size:13px;';
    tagName.textContent = el.tagName.toLowerCase();
    tagRow.appendChild(tagName);
    dragBar.appendChild(tagRow);
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px;line-height:0;border-radius:4px;';
    closeBtn.onmouseenter = function() { closeBtn.style.background = '#1f2937'; };
    closeBtn.onmouseleave = function() { closeBtn.style.background = 'none'; };
    closeBtn.onclick = function(ev) { ev.stopPropagation(); hideClassEditor(); };
    dragBar.appendChild(closeBtn);
    classEditorPanel.appendChild(dragBar);

    // Make draggable
    var isDragging = false, dragStartX = 0, dragStartY = 0, panelStartX = 0, panelStartY = 0;
    dragBar.addEventListener('mousedown', function(ev) {
      if (ev.target === closeBtn || closeBtn.contains(ev.target)) return;
      isDragging = true;
      dragStartX = ev.clientX; dragStartY = ev.clientY;
      panelStartX = parseInt(classEditorPanel.style.left, 10);
      panelStartY = parseInt(classEditorPanel.style.top, 10);
      dragBar.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function dragMove(ev) {
      if (!isDragging) return;
      classEditorPanel.style.left = (panelStartX + ev.clientX - dragStartX) + 'px';
      classEditorPanel.style.top = (panelStartY + ev.clientY - dragStartY) + 'px';
    });
    document.addEventListener('mouseup', function dragEnd() {
      if (isDragging) { isDragging = false; dragBar.style.cursor = 'grab'; }
    });

    // Info row
    var infoRow = document.createElement('div');
    infoRow.style.cssText = 'padding:0 12px 8px;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;flex-shrink:0;border-bottom:1px solid #1f2937;';
    var fontFamily = computedStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    var infoLeft = document.createElement('span');
    infoLeft.textContent = '"' + fontFamily + '" ' + computedStyle.fontSize + ' / ' + computedStyle.fontWeight;
    infoRow.appendChild(infoLeft);
    var infoRight = document.createElement('span');
    var elRect = el.getBoundingClientRect();
    infoRight.textContent = Math.round(elRect.width) + ' x ' + Math.round(elRect.height) + 'px';
    infoRow.appendChild(infoRight);
    classEditorPanel.appendChild(infoRow);

    // Class chips (flat list)
    var chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'padding:10px 12px;display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;min-height:40px;max-height:200px;scrollbar-width:thin;scrollbar-color:#374151 transparent;';
    if (classes.length === 0) {
      var emptyMsg = document.createElement('span');
      emptyMsg.style.cssText = 'color:#6b7280;font-size:11px;font-style:italic;';
      emptyMsg.textContent = 'No classes on this element';
      chipsWrap.appendChild(emptyMsg);
    }
    classes.forEach(function(cls) {
      chipsWrap.appendChild(createClassChip(cls, true, el, chipsWrap, markDirty));
    });
    classEditorPanel.appendChild(chipsWrap);

    // Add Class section
    var addSection = document.createElement('div');
    addSection.style.cssText = 'padding:8px 12px 10px;border-top:1px solid #1f2937;flex-shrink:0;position:relative;';
    var addLabel = document.createElement('div');
    addLabel.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:4px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;';
    addLabel.textContent = 'Add Class';
    addSection.appendChild(addLabel);
    var inputWrap = document.createElement('div');
    inputWrap.style.cssText = 'position:relative;';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type a class name';
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#030712;border:1px solid #374151;border-radius:6px;padding:7px 10px;color:#e5e7eb;font-family:inherit;font-size:11px;outline:none;';
    input.onfocus = function() { input.style.borderColor = '#3b82f6'; input.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; };
    input.onblur = function() { setTimeout(function() { hideDropdown(); input.style.borderColor = '#374151'; input.style.boxShadow = 'none'; }, 150); };
    inputWrap.appendChild(input);
    addSection.appendChild(inputWrap);
    classEditorPanel.appendChild(addSection);

    // Autocomplete dropdown
    var dropdown = document.createElement('div');
    dropdown.id = '__phantom-class-dropdown';
    dropdown.style.cssText = 'display:none;position:fixed;background:#111827;border:1px solid #374151;border-radius:6px;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:2147483647;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;scrollbar-width:thin;scrollbar-color:#374151 transparent;color-scheme:dark;';

    function positionDropdown() {
      var inputRect = input.getBoundingClientRect();
      dropdown.style.left = inputRect.left + 'px';
      dropdown.style.width = inputRect.width + 'px';
      var spaceBelow = window.innerHeight - inputRect.bottom - 8;
      var dropH = Math.min(180, dropdown.scrollHeight || 180);
      if (spaceBelow >= dropH || spaceBelow >= 100) {
        dropdown.style.top = (inputRect.bottom + 4) + 'px';
        dropdown.style.bottom = 'auto';
      } else {
        dropdown.style.top = 'auto';
        dropdown.style.bottom = (window.innerHeight - inputRect.top + 4) + 'px';
      }
    }
    var activeIdx = -1;

    function showDropdown(query) {
      dropdown.innerHTML = '';
      activeIdx = -1;
      if (!query || query.length < 1) { dropdown.style.display = 'none'; return; }
      var q = query.toLowerCase();
      var currentClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      var currentSet = {};
      currentClasses.forEach(function(c) { currentSet[c] = true; });
      var matches = [];
      for (var i = 0; i < twClasses.length && matches.length < 30; i++) {
        var cls = twClasses[i];
        var name = typeof cls === 'string' ? cls : cls.name;
        var desc = typeof cls === 'string' ? '' : (cls.description || '');
        if (currentSet[name]) continue;
        // Match by class name OR CSS description
        if (name.indexOf(q) !== -1 || (desc && desc.toLowerCase().indexOf(q) !== -1)) {
          matches.push(cls);
        }
      }
      if (matches.length === 0) { dropdown.style.display = 'none'; return; }
      // Sort: name-starts-with first, then name-contains, then description-match
      matches.sort(function(a, b) {
        var aName = typeof a === 'string' ? a : a.name;
        var bName = typeof b === 'string' ? b : b.name;
        var aNameStart = aName.indexOf(q) === 0 ? 0 : (aName.indexOf(q) !== -1 ? 1 : 2);
        var bNameStart = bName.indexOf(q) === 0 ? 0 : (bName.indexOf(q) !== -1 ? 1 : 2);
        if (aNameStart !== bNameStart) return aNameStart - bNameStart;
        return aName.length - bName.length;
      });
      matches.forEach(function(m, idx) {
        var mName = typeof m === 'string' ? m : m.name;
        var mDesc = typeof m === 'string' ? '' : (m.description || '');
        var item = document.createElement('div');
        item.setAttribute('data-class', mName);
        item.style.cssText = 'padding:5px 10px;cursor:pointer;font-size:11px;color:#d1d5db;display:flex;align-items:center;gap:8px;';
        var tokenMatch = mName.match(/^(?:bg|text|border|ring|outline|divide|shadow|from|via|to|fill|stroke|accent|caret)-(.+)$/);
        var tokenColor = tokenMatch ? resolveColorToken(tokenMatch[1]) : null;
        if (tokenColor) {
          var swatch = document.createElement('span');
          swatch.style.cssText = 'width:12px;height:12px;border-radius:3px;flex-shrink:0;border:1px solid #4b5563;background:' + tokenColor + ';';
          item.appendChild(swatch);
        }
        var lbl = document.createElement('span');
        lbl.textContent = mName;
        lbl.style.cssText = 'flex-shrink:0;';
        item.appendChild(lbl);
        // Show CSS description
        if (mDesc) {
          var descLbl = document.createElement('span');
          descLbl.textContent = mDesc;
          descLbl.style.cssText = 'color:#6b7280;font-size:10px;margin-left:auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;';
          item.appendChild(descLbl);
        }
        item.onmouseenter = function() { setActive(idx); applyPreview(mName); };
        item.onmouseleave = function() { removePreview(); };
        item.onmousedown = function(ev) { ev.preventDefault(); ev.stopPropagation(); selectSuggestion(mName); };
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
      positionDropdown();
    }

    function setActive(idx) {
      var items = dropdown.children;
      for (var j = 0; j < items.length; j++) {
        items[j].style.background = j === idx ? 'rgba(59,130,246,0.15)' : 'transparent';
        items[j].style.color = j === idx ? '#93c5fd' : '#d1d5db';
      }
      activeIdx = idx;
    }

    function hideDropdown() { removePreview(); dropdown.style.display = 'none'; activeIdx = -1; }

    function applyPreview(cls) {
      removePreview();
      if (cls && !el.classList.contains(cls)) {
        el.classList.add(cls);
        previewClass = cls;
        refreshOverlay();
      }
    }

    function removePreview() {
      if (previewClass && selectedEl) {
        selectedEl.classList.remove(previewClass);
        previewClass = null;
        refreshOverlay();
      }
    }

    var isDirty = false;
    function markDirty() { isDirty = true; if (saveBtn) saveBtn.style.opacity = '1'; }

    function addClassToElement(cls) {
      removePreview();
      if (!cls) return;
      if (!el.classList.contains(cls)) el.classList.add(cls);
      var existing = chipsWrap.querySelector('[data-class="' + cls + '"]');
      if (!existing) {
        var emptyEl = chipsWrap.querySelector('span[style*="italic"]');
        if (emptyEl) emptyEl.remove();
        chipsWrap.appendChild(createClassChip(cls, true, el, chipsWrap, markDirty));
      }
      refreshOverlay();
      markDirty();
    }

    function selectSuggestion(cls) {
      addClassToElement(cls);
      input.value = '';
      hideDropdown();
      input.focus();
    }

    input.oninput = function() { showDropdown(input.value.trim()); };
    input.onkeydown = function(ev) {
      var items = dropdown.children;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (dropdown.style.display === 'none') { showDropdown(input.value.trim()); return; }
        var nextIdx = Math.min(activeIdx + 1, items.length - 1);
        setActive(nextIdx);
        if (items[activeIdx]) { items[activeIdx].scrollIntoView({ block: 'nearest' }); applyPreview(items[activeIdx].getAttribute('data-class')); }
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        var prevIdx = Math.max(activeIdx - 1, 0);
        setActive(prevIdx);
        if (items[activeIdx]) { items[activeIdx].scrollIntoView({ block: 'nearest' }); applyPreview(items[activeIdx].getAttribute('data-class')); }
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) selectSuggestion(items[activeIdx].getAttribute('data-class'));
        else if (input.value.trim()) {
          input.value.trim().split(/\s+/).forEach(function(c) { if (c) addClassToElement(c); });
          input.value = '';
          hideDropdown();
          input.focus();
        }
      } else if (ev.key === 'Escape') {
        removePreview();
        if (dropdown.style.display !== 'none') { hideDropdown(); ev.stopPropagation(); }
        else hideClassEditor();
      } else if (ev.key === 'Tab' && activeIdx >= 0 && items[activeIdx]) {
        ev.preventDefault();
        selectSuggestion(items[activeIdx].getAttribute('data-class'));
      }
    };

    // Footer: Save / Revert
    var footer = document.createElement('div');
    footer.style.cssText = 'padding:6px 12px 8px;border-top:1px solid #1f2937;flex-shrink:0;display:flex;gap:6px;justify-content:flex-end;';

    var revertBtn = document.createElement('button');
    revertBtn.textContent = 'Revert';
    revertBtn.style.cssText = 'padding:4px 12px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;background:transparent;color:#9ca3af;border:1px solid #374151;';
    revertBtn.onmouseenter = function() { revertBtn.style.background = '#1f2937'; revertBtn.style.color = '#e5e7eb'; };
    revertBtn.onmouseleave = function() { revertBtn.style.background = 'transparent'; revertBtn.style.color = '#9ca3af'; };
    revertBtn.onclick = function(ev) {
      ev.stopPropagation();
      var current = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      current.forEach(function(c) { el.classList.remove(c); });
      originalClasses.forEach(function(c) { el.classList.add(c); });
      hideClassEditor();
    };
    footer.appendChild(revertBtn);

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save to code';
    saveBtn.style.cssText = 'padding:4px 12px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;background:#2563eb;color:#fff;border:1px solid #3b82f6;opacity:0.5;box-shadow:0 0 8px rgba(59,130,246,0.3);';
    saveBtn.onmouseenter = function() { saveBtn.style.background = '#1d4ed8'; };
    saveBtn.onmouseleave = function() { saveBtn.style.background = '#2563eb'; };
    saveBtn.onclick = function(ev) {
      ev.stopPropagation();
      notifyClassChange(el);
      classEditorPanel.remove();
      classEditorPanel = null;
    };
    footer.appendChild(saveBtn);

    classEditorPanel.appendChild(footer);

    document.body.appendChild(classEditorPanel);
    document.body.appendChild(dropdown);
    setTimeout(function() { input.focus(); }, 60);
  }

  function showClassEditorForSelection() {
    if (!selectedEl) return;
    if (classEditorPanel) { hideClassEditor(); return; }
    var rect = selectedEl.getBoundingClientRect();
    showClassEditor(selectedEl, Math.max(8, rect.left), Math.max(8, rect.bottom + 8));
  }

  // CSS popup for hovering class chips
  var cssPopupTimer = null;
  function showCssPopup(chip, cls) {
    hideCssPopup();
    var info = twMap[cls];
    var desc = (info && info.description) ? info.description : null;
    if (!desc) return;

    cssPopupTimer = setTimeout(function() {
      var popup = document.createElement('div');
      popup.id = '__phantom-css-popup';
      popup.style.cssText = 'position:fixed;z-index:2147483647;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;pointer-events:none;max-width:320px;';

      // Build syntax-highlighted CSS line(s)
      var parts = desc.split(';');
      parts.forEach(function(part) {
        part = part.trim();
        if (!part) return;
        var colonIdx = part.indexOf(':');
        if (colonIdx === -1) {
          // No colon, just render as text
          var line = document.createElement('div');
          line.style.cssText = 'color:#e2e8f0;white-space:nowrap;';
          line.textContent = part;
          popup.appendChild(line);
          return;
        }
        var prop = part.substring(0, colonIdx).trim();
        var val = part.substring(colonIdx + 1).trim();

        var line = document.createElement('div');
        line.style.cssText = 'white-space:nowrap;';

        var propSpan = document.createElement('span');
        propSpan.style.cssText = 'color:#7dd3fc;';
        propSpan.textContent = prop;
        line.appendChild(propSpan);

        var colonSpan = document.createElement('span');
        colonSpan.style.cssText = 'color:#64748b;';
        colonSpan.textContent = ': ';
        line.appendChild(colonSpan);

        // Color-code values
        var valSpan = document.createElement('span');
        // Numbers/units -> orange, keywords -> green, colors -> pink
        if (/^-?[\d.]+/.test(val) || /^\d/.test(val)) {
          valSpan.style.cssText = 'color:#fbbf24;';
        } else if (val === 'none' || val === 'auto' || val === 'inherit' || val === 'initial' || val === 'transparent') {
          valSpan.style.cssText = 'color:#a78bfa;';
        } else {
          valSpan.style.cssText = 'color:#86efac;';
        }
        valSpan.textContent = val;
        line.appendChild(valSpan);

        var semiSpan = document.createElement('span');
        semiSpan.style.cssText = 'color:#64748b;';
        semiSpan.textContent = ';';
        line.appendChild(semiSpan);

        popup.appendChild(line);
      });

      // Position above the chip
      document.body.appendChild(popup);
      var chipRect = chip.getBoundingClientRect();
      var popupRect = popup.getBoundingClientRect();
      var left = chipRect.left;
      if (left + popupRect.width > window.innerWidth - 8) left = window.innerWidth - popupRect.width - 8;
      if (left < 8) left = 8;
      var top = chipRect.top - popupRect.height - 6;
      if (top < 8) top = chipRect.bottom + 6;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }, 400);
  }

  function hideCssPopup() {
    if (cssPopupTimer) { clearTimeout(cssPopupTimer); cssPopupTimer = null; }
    var popup = document.getElementById('__phantom-css-popup');
    if (popup) popup.remove();
  }

  function createClassChip(cls, enabled, el, container, markDirty) {
    var chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer;user-select:none;transition:background 0.1s,color 0.1s;' + (enabled ? 'background:rgba(59,130,246,0.1);color:#93c5fd;border:1px solid rgba(59,130,246,0.3);' : 'background:#1f2937;color:#6b7280;border:1px solid #374151;');
    chip.setAttribute('data-class', cls);
    chip.setAttribute('data-enabled', enabled ? '1' : '0');

    var cb = document.createElement('span');
    cb.style.cssText = 'width:14px;height:14px;border-radius:3px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;line-height:1;' + (enabled ? 'background:#3b82f6;color:#fff;' : 'background:#1f2937;color:transparent;border:1px solid #4b5563;');
    cb.innerHTML = enabled ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '';
    chip.appendChild(cb);

    var text = document.createElement('span');
    text.style.cssText = enabled ? '' : 'text-decoration:line-through;';
    text.textContent = cls;
    chip.appendChild(text);

    chip.onmouseenter = function() { chip.style.filter = 'brightness(1.15)'; showCssPopup(chip, cls); };
    chip.onmouseleave = function() { chip.style.filter = ''; hideCssPopup(); };

    chip.onclick = function(ev) {
      ev.stopPropagation();
      var isEnabled = chip.getAttribute('data-enabled') === '1';
      if (isEnabled) {
        el.classList.remove(cls);
        chip.setAttribute('data-enabled', '0');
        chip.style.background = '#1f2937'; chip.style.color = '#6b7280'; chip.style.borderColor = '#374151';
        cb.style.background = '#1f2937'; cb.style.color = 'transparent'; cb.style.border = '1px solid #4b5563'; cb.innerHTML = '';
        text.style.textDecoration = 'line-through';
      } else {
        el.classList.add(cls);
        chip.setAttribute('data-enabled', '1');
        chip.style.background = 'rgba(59,130,246,0.1)'; chip.style.color = '#93c5fd'; chip.style.borderColor = 'rgba(59,130,246,0.3)';
        cb.style.background = '#3b82f6'; cb.style.color = '#fff'; cb.style.border = 'none';
        cb.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        text.style.textDecoration = 'none';
      }
      refreshOverlay();
      markDirty();
    };

    return chip;
  }

  function findClosestComponent(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      var comp = node.getAttribute('data-component');
      if (comp) return comp;
      node = node.parentElement;
    }
    return '';
  }

  function buildComponentChain(el) {
    var chain = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var comp = node.getAttribute('data-component');
      if (comp && (chain.length === 0 || chain[chain.length - 1] !== comp)) {
        chain.push(comp);
      }
      node = node.parentElement;
    }
    return chain;
  }

  function getSiblingIndex(el) {
    if (!el.parentElement) return 0;
    var siblings = el.parentElement.children;
    var sameTagCount = 0;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === el) return sameTagCount;
      if (siblings[i].tagName === el.tagName) sameTagCount++;
    }
    return 0;
  }

  function isLikelyMapRendered(el) {
    if (!el.parentElement) return false;
    var comp = el.getAttribute('data-component');
    if (!comp) return false;
    var siblings = el.parentElement.children;
    var count = 0;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].getAttribute('data-component') === comp) count++;
    }
    return count > 1;
  }

  function inferPageFile() {
    var path = window.location.pathname;
    if (path === '/' || path === '') return 'src/pages/index.astro';
    path = path.replace(/\/$/, '');
    return 'src/pages' + path + '.astro';
  }

  // ---- Style Data for Visual CSS Editor ----
  var STYLE_PROPS = [
    'display','flexDirection','flexWrap','justifyContent','alignItems','alignContent','gap','rowGap','columnGap',
    'gridTemplateColumns','gridTemplateRows',
    'position','top','right','bottom','left','zIndex',
    'width','height','minWidth','maxWidth','minHeight','maxHeight','overflow','overflowX','overflowY',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'marginTop','marginRight','marginBottom','marginLeft',
    'fontSize','fontWeight','fontFamily','lineHeight','letterSpacing','textAlign','textDecoration','textTransform','color',
    'backgroundColor','backgroundImage',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'borderTopColor','borderRightColor','borderBottomColor','borderLeftColor',
    'borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle',
    'borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius',
    'opacity','boxShadow','backdropFilter'
  ];

  function buildStyleData(el) {
    var cs = window.getComputedStyle(el);
    var computed = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      computed[STYLE_PROPS[i]] = cs.getPropertyValue(
        STYLE_PROPS[i].replace(/([A-Z])/g, '-$1').toLowerCase()
      );
    }

    var matchedRules = [];
    try {
      var sheets = document.styleSheets;
      for (var s = 0; s < sheets.length; s++) {
        var sheet = sheets[s];
        var node = sheet.ownerNode;
        var href = sheet.href
          || (node && node.getAttribute && node.getAttribute('data-vite-dev-id'))
          || (node && node.getAttribute && node.getAttribute('data-astro-dev-id'))
          || (node && node.id && node.id.indexOf('/src/') !== -1 ? node.id : '')
          || '';
        var rules;
        try { rules = sheet.cssRules || sheet.rules; } catch(ex) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (!rule.selectorText) continue;
          try {
            if (el.matches(rule.selectorText)) {
              var props = {};
              for (var p = 0; p < rule.style.length; p++) {
                var prop = rule.style[p];
                props[prop] = rule.style.getPropertyValue(prop);
              }
              matchedRules.push({ selector: rule.selectorText, file: href, properties: props });
            }
          } catch(ex2) { /* invalid selector */ }
        }
      }
    } catch(ex3) { /* cross-origin sheet */ }

    var base = buildElementData(el);
    return {
      type: 'element-style-data',
      computed: computed,
      matchedRules: matchedRules,
      classes: base.classes,
      sourceFile: base.sourceFile,
      sourceLine: base.sourceLine,
      component: base.component,
      closestComponent: base.closestComponent,
      tag: base.tag,
      id: base.id,
      pageFile: base.pageFile,
    };
  }

  function sendStyleData(el) {
    if (!el) return;
    var data = buildStyleData(el);
    window.parent.postMessage(data, '*');
  }

  // ---- Instant Style Preview ----
  var _previewStyleEl = null;
  var _previewOriginals = {};

  function applyInstantStyle(el, prop, value) {
    if (!el) return;
    if (!Object.prototype.hasOwnProperty.call(_previewOriginals, prop)) {
      _previewOriginals[prop] = el.style.getPropertyValue(prop) || '';
    }
    el.style.setProperty(prop, value, 'important');
  }

  function revertInstantStyles(el) {
    if (!el) return;
    var keys = Object.keys(_previewOriginals);
    for (var k = 0; k < keys.length; k++) {
      var orig = _previewOriginals[keys[k]];
      if (orig) {
        el.style.setProperty(keys[k], orig);
      } else {
        el.style.removeProperty(keys[k]);
      }
    }
    _previewOriginals = {};
  }

  function notifyClassChange(el) {
    var current = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    window.parent.postMessage({
      type: 'element-classes-changed',
      classes: current,
      originalClasses: originalClasses,
      sourceFile: el.getAttribute('data-astro-source-file') || '',
      sourceLine: parseInt(el.getAttribute('data-astro-source-line') || '0', 10) || 0,
      component: el.getAttribute('data-component') || '',
      closestComponent: findClosestComponent(el),
      pageFile: inferPageFile(),
      tag: el.tagName.toLowerCase(),
    }, '*');
  }

  function hideClassEditor() {
    if (previewClass && selectedEl) {
      selectedEl.classList.remove(previewClass);
      previewClass = null;
    }
    // Only revert classes if the panel was actually open (unsaved changes)
    if (classEditorPanel && selectedEl && originalClasses) {
      var current = Array.from(selectedEl.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      current.forEach(function(c) { selectedEl.classList.remove(c); });
      originalClasses.forEach(function(c) { selectedEl.classList.add(c); });
    }
    if (classEditorPanel) { classEditorPanel.remove(); classEditorPanel = null; }
    var oldDrop = document.getElementById('__phantom-class-dropdown');
    if (oldDrop) oldDrop.remove();
    // Hide CSS popup if visible
    var popup = document.getElementById('__phantom-css-popup');
    if (popup) popup.remove();
    if (selectedEl) renderSelectionHud(selectedEl);
  }

  function enableInspector() {
    if (inspectorActive) return;
    inspectorActive = true;

    overlay = document.createElement('div');
    overlay.id = '__phantom-inspector-overlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px dashed #3b82f6;background:transparent;transition:all 0.05s ease-out;display:none;';
    document.body.appendChild(overlay);

    label = document.createElement('div');
    label.id = '__phantom-inspector-label';
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1;padding:3px 7px;background:#3b82f6;color:#fff;border-radius:4px;white-space:nowrap;display:none;box-shadow:0 4px 10px rgba(59,130,246,0.35);';
    document.body.appendChild(label);

    dims = document.createElement('div');
    dims.id = '__phantom-inspector-dims';
    dims.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1;padding:2px 6px;background:#0f172a;color:#cbd5e1;border:1px solid #1e293b;border-radius:3px;white-space:nowrap;display:none;';
    document.body.appendChild(dims);

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mouseout', onMouseOutOfFrame, true);
    window.addEventListener('resize', updateFloatingChrome, true);
    window.addEventListener('scroll', updateFloatingChrome, true);
    document.addEventListener('scroll', updateFloatingChrome, true);
    document.documentElement.style.cursor = 'pointer';
  }

  function disableInspector() {
    if (!inspectorActive) return;
    inspectorActive = false;
    currentTarget = null;
    hideClassEditor();
    clearSelectedElement();
    if (overlay) { overlay.remove(); overlay = null; }
    if (label) { label.remove(); label = null; }
    if (dims) { dims.remove(); dims = null; }
    if (selectedOverlay) { selectedOverlay.remove(); selectedOverlay = null; }
    if (selectedLabel) { selectedLabel.remove(); selectedLabel = null; }
    if (selectionHud) { selectionHud.remove(); selectionHud = null; }
    if (contentAreaOverlay) { contentAreaOverlay.remove(); contentAreaOverlay = null; }
    if (contentAreaLabel) { contentAreaLabel.remove(); contentAreaLabel = null; }
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('mouseout', onMouseOutOfFrame, true);
    window.removeEventListener('resize', updateFloatingChrome, true);
    window.removeEventListener('scroll', updateFloatingChrome, true);
    document.removeEventListener('scroll', updateFloatingChrome, true);
    document.documentElement.style.cursor = '';
  }

  function selectParent() {
    if (!selectedEl) return;
    var parent = selectedEl.parentElement;
    while (parent && (parent === document.body || parent === document.documentElement)) {
      parent = parent.parentElement;
    }
    if (!parent || parent === document.body || parent === document.documentElement) return;
    setSelectedElement(parent, 'element-inspector-select');
  }

  function selectChild() {
    if (!selectedEl) return;
    var child = selectedEl.firstElementChild;
    while (child && (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || (child.id && child.id.indexOf('__phantom') === 0))) {
      child = child.nextElementSibling;
    }
    if (!child) return;
    setSelectedElement(child, 'element-inspector-select');
  }

  function selectContainer() {
    if (!selectedEl) return;
    var node = selectedEl.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      var hasId = !!node.id && node.id.indexOf('__phantom') === -1;
      var hasComponent = !!node.getAttribute('data-component');
      var clsCount = Array.from(node.classList).filter(function(c) { return c.indexOf('__phantom') === -1; }).length;
      if (hasId || hasComponent || clsCount >= 3) break;
      node = node.parentElement;
    }
    if (!node || node === document.body || node === document.documentElement) return;
    setSelectedElement(node, 'element-inspector-select');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && inlinePromptPanel) {
      e.preventDefault();
      closeInlinePrompt();
      return;
    }
    if (e.key === 'Escape' && classEditorPanel) hideClassEditor();
    else if (e.key === 'Escape' && contentAreaOverlayVisible) hideContentAreaOverlay();
    else if (e.key === 'Escape' && selectedEl) {
      clearSelectedElement();
      window.parent.postMessage({ type: 'element-inspector-clear' }, '*');
    }
    // Cmd/Ctrl+K opens the inline AI prompt for the selected element
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && inspectorActive && selectedEl && !classEditorPanel) {
      e.preventDefault();
      openInlinePrompt(selectedEl);
      return;
    }
    // Parent/child navigation: only when inspector active, element selected, no input focused
    if (!inspectorActive || !selectedEl) return;
    if (classEditorPanel) return;
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); selectParent(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectChild(); }
    if (e.key.toLowerCase() === 'c') { e.preventDefault(); postSelectedAction('jump-to-code'); }
    if (e.key.toLowerCase() === 'e') { e.preventDefault(); showClassEditorForSelection(); }
  }

  // ---- Component Outlines ----
  var outlineStyleEl = null;
  var outlineLabels = [];

  function showComponentOutlines() {
    if (outlineStyleEl) return;
    outlineStyleEl = document.createElement('style');
    outlineStyleEl.id = '__phantom-component-outlines';
    outlineStyleEl.textContent = '[data-component]{outline:2px dashed rgba(74,222,128,0.45);outline-offset:-2px;position:relative;}[data-component*="/layouts/"]{outline-color:rgba(251,146,60,0.45);}';
    document.head.appendChild(outlineStyleEl);
    createOutlineLabels();
  }

  function createOutlineLabels() {
    removeOutlineLabels();
    var elements = document.querySelectorAll('[data-component]');
    elements.forEach(function(el) {
      var comp = el.getAttribute('data-component');
      if (!comp) return;
      var isLayout = comp.indexOf('/layouts/') !== -1;
      var displayName = comp.split('/').pop().replace('.astro', '');

      var lbl = document.createElement('div');
      lbl.className = '__phantom-outline-label';
      lbl.textContent = displayName;
      lbl.style.cssText = 'position:absolute;top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1;padding:3px 7px;color:#fff;border-radius:3px;z-index:2147483646;white-space:nowrap;cursor:pointer;transition:filter 0.1s;' + (isLayout ? 'right:2px;background:rgba(251,146,60,0.9);' : 'left:2px;background:rgba(74,222,128,0.9);color:#052e16;');
      lbl.setAttribute('data-phantom-component-path', comp);

      lbl.addEventListener('mouseenter', function() { lbl.style.filter = 'brightness(1.2)'; });
      lbl.addEventListener('mouseleave', function() { lbl.style.filter = ''; });
      lbl.addEventListener('click', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.parent.postMessage({ type: 'component-outline-click', componentPath: comp }, '*');
      });

      var computedPos = window.getComputedStyle(el).position;
      if (computedPos === 'static') el.style.position = 'relative';
      el.appendChild(lbl);
      outlineLabels.push(lbl);
    });
  }

  function removeOutlineLabels() {
    outlineLabels.forEach(function(lbl) { if (lbl.parentNode) lbl.parentNode.removeChild(lbl); });
    outlineLabels = [];
  }

  function hideComponentOutlines() {
    removeOutlineLabels();
    if (outlineStyleEl) { outlineStyleEl.remove(); outlineStyleEl = null; }
  }

  // Listen for signals from the parent IDE
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'element-inspector-enable') enableInspector();
    if (e.data.type === 'element-inspector-disable') disableInspector();
    if (e.data.type === 'element-inspector-clear-hover') clearHoveredElement();
    if (e.data.type === 'class-editor-enable') classEditorMode = true;
    if (e.data.type === 'class-editor-disable') { classEditorMode = false; hideClassEditor(); }
    if (e.data.type === 'component-outlines-enable') showComponentOutlines();
    if (e.data.type === 'component-outlines-disable') hideComponentOutlines();
    if (e.data.type === 'tailwind-classes' && Array.isArray(e.data.classes)) {
      twClasses = e.data.classes;
      twMap = {};
      twClasses.forEach(function(c) { if (c && c.name) twMap[c.name] = c; });
    }
    if (e.data.type === 'select-parent') selectParent();
    if (e.data.type === 'select-child') selectChild();
    if (e.data.type === 'select-container') selectContainer();
    if (e.data.type === 'request-style-data' && selectedEl) sendStyleData(selectedEl);
    if (e.data.type === 'apply-instant-style' && selectedEl && e.data.property && e.data.value != null) {
      applyInstantStyle(selectedEl, e.data.property, e.data.value);
    }
    if (e.data.type === 'revert-instant-styles' && selectedEl) {
      revertInstantStyles(selectedEl);
    }
    if (e.data.type === 'theme-overlay' && typeof e.data.css === 'string') {
      applyThemeOverlay(e.data.css);
    }
    if (e.data.type === 'theme-overlay-clear') {
      clearThemeOverlay();
    }
    // Browser-style navigation driven by the IDE preview toolbar. We replace()
    // rather than push so the host browser's joint history is not polluted, and
    // walk our own sessionStorage-backed stack (see top of file). The load /
    // popstate handlers report the resulting URL so the address bar stays in sync.
    if (e.data.type === 'phantom-history-back') { try { phStep(-1); } catch (err) {} }
    if (e.data.type === 'phantom-history-forward') { try { phStep(1); } catch (err) {} }
    if (e.data.type === 'phantom-navigate' && e.data.url) { try { phGoto(e.data.url); } catch (err) {} }
  });

  // ============================================================
  // Theme overlay: lets the Theme Studio in the IDE preview live
  // edits without writing theme.css. We inject a <style> tag with
  // an extra-high specificity guarantee (placed last in <head>)
  // and remove it on clear or iframe unload.
  // ============================================================
  var _themeOverlayEl = null;
  function applyThemeOverlay(css) {
    if (!_themeOverlayEl) {
      _themeOverlayEl = document.createElement('style');
      _themeOverlayEl.id = 'phantom-theme-overlay';
      _themeOverlayEl.setAttribute('data-phantom', 'theme-overlay');
    }
    _themeOverlayEl.textContent = css;
    if (_themeOverlayEl.parentNode !== document.head) {
      document.head.appendChild(_themeOverlayEl);
    } else {
      document.head.appendChild(_themeOverlayEl);
    }
  }
  function clearThemeOverlay() {
    if (_themeOverlayEl && _themeOverlayEl.parentNode) {
      _themeOverlayEl.parentNode.removeChild(_themeOverlayEl);
    }
    _themeOverlayEl = null;
  }

  // Tell the parent we're ready so the studio can re-send the overlay after navigation.
  try { window.parent.postMessage({ type: 'phantom-ready', url: window.location.href }, '*'); } catch (e) {}

  // Detect CSS HMR updates by observing style/link changes in <head>.
  // When Vite applies a CSS HMR update, it modifies <style> tags or <link> hrefs.
  // We auto-revert instant style previews and refresh computed style data.
  // The short debounce window only exists to coalesce multiple <head> mutations
  // that belong to the same HMR cycle (e.g. one update touches several scoped
  // style tags); we no longer need a long buffer to "hide" a stale first HMR
  // update because the underlying staleness was fixed in phantom-dev-tools.ts.
  var INSTANT_STYLE_HMR_REVERT_DELAY_MS = 32;
  var _hmrDebounce = null;
  var _headObserver = new MutationObserver(function(mutations) {
    if (!selectedEl || Object.keys(_previewOriginals).length === 0) return;
    var relevant = false;
    for (var m = 0; m < mutations.length; m++) {
      var target = mutations[m].target;
      if (target.tagName === 'STYLE' || target.tagName === 'LINK' ||
          (mutations[m].addedNodes && mutations[m].addedNodes.length > 0)) {
        relevant = true;
        break;
      }
    }
    if (!relevant) return;
    if (_hmrDebounce) clearTimeout(_hmrDebounce);
    _hmrDebounce = setTimeout(function() {
      _hmrDebounce = null;
      if (selectedEl && Object.keys(_previewOriginals).length > 0) {
        revertInstantStyles(selectedEl);
      }
      if (selectedEl) sendStyleData(selectedEl);
    }, INSTANT_STYLE_HMR_REVERT_DELAY_MS);
  });
  _headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
})();