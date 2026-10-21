// Fixed, application-owned WebView program. The page contributes only inert JSON.
(() => {
  'use strict';
  const host = document.getElementById('diagram');
  function report(message) {
    const data = JSON.stringify(message);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
    else window.parent.postMessage(data, '*');
  }
  function error(code) {
    report({kind: 'error', code});
  }
  let payload;
  try {
    payload = JSON.parse(document.getElementById('mermaid-input').textContent);
  } catch {
    error('source');
    return;
  }
  if (payload.sourceError) { error(payload.sourceError); return; }
  const engine = globalThis.pele;
  if (typeof payload.width !== 'number' || !Number.isFinite(payload.width) || payload.width < 1 || payload.width > 4096 ||
      typeof payload.source !== 'string' || payload.source.length > 10000 || typeof engine === 'undefined') {
    error(typeof engine === 'undefined' ? 'resource' : 'limit');
    return;
  }
  const lifetime = new AbortController();
  let observer;
  function destroy() { lifetime.abort(); observer?.disconnect(); }
  window.addEventListener('pagehide', destroy, {signal: lifetime.signal});
  // There are no downloadable fonts. Force font discovery before layout, then
  // await the browser's font readiness instead of racing a synchronous render.
  host.getBoundingClientRect();
  document.fonts.ready.then(() => {
    if (lifetime.signal.aborted) return;
    try {
      if (Array.from(document.fonts).some(font => font.status === 'error')) throw new Error('font');
      const cached = payload.cached;
      const options = {
        links: false, images: false, limit: 10000, maxEdges: 300, outputLimit: 1000000,
        fontSize: payload.fontSize, fontFamily: 'system-ui, sans-serif', maxWidth: Math.max(100, payload.width),
        autoDirection: false, idPrefix: 'mermaid-page', now: Date.parse(payload.day + 'T00:00:00Z'),
      };
      const result = cached || engine.render(payload.source, options);
      if (typeof result.svg !== 'string' || !/^<svg(?:\s|>)/.test(result.svg.trimStart()) || result.svg.length > 1000000 ||
          !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0 ||
          result.width > 100000 || result.height > 100000) throw new Error('invalid result');
      host.innerHTML = result.svg;
      const svg = host.querySelector('svg');
      // Pele's inline height:auto outranks page CSS, including cached SVG.
      svg.style.width = '100%';
      svg.style.height = '100%';
      const natural = {x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y,
        width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height};
      if (![natural.x, natural.y, natural.width, natural.height].every(Number.isFinite) ||
          natural.width <= 0 || natural.height <= 0) throw new Error('invalid viewBox');
      svg.setAttribute('preserveAspectRatio', 'none');
      if (payload.full) svg.setAttribute('tabindex', '0');
      let fitted, view, boxWidth = 0, boxHeight = 0, zoom = 1, mouse, touch;
      let reported = false, lastCommandId = 0;
      const clamp = (value, size, start, extent) => size >= extent
        ? start - (size - extent) / 2 : Math.min(start + extent - size, Math.max(start, value));
      function paint() {
        svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
        if (!payload.full) return;
        svg.style.cursor = zoom > 1.001 ? 'grab' : '';
        report({kind: 'viewport', viewport: {
          zoom, cx: view.x + view.width / 2, cy: view.y + view.height / 2,
          width: boxWidth, height: boxHeight,
        }});
      }
      function reset() {
        if (!fitted) return;
        zoom = 1;
        view = {...fitted};
        paint();
      }
      function refresh() {
        if (lifetime.signal.aborted) return;
        const box = host.getBoundingClientRect();
        if (!Number.isFinite(box.width) || !Number.isFinite(box.height) ||
            box.width <= 0 || box.height <= 0 || box.width > 100000 || box.height > 100000) return;
        if (Math.abs(box.width - boxWidth) < .25 && Math.abs(box.height - boxHeight) < .25) return;
        boxWidth = box.width; boxHeight = box.height;
        const scale = Math.min(1, boxWidth / natural.width, boxHeight / natural.height);
        const width = boxWidth / scale, height = boxHeight / scale;
        fitted = {x: natural.x - (width - natural.width) / 2, y: natural.y - (height - natural.height) / 2, width, height};
        mouse = touch = undefined;
        const saved = payload.full && payload.viewport;
        if (!reported && saved && Number.isFinite(saved.zoom) && saved.zoom >= 1 && saved.zoom <= 32 &&
            Number.isFinite(saved.cx) && Number.isFinite(saved.cy) &&
            Math.abs(saved.width - boxWidth) < .5 && Math.abs(saved.height - boxHeight) < .5) {
          zoom = saved.zoom;
          const viewWidth = fitted.width / zoom, viewHeight = fitted.height / zoom;
          view = {x: clamp(saved.cx - viewWidth / 2, viewWidth, natural.x, natural.width),
            y: clamp(saved.cy - viewHeight / 2, viewHeight, natural.y, natural.height),
            width: viewWidth, height: viewHeight};
          paint();
        } else reset();
        if (!reported) {
          reported = true;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!lifetime.signal.aborted) report({
              kind: 'render', svg: result.svg, width: result.width, height: result.height,
              displayHeight: boxHeight,
            });
          }));
        }
      }
      if (!payload.full) {
        observer = new ResizeObserver(refresh);
        observer.observe(host);
        refresh();
        return;
      }
      function transform(factor, from, to = from) {
        if (!fitted || lifetime.signal.aborted) return false;
        const box = host.getBoundingClientRect();
        if (!Number.isFinite(box.width) || !Number.isFinite(box.height) ||
            box.width <= 0 || box.height <= 0 ||
            Math.abs(box.width - boxWidth) >= .25 || Math.abs(box.height - boxHeight) >= .25) return false;
        from ??= {x: box.left + box.width / 2, y: box.top + box.height / 2};
        to ??= from;
        const worldX = view.x + (from.x - box.left) / box.width * view.width;
        const worldY = view.y + (from.y - box.top) / box.height * view.height;
        zoom = Math.min(32, Math.max(1, zoom * factor));
        if (zoom <= 1.001) { reset(); return true; }
        const width = fitted.width / zoom, height = fitted.height / zoom;
        view = {x: clamp(worldX - (to.x - box.left) / box.width * width, width, natural.x, natural.width),
          y: clamp(worldY - (to.y - box.top) / box.height * height, height, natural.y, natural.height), width, height};
        paint();
        return true;
      }
      const listen = (target, name, handler, extra = {}) =>
        target.addEventListener(name, handler, {...extra, signal: lifetime.signal});
      listen(host, 'pointerdown', event => {
        if (event.pointerType === 'touch' || event.button !== 0 || zoom <= 1.001) return;
        mouse = {id: event.pointerId, x: event.clientX, y: event.clientY};
        host.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      listen(host, 'pointermove', event => {
        if (!mouse || event.pointerId !== mouse.id) return;
        const next = {x: event.clientX, y: event.clientY};
        mouse = transform(1, mouse, next) ? {...next, id: mouse.id} : undefined;
      });
      const endMouse = event => { if (mouse?.id === event.pointerId) mouse = undefined; };
      listen(host, 'pointerup', endMouse);
      listen(host, 'pointercancel', endMouse);
      listen(host, 'lostpointercapture', endMouse);
      function sample(event) {
        const points = [...event.touches].filter(point => host.contains(point.target));
        if (points.length === 2) return {count: 2, x: (points[0].clientX + points[1].clientX) / 2,
          y: (points[0].clientY + points[1].clientY) / 2,
          distance: Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY)};
        if (points.length === 1) return {count: 1, x: points[0].clientX, y: points[0].clientY};
      }
      listen(host, 'touchstart', event => {
        touch = sample(event);
        if (touch && event.cancelable) event.preventDefault();
      }, {passive: false});
      listen(host, 'touchmove', event => {
        if (event.cancelable) event.preventDefault();
        const next = sample(event);
        if (touch && next && touch.count === next.count) {
          const factor = next.count === 2 && touch.distance > 0 ? next.distance / touch.distance : 1;
          if (!transform(factor, touch, next)) { touch = undefined; return; }
        }
        touch = next;
      }, {passive: false});
      listen(host, 'touchend', event => {
        if (event.cancelable) event.preventDefault();
        touch = sample(event);
      }, {passive: false});
      listen(host, 'touchcancel', () => {
        touch = undefined;
      });
      listen(host, 'wheel', event => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        transform(2 ** (-Math.max(-24, Math.min(24, event.deltaY)) * .02), {x: event.clientX, y: event.clientY});
      }, {passive: false});
      listen(host, 'keydown', event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === '+' || event.key === '=') transform(1.5);
        else if (event.key === '-') transform(1 / 1.5);
        else if (event.key === '0') reset();
        else return;
        event.preventDefault();
      });
      // RN delivers WebView.postMessage on document or window depending on
      // platform/version. A command ID prevents duplicate application.
      function control(event) {
        if (!window.ReactNativeWebView && event.source !== window.parent) return;
        if (typeof event.data !== 'string' || event.data.length > 128) return;
        let command;
        try { command = JSON.parse(event.data); } catch { return; }
        if (command?.kind !== 'mermaid-control' || !Number.isSafeInteger(command.id) ||
            command.id <= lastCommandId || !['in', 'out', 'reset'].includes(command.action)) return;
        lastCommandId = command.id;
        if (command.action === 'reset') reset();
        else transform(command.action === 'in' ? 1.5 : 1 / 1.5);
      }
      listen(window, 'message', control);
      if (window.ReactNativeWebView) listen(document, 'message', control);
      observer = new ResizeObserver(refresh);
      observer.observe(host);
      refresh();
    } catch (reason) {
      destroy();
      host.replaceChildren();
      const code = reason && typeof reason.code === 'string' &&
        ['syntax', 'semantic', 'unsupported-diagram', 'limit'].includes(reason.code) ? reason.code : 'render';
      error(code);
    }
  }, () => { if (!lifetime.signal.aborted) { destroy(); error('resource'); } });
})();
