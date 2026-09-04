/* Review notes overlay: "Mark it up".
   Sits on top of ANY page: a local dev server, a live site, anything in the
   browser. Point at a part of the page, write "fix this", and the note lands
   in a file on Tom's Mac that Claude reads. No build step, no dependency on
   the page it is sitting on top of.

   Loaded one of three ways, all the same script:
     1. the Chrome extension in this folder (any site, one click),
     2. a dev server that injects <script src="http://localhost:8899/notes.js">,
     3. the bookmarklet on the notes board. */
(function () {
  'use strict';

  var SERVER = 'http://localhost:8899';
  if (window.__reviewNotes) { window.__reviewNotes.toggle(); return; }
  // Injected into every frame of the tab so things inside an embedded page
  // (a Claude artefact, say) can be marked. Tiny frames (ad slots, hidden
  // helpers) are skipped rather than sprouting a pill each.
  var IN_FRAME = window !== window.top;
  if (IN_FRAME && (window.innerWidth < 240 || window.innerHeight < 160)) return;

  // Where the notes are going. The extension's background worker answers
  // 'server' when server.py is running and 'local' when it keeps them itself.
  var STORE = 'server';

  /* ---------- talking to the notes server ----------
     From the Chrome extension, every request goes through the background
     worker: its fetch runs under the extension's own permissions, so a live
     site's Content Security Policy and mixed-content rules never see it.
     Everywhere else (a dev server, the bookmarklet) it is a plain fetch. */
  var VIA_EXTENSION = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
  function call(method, path, body) {
    if (VIA_EXTENSION) {
      return new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage({ type: 'notes', method: method, path: path, body: body }, function (res) {
          if (chrome.runtime.lastError || !res) return reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no reply'));
          if (res.store) STORE = res.store;
          if (!res.ok) return reject(new Error(res.error || 'request failed'));
          resolve(res.data);
        });
      });
    }
    return fetch(SERVER + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); });
  }

  /* ---------- which app are we looking at ----------
     Local dev servers are told apart by port; everything else by host name.
     A page can set window.__reviewNotesApp before this loads to name itself. */
  var LOCAL = {
    '5187': 'Turf canary · field',
    '5188': 'Turf canary · control',
    '5287': 'Turf main · field',
    '5288': 'Turf main · control',
  };
  var APP = window.__reviewNotesApp
    || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? (LOCAL[location.port] || ('localhost:' + location.port)) : location.hostname);

  /* ---------- shadow-DOM host so the app's CSS cannot touch us ---------- */
  var host = document.createElement('div');
  host.id = '__review_notes_host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  document.documentElement.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  var css = document.createElement('style');
  css.textContent = [
    ':host,*{box-sizing:border-box}',
    '.wrap.low .pill{top:auto;bottom:62px}.wrap.low .bar{top:auto;bottom:62px}.wrap.low .panel{top:auto;bottom:110px}',
    '.wrap{position:fixed;inset:0;pointer-events:none;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#14181a}',
    '.pill{position:fixed;right:14px;top:62px;pointer-events:auto;display:flex;align-items:center;gap:8px;',
    '  background:#14181a;color:#fff;border-radius:999px;padding:9px 14px;box-shadow:0 8px 24px -8px rgba(0,0,0,.6);cursor:pointer;',
    '  font-weight:600;letter-spacing:.01em;user-select:none;border:1px solid rgba(255,255,255,.14)}',
    '.pill.on{background:#d4553a}',
    '.pill .dot{width:8px;height:8px;border-radius:50%;background:#6b747b}',
    '.pill.on .dot{background:#fff}',
    '.pill .tag{font-size:11px;opacity:.7;font-weight:500}',
    '.bar{position:fixed;left:50%;transform:translateX(-50%);top:62px;pointer-events:auto;display:flex;gap:6px;',
    '  background:#14181a;color:#fff;border-radius:10px;padding:6px;box-shadow:0 8px 24px -8px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14)}',
    '.bar button{font:inherit;font-weight:600;font-size:12px;color:#fff;background:transparent;border:0;border-radius:7px;padding:7px 11px;cursor:pointer}',
    '.bar button:hover{background:rgba(255,255,255,.12)}',
    '.bar button.sel{background:#d4553a}',
    '.bar .hint{align-self:center;font-size:11px;opacity:.6;padding:0 8px 0 4px;font-weight:500}',
    '.hi{position:fixed;pointer-events:none;border:2px solid #d4553a;border-radius:4px;background:rgba(212,85,58,.13);transition:all .04s linear}',
    '.hl{position:fixed;pointer-events:none;background:#d4553a;color:#fff;font-size:11px;font-weight:600;padding:3px 7px;',
    '  border-radius:5px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}',
    '.sel-box{position:fixed;pointer-events:none;border:2px dashed #d4553a;background:rgba(212,85,58,.10);border-radius:4px}',
    '.card{position:fixed;pointer-events:auto;width:360px;background:#fff;border:1px solid #dce0da;border-radius:12px;',
    '  box-shadow:0 20px 48px -18px rgba(0,0,0,.45);padding:12px;display:flex;flex-direction:column;gap:9px}',
    '.card.drop{outline:2px dashed #d4553a;outline-offset:-4px}',
    '.refs{border-top:1px solid #e6e9e2;padding-top:8px;display:flex;flex-direction:column;gap:6px}',
    '.refs .what{display:flex;align-items:center;gap:6px}',
    '.refs .what .tip{font-weight:500;text-transform:none;letter-spacing:0;opacity:.8}',
    '.linkrow{display:flex;gap:5px}',
    '.linkrow input{font:inherit;font-size:12px;flex:1;border:1px solid #c2c8bd;border-radius:7px;padding:6px 8px;color:#14181a;background:#fff;min-width:0}',
    '.linkrow input:focus{outline:2px solid #d4553a;outline-offset:-1px;border-color:#d4553a}',
    '.reftools{display:flex;gap:5px;flex-wrap:wrap;align-items:center}',
    '.btn.sm{font-size:11px;padding:5px 9px}',
    '.btn.tog.on{background:#14181a;border-color:#14181a;color:#fff}',
    '.attach{display:flex;gap:6px;flex-wrap:wrap}',
    '.attach .a{position:relative;display:flex;align-items:center;gap:5px;max-width:100%;border:1px solid #dce0da;border-radius:7px;background:#f7f8f6;font-size:11px;color:#3d454a;padding:3px 22px 3px 4px}',
    '.attach .a img{width:44px;height:32px;object-fit:cover;border-radius:4px;background:#e6e9e2}',
    '.attach .a span{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.attach .a .x{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:16px;height:16px;border:0;border-radius:50%;',
    '  background:#14181a;color:#fff;font-size:10px;line-height:16px;text-align:center;cursor:pointer;padding:0}',
    '.card .what{font-size:11px;color:#6b747b;font-weight:600;text-transform:uppercase;letter-spacing:.05em}',
    '.card .el{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#3d454a;background:#f7f8f6;border:1px solid #e6e9e2;',
    '  border-radius:6px;padding:6px 7px;max-height:56px;overflow:auto;word-break:break-all}',
    '.card textarea{font:inherit;width:100%;min-height:82px;resize:vertical;border:1px solid #c2c8bd;border-radius:8px;padding:8px;color:#14181a;background:#fff}',
    '.card textarea:focus{outline:2px solid #d4553a;outline-offset:-1px;border-color:#d4553a}',
    '.chips{display:flex;gap:5px;flex-wrap:wrap}',
    '.chip{font:inherit;font-size:11px;font-weight:600;border:1px solid #c2c8bd;background:#fff;color:#3d454a;border-radius:999px;padding:4px 10px;cursor:pointer}',
    '.chip.on{background:#14181a;border-color:#14181a;color:#fff}',
    '.row{display:flex;gap:6px;justify-content:flex-end;align-items:center}',
    '.row .sp{margin-right:auto;font-size:11px;color:#6b747b}',
    '.btn{font:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:7px 13px;cursor:pointer;border:1px solid #c2c8bd;background:#fff;color:#14181a}',
    '.btn.pri{background:#d4553a;border-color:#d4553a;color:#fff}',
    '.pin{position:fixed;pointer-events:auto;width:22px;height:22px;border-radius:50%;background:#d4553a;color:#fff;font-size:11px;',
    '  font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer;border:2px solid #fff}',
    '.panel{position:fixed;right:14px;top:110px;width:400px;max-height:62vh;pointer-events:auto;background:#fff;border:1px solid #dce0da;',
    '  border-radius:12px;box-shadow:0 20px 48px -18px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}',
    '.panel h3{margin:0;padding:11px 13px;font-size:13px;border-bottom:1px solid #e6e9e2;display:flex;align-items:center;gap:8px}',
    '.panel h3 .sp{margin-left:auto;display:flex;gap:6px}',
    '.panel .list{overflow:auto;padding:6px}',
    '.n{border:1px solid #e6e9e2;border-radius:9px;padding:8px 9px;margin-bottom:6px;background:#fdfdfc}',
    '.n .meta{font-size:10px;color:#6b747b;font-weight:600;display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px}',
    '.n .meta b{color:#a8382a}',
    '.n .txt{font-size:12px;white-space:pre-wrap}',
    '.n .acts{margin-top:5px;display:flex;gap:6px}',
    '.n .acts button{font:inherit;font-size:11px;border:1px solid #dce0da;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer}',
    '.n.done{opacity:.55;border-style:dashed}',
    '.n.done .meta b{color:#2f7d4f}',
    '.n .did{font-size:11px;color:#1f5a38;background:#e8f3ec;border-radius:6px;padding:4px 7px;margin-top:4px}',
    '.empty{padding:22px 14px;text-align:center;color:#6b747b;font-size:12px}',
    '.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:80px;pointer-events:none;background:#14181a;color:#fff;',
    '  font-size:12px;font-weight:600;padding:8px 14px;border-radius:8px;opacity:0;transition:opacity .18s}',
    '.toast.on{opacity:1}',
  ].join('\n');
  root.appendChild(css);

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(wrap);

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* ---------- state ---------- */
  var mode = 'off';           // off | element | area
  var notes = [];
  var hoverEl = null;
  var depth = 0;              // how many parents up from the hovered node
  var card = null;
  var panel = null;

  var pill = el('div', 'pill');
  var pillDot = el('span', 'dot');
  var pillTxt = el('span', null, 'Mark it up');
  var pillTag = el('span', 'tag', APP.length > 28 ? APP.slice(0, 26) + '…' : APP);
  pill.append(pillDot, pillTxt, pillTag);
  wrap.appendChild(pill);

  var hi = el('div', 'hi'); hi.style.display = 'none'; wrap.appendChild(hi);
  var hl = el('div', 'hl'); hl.style.display = 'none'; wrap.appendChild(hl);
  var toast = el('div', 'toast'); wrap.appendChild(toast);

  var bar = el('div', 'bar'); bar.style.display = 'none';
  var bEl = el('button', 'sel', 'Point at a thing');
  var bArea = el('button', null, 'Drag a box');
  var bList = el('button', null, 'My notes');
  var bFlip = el('button', null, '\u21c5');
  var bOff = el('button', null, 'Done');
  var hint = el('span', 'hint', '[ and ] widen / narrow  ·  Esc cancels');
  bar.append(bEl, bArea, hint, bList, bFlip, bOff);
  wrap.appendChild(bar);

  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    clearTimeout(say._t);
    say._t = setTimeout(function () { toast.classList.remove('on'); }, 1600);
  }

  /* ---------- describing an element ---------- */
  function cssPath(node) {
    var parts = [];
    var n = node;
    while (n && n.nodeType === 1 && parts.length < 8) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      var seg = n.tagName.toLowerCase();
      var testid = n.getAttribute && (n.getAttribute('data-testid') || n.getAttribute('data-test'));
      if (testid) { parts.unshift(seg + '[data-testid="' + testid + '"]'); break; }
      var cls = (n.getAttribute && n.getAttribute('class') || '').trim().split(/\s+/)
        .filter(function (c) { return c && !/^(css-|sc-)/.test(c) && c.length < 34; }).slice(0, 3);
      if (cls.length) seg += '.' + cls.join('.');
      var p = n.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function label(node) {
    if (!node) return '';
    var t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 70) t = t.slice(0, 70) + '…';
    var tag = node.tagName.toLowerCase();
    var aria = node.getAttribute && node.getAttribute('aria-label');
    return tag + (aria ? ' “' + aria + '”' : '') + (t ? ' — ' + t : '');
  }

  function place(node) {
    var r = node.getBoundingClientRect();
    hi.style.display = 'block';
    hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px'; hi.style.height = r.height + 'px';
    hl.style.display = 'block';
    hl.textContent = label(node);
    var top = r.top - 22; if (top < 2) top = r.bottom + 4;
    hl.style.left = Math.max(4, r.left) + 'px'; hl.style.top = top + 'px';
  }

  function clearHi() { hi.style.display = 'none'; hl.style.display = 'none'; }

  /* A click usually lands on a leaf — the <svg> inside a button, the <span>
     inside a link. Snap up to the thing a person would say they clicked. */
  var LEAF = /^(svg|path|circle|rect|line|polyline|polygon|g|use|i|img|b|strong|em)$/;
  var MEANS = 'button,a,[role="button"],[role="tab"],[role="link"],label,li,th,td,summary,[data-testid]';
  function snap(n) {
    if (!n) return n;
    if (LEAF.test(n.tagName.toLowerCase())) {
      var up = n.closest && n.closest(MEANS);
      if (up) return up;
      if (n.parentElement) return n.parentElement;
    }
    if (n.tagName.toLowerCase() === 'span') {
      var b = n.closest && n.closest('button,a,[role="button"],[role="tab"]');
      if (b && b.textContent.trim().length < 60) return b;
    }
    return n;
  }

  function pick(x, y) {
    host.style.visibility = 'hidden';
    var n = document.elementFromPoint(x, y);
    host.style.visibility = '';
    if (!n) return null;
    n = snap(n);
    for (var i = 0; i < depth && n.parentElement && n.parentElement !== document.body; i++) n = n.parentElement;
    return n;
  }

  /* ---------- pictures on a note ----------
     "Make it look like this." A screenshot pasted from the clipboard, dropped
     from Finder, or picked with a file dialog. Everything is shrunk to at
     most MAX_EDGE pixels on its long side before it leaves the browser, so a
     Retina screenshot does not become a 12 MB note. */
  var MAX_EDGE = 2000;
  var MAX_DATA_URL = 2500000; // about 1.8 MB of image; above this, use JPEG

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('not an image')); };
      img.src = src;
    });
  }

  // Draw the image (or a piece of it) onto a canvas no bigger than MAX_EDGE
  // and return { data, w, h }. `crop` is optional: {x, y, w, h} in image pixels.
  function shrink(img, crop) {
    var sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
    var sw = crop ? crop.w : img.naturalWidth, sh = crop ? crop.h : img.naturalHeight;
    var scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    var data = c.toDataURL('image/png');
    if (data.length > MAX_DATA_URL) data = c.toDataURL('image/jpeg', 0.88);
    return { data: data, w: c.width, h: c.height };
  }

  function imageFromFile(file) {
    var url = URL.createObjectURL(file);
    return loadImage(url).then(function (img) {
      URL.revokeObjectURL(url);
      var out = shrink(img);
      out.name = file.name || 'pasted image';
      out.role = 'reference';
      return out;
    });
  }

  // Ask the extension for a picture of the visible tab, then crop it to the
  // marked box. The overlay hides itself first so its own highlight and this
  // card do not end up in the picture.
  function snapMarked(box) {
    if (!VIA_EXTENSION) return Promise.reject(new Error('Snapping needs the Chrome extension'));
    host.style.visibility = 'hidden';
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'capture' }, function (res) {
        host.style.visibility = '';
        if (chrome.runtime.lastError || !res) return reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no reply'));
        if (!res.ok) return reject(new Error(res.error || 'capture failed'));
        resolve(res.data);
      });
    }).then(loadImage).then(function (img) {
      // The capture is in device pixels; the box is in CSS pixels. Scale by
      // what the browser actually gave us rather than trusting devicePixelRatio.
      var kx = img.naturalWidth / window.innerWidth, ky = img.naturalHeight / window.innerHeight;
      var pad = 16;
      var x0 = Math.max(0, box.left - pad), y0 = Math.max(0, box.top - pad);
      var x1 = Math.min(window.innerWidth, box.left + box.width + pad);
      var y1 = Math.min(window.innerHeight, box.top + box.height + pad);
      var out = shrink(img, { x: x0 * kx, y: y0 * ky, w: Math.max(1, (x1 - x0) * kx), h: Math.max(1, (y1 - y0) * ky) });
      out.name = 'what I marked'; out.role = 'marked';
      return out;
    });
  }

  var URL_IN_TEXT = /https?:\/\/[^\s)\]>"']+/g;

  /* ---------- the note composer ---------- */
  function closeCard() { if (card) { card.remove(); card = null; } }

  function compose(target) {
    closeCard();
    var box = target.rect;
    card = el('div', 'card');
    var w = 360;
    var left = Math.min(Math.max(8, box.left), window.innerWidth - w - 8);
    var top = box.top + box.height + 8;
    if (top + 380 > window.innerHeight) top = Math.max(8, Math.min(box.top - 388, window.innerHeight - 388));
    card.style.left = left + 'px'; card.style.top = top + 'px';

    card.appendChild(el('div', 'what', target.kind === 'area' ? 'A region of this screen' : 'This element'));
    card.appendChild(el('div', 'el', target.kind === 'area'
      ? Math.round(box.width) + '×' + Math.round(box.height) + ' at ' + Math.round(box.left) + ',' + Math.round(box.top)
      : target.label));

    var ta = el('textarea');
    ta.placeholder = 'What is wrong with this, or what should it become?';
    card.appendChild(ta);

    var chips = el('div', 'chips');
    var kinds = ['Fix this', 'Redesign', 'Idea', 'Question', 'Broken'];
    var kind = 'Fix this';
    kinds.forEach(function (k) {
      var c = el('button', 'chip' + (k === kind ? ' on' : ''), k);
      c.onclick = function () {
        kind = k;
        Array.prototype.forEach.call(chips.children, function (x) { x.classList.toggle('on', x.textContent === k); });
        ta.focus();
      };
      chips.appendChild(c);
    });
    card.appendChild(chips);

    /* "Show me what you mean": links to other sites and pictures. */
    var links = [];
    var images = [];   // { name, data, role, w, h }
    var refs = el('div', 'refs');
    var head = el('div', 'what', 'Show me what you mean');
    head.appendChild(el('span', 'tip', '· paste or drop a screenshot, or add a link'));
    refs.appendChild(head);

    var linkRow = el('div', 'linkrow');
    var linkIn = el('input');
    linkIn.type = 'url';
    linkIn.placeholder = 'https://  a site or page to copy';
    var linkAdd = el('button', 'btn sm', 'Add link');
    linkRow.append(linkIn, linkAdd);
    refs.appendChild(linkRow);

    var tools = el('div', 'reftools');
    var fileIn = el('input');
    fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.multiple = true; fileIn.style.display = 'none';
    var bPick = el('button', 'btn sm', 'Add image');
    tools.append(fileIn, bPick);
    var snapOn = false;
    var bSnap = null;
    if (VIA_EXTENSION) {
      try { snapOn = localStorage.getItem('__review_notes_snap') === '1'; } catch (err) { /* ignore */ }
      bSnap = el('button', 'btn sm tog' + (snapOn ? ' on' : ''), 'Snap what I marked');
      bSnap.title = 'Also attach a screenshot of the thing you pointed at, so Claude sees how it looks today';
      bSnap.onclick = function () {
        snapOn = !snapOn;
        bSnap.classList.toggle('on', snapOn);
        try { localStorage.setItem('__review_notes_snap', snapOn ? '1' : '0'); } catch (err) { /* ignore */ }
        ta.focus();
      };
      tools.appendChild(bSnap);
    }
    refs.appendChild(tools);

    var attach = el('div', 'attach');
    attach.style.display = 'none';
    refs.appendChild(attach);
    card.appendChild(refs);

    function paintAttach() {
      attach.textContent = '';
      links.forEach(function (l, i) {
        var a = el('div', 'a');
        a.appendChild(el('span', null, '🔗 ' + l.replace(/^https?:\/\//, '')));
        var x = el('button', 'x', '×'); x.title = 'Remove';
        x.onclick = function () { links.splice(i, 1); paintAttach(); };
        a.appendChild(x);
        attach.appendChild(a);
      });
      images.forEach(function (im, i) {
        var a = el('div', 'a');
        var img = document.createElement('img'); img.src = im.data; a.appendChild(img);
        a.appendChild(el('span', null, im.name + ' · ' + im.w + '×' + im.h));
        var x = el('button', 'x', '×'); x.title = 'Remove';
        x.onclick = function () { images.splice(i, 1); paintAttach(); };
        a.appendChild(x);
        attach.appendChild(a);
      });
      attach.style.display = (links.length || images.length) ? 'flex' : 'none';
    }

    function addLink() {
      var v = linkIn.value.trim();
      if (!v) return;
      if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
      if (links.indexOf(v) < 0) links.push(v);
      linkIn.value = '';
      paintAttach();
      ta.focus();
    }
    linkAdd.onclick = addLink;
    linkIn.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); addLink(); }
      if (e.key === 'Escape') { closeCard(); clearHi(); }
    };

    function addFiles(list) {
      var files = Array.prototype.filter.call(list || [], function (f) { return /^image\//.test(f.type); });
      if (!files.length) return false;
      files.forEach(function (f) {
        imageFromFile(f).then(function (im) {
          if (images.length >= 8) { say('Eight pictures is plenty for one note'); return; }
          images.push(im); paintAttach();
        }).catch(function () { say('That did not look like an image'); });
      });
      return true;
    }
    bPick.onclick = function () { fileIn.click(); };
    fileIn.onchange = function () { addFiles(fileIn.files); fileIn.value = ''; ta.focus(); };

    // Cmd+V with a screenshot on the clipboard (Cmd+Ctrl+Shift+4 on a Mac
    // puts one there) drops it straight onto the note.
    card.addEventListener('paste', function (e) {
      var files = [];
      var items = e.clipboardData && e.clipboardData.items;
      for (var i = 0; items && i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    card.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); card.classList.add('drop'); });
    card.addEventListener('dragleave', function () { card.classList.remove('drop'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      card.classList.remove('drop');
      var dt = e.dataTransfer;
      if (dt && !addFiles(dt.files)) {
        var txt = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim().split(/\s+/)[0];
        if (txt && /^https?:\/\//i.test(txt)) { linkIn.value = txt; addLink(); }
      }
    });

    var row = el('div', 'row');
    row.appendChild(el('span', 'sp', '⌘⏎ to save'));
    var cancel = el('button', 'btn', 'Cancel');
    var save = el('button', 'btn pri', 'Save note');
    row.append(cancel, save);
    card.appendChild(row);

    cancel.onclick = function () { closeCard(); clearHi(); };
    var saving = false;
    save.onclick = function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (saving) return;
      saving = true;
      save.textContent = 'Saving…';
      // Any web address typed into the note counts as a reference link too.
      (text.match(URL_IN_TEXT) || []).forEach(function (u) { if (links.indexOf(u) < 0) links.push(u); });
      var note = {
        app: APP, title: document.title,
        url: location.href, route: location.pathname + location.hash,
        kind: kind, target_kind: target.kind, text: text,
        selector: target.selector || '', element: target.label || '',
        html: target.html || '',
        rect: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
        viewport: window.innerWidth + '×' + window.innerHeight,
        at: new Date().toISOString(),
        links: links.slice(),
        images: images.slice(),
      };
      var snap = snapOn ? snapMarked(box).catch(function (err) { say(err.message); return null; }) : Promise.resolve(null);
      var myCard = card;
      snap.then(function (shot) {
        if (shot) note.images.push(shot);
        send(note);
        if (card === myCard) { closeCard(); clearHi(); }
      });
    };
    ta.onkeydown = function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeCard(); clearHi(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.onclick();
    };

    wrap.appendChild(card);
    setTimeout(function () { ta.focus(); }, 0);
  }

  /* ---------- pointing ---------- */
  function onMove(e) {
    if (mode !== 'element' || card) return;
    var n = pick(e.clientX, e.clientY);
    if (!n || n === hoverEl) return;
    hoverEl = n;
    place(n);
  }

  function onClick(e) {
    if (mode !== 'element' || card) return;
    if (root.contains(e.composedPath()[0])) return;
    e.preventDefault(); e.stopPropagation();
    var n = pick(e.clientX, e.clientY);
    if (!n) return;
    place(n);
    compose({
      kind: 'element', rect: n.getBoundingClientRect(), label: label(n),
      selector: cssPath(n), html: (n.outerHTML || '').slice(0, 600),
    });
  }

  function typing(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function onKey(e) {
    if (!typing(e) && !card && (e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setMode(mode === 'off' ? 'element' : 'off');
      return;
    }
    if (mode === 'off') return;
    if (e.key === 'Escape') { closeCard(); clearHi(); return; }
    if (card) return;
    if (e.key === '[' || e.key === ']') {
      depth = Math.max(0, depth + (e.key === '[' ? 1 : -1));
      if (hoverEl) {
        var n = hoverEl;
        if (e.key === '[' && n.parentElement) n = n.parentElement;
        hoverEl = n; place(n);
      }
      say(depth ? 'Selecting ' + depth + ' level(s) out' : 'Selecting the exact element');
    }
  }

  /* ---------- dragging a box ---------- */
  var drag = null, dragBox = el('div', 'sel-box');
  dragBox.style.display = 'none';
  wrap.appendChild(dragBox);

  function onDown(e) {
    if (mode !== 'area' || card) return;
    if (root.contains(e.composedPath()[0])) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY };
    dragBox.style.display = 'block';
  }
  function onDrag(e) {
    if (!drag) return;
    var x = Math.min(drag.x, e.clientX), y = Math.min(drag.y, e.clientY);
    var w = Math.abs(e.clientX - drag.x), h = Math.abs(e.clientY - drag.y);
    dragBox.style.left = x + 'px'; dragBox.style.top = y + 'px';
    dragBox.style.width = w + 'px'; dragBox.style.height = h + 'px';
  }
  function onUp(e) {
    if (!drag) return;
    var x = Math.min(drag.x, e.clientX), y = Math.min(drag.y, e.clientY);
    var w = Math.abs(e.clientX - drag.x), h = Math.abs(e.clientY - drag.y);
    drag = null;
    if (w < 12 || h < 12) { dragBox.style.display = 'none'; return; }
    var under = pick(x + w / 2, y + h / 2);
    compose({
      kind: 'area', rect: { left: x, top: y, width: w, height: h },
      label: under ? label(under) : '', selector: under ? cssPath(under) : '',
      html: '',
    });
    setTimeout(function () { dragBox.style.display = 'none'; }, 200);
  }

  /* ---------- saving ---------- */
  function send(note) {
    call('POST', '/note', note).then(function (res) {
      notes.unshift(res.note);
      paintPill();
      if (panel) renderPanel();
      var extras = (res.note.links || []).length + (res.note.images || []).length;
      say('Saved: note #' + res.note.n + (extras ? ' with ' + extras + ' attachment' + (extras > 1 ? 's' : '') : '')
        + (STORE === 'local' ? ' (kept in the extension)' : ''));
    }).catch(function () {
      try {
        var stash = JSON.parse(localStorage.getItem('__review_notes') || '[]');
        stash.unshift(note); localStorage.setItem('__review_notes', JSON.stringify(stash));
      } catch (err) { /* ignore */ }
      say('Notes server is not running — saved in this browser only');
    });
  }

  function load() {
    call('GET', '/notes').then(function (res) {
      notes = res.notes || [];
      paintPill();
      if (panel) renderPanel();
    }).catch(function () { /* offline is fine */ });
  }

  function paintPill() {
    var base = mode === 'off' ? 'Mark it up' : 'Marking on';
    var open = notes.filter(function (n) { return n.status !== 'done'; }).length;
    pillTxt.textContent = open ? base + ' · ' + open + ' open' : base;
  }

  /* ---------- the list ---------- */
  function renderPanel() {
    var list = panel.querySelector('.list');
    list.textContent = '';
    if (!notes.length) {
      list.appendChild(el('div', 'empty', 'No notes yet. Point at something and say what is wrong with it.'));
      return;
    }
    // Open notes first, done ones greyed out underneath.
    var ordered = notes.filter(function (n) { return n.status !== 'done'; })
      .concat(notes.filter(function (n) { return n.status === 'done'; }));
    ordered.forEach(function (n) {
      var done = n.status === 'done';
      var box = el('div', 'n' + (done ? ' done' : ''));
      var meta = el('div', 'meta');
      meta.appendChild(el('b', null, (done ? '✅ ' : '') + '#' + n.n + ' ' + n.kind));
      meta.appendChild(el('span', null, n.app));
      meta.appendChild(el('span', null, n.route));
      var nl = (n.links || []).length, ni = (n.images || []).length;
      if (nl || ni) meta.appendChild(el('span', null, (nl ? '🔗' + nl + ' ' : '') + (ni ? '🖼' + ni : '')));
      box.appendChild(meta);
      box.appendChild(el('div', 'txt', n.text));
      if (done) box.appendChild(el('div', 'did', 'Done by ' + (n.done_by || '?') + ': ' + (n.action || 'no detail given')));
      var acts = el('div', 'acts');
      var flip = el('button', null, done ? 'Reopen' : 'Done');
      flip.onclick = function () {
        call('POST', '/note/' + n.id + (done ? '/reopen' : '/done'), { by: 'me', action: '' })
          .then(function (res) {
            notes = notes.map(function (x) { return x.id === n.id ? res.note : x; });
            paintPill(); renderPanel();
          }).catch(function () { say('Notes server is not running'); });
      };
      var del = el('button', null, 'Delete');
      del.onclick = function () {
        call('DELETE', '/note/' + n.id)
          .then(function () { notes = notes.filter(function (x) { return x.id !== n.id; }); paintPill(); renderPanel(); });
      };
      acts.append(flip, del);
      box.appendChild(acts);
      list.appendChild(box);
    });
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = el('div', 'panel');
    var h = el('h3', null, 'What I have marked');
    var sp = el('div', 'sp');
    if (STORE === 'local') {
      // No notes server: the notes live in the extension, so the way out is
      // a zip (notes.md plus the pictures) or the text on the clipboard.
      var copy = el('button', 'btn sm', 'Copy notes');
      copy.onclick = function () {
        exportAll().then(function (bundle) {
          return navigator.clipboard.writeText(bundle.markdown);
        }).then(function () { say('Notes copied. Paste them into Claude.'); })
          .catch(function () { say('Could not copy. Try Export instead.'); });
      };
      var exp = el('button', 'btn sm pri', 'Export zip');
      exp.onclick = function () {
        exportAll().then(function (bundle) {
          download(bundle.blob, 'mark-it-up-notes.zip');
          say('Downloading your notes as a zip');
        }).catch(function (err) { say('Export failed: ' + err.message); });
      };
      sp.append(copy, exp);
    } else {
      var open = el('button', 'btn sm', 'Open the board');
      open.onclick = function () { window.open(SERVER + '/', '_blank'); };
      sp.appendChild(open);
    }
    h.appendChild(sp);
    panel.appendChild(h);
    panel.appendChild(el('div', 'list'));
    wrap.appendChild(panel);
    renderPanel();
  }

  /* ---------- getting notes out without a server ----------
     Builds the same notes.md the server writes, plus the pictures, and
     packs them into one zip. The zip is written by hand (no compression,
     just the container) so there is nothing to install. */
  function exportAll() {
    return Promise.all([call('GET', '/notes'), call('GET', '/filed').catch(function () { return { notes: [] }; })])
      .then(function (res) {
        var live = res[0].notes || [], filed = res[1].notes || [];
        var files = [{ name: 'notes.md', bytes: new TextEncoder().encode(notesMarkdown(live, filed)) }];
        live.concat(filed).forEach(function (n) {
          (n.images || []).forEach(function (im) {
            if (im.data && im.file) files.push({ name: im.file, bytes: bytesOf(im.data) });
          });
        });
        return { markdown: notesMarkdown(live, filed), blob: zip(files) };
      });
  }

  function notesMarkdown(live, filed) {
    var open = live.filter(function (n) { return n.status !== 'done'; });
    var done = live.filter(function (n) { return n.status === 'done'; });
    var out = [
      '# Mark-up notes', '',
      'Written by pointing at pages in the browser, not by hand. Newest first inside each app.', '',
      'Pictures are in `refs/` beside this file. A **Reference** is what it should look like; ' +
      'a **Screenshot of what I marked** is how it looks today.', '',
      '_' + open.length + ' open, ' + done.length + ' done, ' + filed.length + ' filed. Exported ' + new Date().toLocaleString() + '._', '',
      '# OPEN', '',
    ];
    out = out.concat(open.length ? groupMd(open) : ['_Nothing open._', '']);
    if (done.length) out = out.concat(['# DONE', ''], groupMd(done));
    if (filed.length) out = out.concat(['# FILED (done earlier)', ''], groupMd(filed));
    return out.join('\n');
  }

  function groupMd(list) {
    var byApp = {};
    list.forEach(function (n) { (byApp[n.app || '?'] = byApp[n.app || '?'] || []).push(n); });
    var out = [];
    Object.keys(byApp).sort().forEach(function (app) {
      out.push('## ' + app, '');
      byApp[app].sort(function (a, b) { return (b.n || 0) - (a.n || 0); }).forEach(function (n) {
        out.push('### ' + (n.status === 'done' ? '✅ DONE · ' : '') + '#' + n.n + ' · ' + n.kind + ' · `' + n.route + '`' + (n.title ? ' · ' + n.title : ''), '', (n.text || '').trim(), '');
        if (n.status === 'done') out.push('- **Done** by ' + (n.done_by || '?') + ' on ' + String(n.done_at || '').slice(0, 16).replace('T', ' ') + ': ' + (n.action || '(no detail given)'));
        if (n.element) out.push('- **Element:** ' + n.element);
        if (n.selector) out.push('- **Selector:** `' + n.selector + '`');
        if (n.target_kind === 'area' && n.rect) out.push('- **Region:** ' + n.rect.w + '×' + n.rect.h + ' at (' + n.rect.x + ', ' + n.rect.y + '), viewport ' + n.viewport);
        out.push('- **URL:** ' + n.url);
        (n.links || []).forEach(function (l) { out.push('- **Reference link (make it like this):** ' + l); });
        (n.images || []).forEach(function (im) {
          out.push('- **' + (im.role === 'marked' ? 'Screenshot of what I marked' : 'Reference image (make it like this)') + ':** `' + im.file + '` (' + im.name + ')');
        });
        out.push('');
      });
    });
    return out;
  }

  function bytesOf(dataUrl) {
    var bin = atob(dataUrl.split(',')[1] || '');
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  var CRC_TABLE = (function () {
    var t = [], c;
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var crc = -1;
    for (var i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  // A "stored" (uncompressed) zip: local header + data per file, then the
  // central directory, then the end record. Date fields are 1 Jan 1980.
  function zip(files) {
    var parts = [], central = [], offset = 0, enc = new TextEncoder();
    files.forEach(function (f) {
      var name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.bytes);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, name.length, true);
      cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + size;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  function download(blob, name) {
    if (VIA_EXTENSION) {
      // Chrome blocks downloads started inside an embedded frame, so the
      // extension's background worker saves the file instead.
      var reader = new FileReader();
      reader.onload = function () {
        chrome.runtime.sendMessage({ type: 'download', name: name, dataUrl: reader.result }, function (res) {
          if (chrome.runtime.lastError || !res || !res.ok) say('Could not save the zip' + (res && res.error ? ': ' + res.error : ''));
        });
      };
      reader.readAsDataURL(blob);
      return;
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 10000);
  }

  /* ---------- mode switching ---------- */
  function setMode(m) {
    mode = m;
    closeCard();
    clearHi();
    var on = m !== 'off';
    pill.classList.toggle('on', on);
    bar.style.display = on ? 'flex' : 'none';
    bEl.classList.toggle('sel', m === 'element');
    bArea.classList.toggle('sel', m === 'area');
    document.documentElement.style.cursor = m === 'area' ? 'crosshair' : '';
    host.style.pointerEvents = 'none';
    paintPill();
  }

  pill.onclick = function () { setMode(mode === 'off' ? 'element' : 'off'); };
  bEl.onclick = function () { setMode('element'); };
  bArea.onclick = function () { setMode('area'); };
  bList.onclick = togglePanel;
  bFlip.onclick = function () { wrap.classList.toggle('low'); };
  bOff.onclick = function () { setMode('off'); if (panel) togglePanel(); };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mousemove', onDrag, true);
  document.addEventListener('mouseup', onUp, true);
  window.addEventListener('scroll', function () { if (!card) clearHi(); }, true);

  window.__reviewNotes = { toggle: function () { setMode(mode === 'off' ? 'element' : 'off'); } };

  load();
  // Start disarmed. Arming steals clicks from the app underneath, and an
  // overlay that eats your first click before you have asked it to is the
  // fastest way to make a review tool feel broken.
  setMode('off');
  say('Click “Mark it up”, top right, to start marking');
})();
