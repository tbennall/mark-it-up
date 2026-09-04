// Mark it up: the toolbar button and the place notes are kept.
//
// One click puts the overlay on the current tab (and on every frame in it,
// so things inside an embedded page, such as a Claude artefact, can be
// marked too). A second click on the same tab toggles marking on and off:
// running the script again when it is already there calls its toggle.
//
// The script runs in the extension's isolated world, not the page's. That is
// deliberate: a live site's Content Security Policy cannot block it, and
// everything the overlay needs (the DOM, elementFromPoint, a shadow root)
// exists there.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['notes.js'],
    });
  } catch (err) {
    console.warn('Mark it up could not load on this tab', err);
  }
});

// ---------------------------------------------------------------------------
// Where notes live.
//
// Two homes, same shape of data:
//   1. The notes server (server.py on localhost:8899), for people who run
//      Claude Code and want notes to land in a file on disk.
//   2. The extension's own storage, for everyone else. Nothing to install or
//      keep running; notes stay inside Chrome until you export them.
//
// Every request from the overlay comes through here. If the server answers,
// it wins. If it is not running, the built-in store handles the same request.
// ---------------------------------------------------------------------------
const SERVER = 'http://localhost:8899';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return false;

  // "Snap what I marked": a picture of the visible tab, which the overlay then
  // crops to the marked element. activeTab (granted by the toolbar click or
  // the shortcut) is what allows this; it lasts until the tab navigates.
  if (msg.type === 'capture') {
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then((dataUrl) => reply({ ok: true, data: dataUrl }))
      .catch((err) => reply({ ok: false, error: 'Could not snap the page (' + err.message + '). Click the Mark it up toolbar button once, then try again.' }));
    return true;
  }

  // "Export zip": the overlay hands over the finished file and Chrome's own
  // download system saves it. Done here rather than in the page because a
  // download started inside an embedded frame (a Claude artefact, say) is
  // blocked by the browser, while one started by the extension is not.
  if (msg.type === 'download') {
    chrome.downloads.download({ url: msg.dataUrl, filename: msg.name, conflictAction: 'uniquify', saveAs: false })
      .then((id) => reply({ ok: true, data: { id } }))
      .catch((err) => reply({ ok: false, error: 'Could not save the file (' + err.message + ')' }));
    return true;
  }

  if (msg.type !== 'notes') return false;
  viaServer(msg)
    .then((res) => reply(res))
    .catch(() => localStore(msg).then((res) => reply(res)))
    .catch((err) => reply({ ok: false, error: err.message || 'failed' }));
  return true; // reply arrives asynchronously
});

// Rejects only when the server cannot be reached at all. An HTTP error (say
// a 404 for a note that is gone) is still an answer from the server.
async function viaServer(msg) {
  const r = await fetch(SERVER + msg.path, {
    method: msg.method,
    headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
    body: msg.body ? JSON.stringify(msg.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data, store: 'server', error: r.ok ? '' : 'HTTP ' + r.status };
}

// ---------------------------------------------------------------------------
// The built-in store. Same routes as server.py, kept in chrome.storage.local.
//   notes: open and done notes, oldest first     filed: done notes filed away
//   seq:   the last note number handed out (never reused, even after filing)
// ---------------------------------------------------------------------------
async function localStore(msg) {
  const { method, path, body } = msg;
  const state = await chrome.storage.local.get({ notes: [], filed: [], seq: 0 });
  const save = () => chrome.storage.local.set(state);
  const done = (data) => ({ ok: true, data, store: 'local', error: '' });
  const fail = (error) => ({ ok: false, data: {}, store: 'local', error });
  const find = (key) => state.notes.find((n) => n.id === key || String(n.n) === String(key).replace(/^#/, ''));

  if (method === 'GET' && path === '/notes') return done({ notes: state.notes.slice().reverse() });
  if (method === 'GET' && path === '/filed') return done({ notes: state.filed.slice().reverse() });

  if (method === 'POST' && path === '/note') {
    const note = Object.assign({}, body || {});
    note.id = randomId();
    note.n = ++state.seq;
    note.status = 'open';
    note.links = (note.links || []).filter((l) => typeof l === 'string' && /^https?:\/\//.test(l)).slice(0, 20);
    // Images keep their (already shrunk) data URLs; there is no disk here.
    note.images = (note.images || []).filter((im) => im && typeof im.data === 'string' && /^data:image\//.test(im.data)).slice(0, 8)
      .map((im, i) => ({ name: im.name || 'image', role: im.role === 'marked' ? 'marked' : 'reference', w: im.w, h: im.h, data: im.data,
        file: 'refs/' + note.id + '-' + (i + 1) + (/^data:image\/jpeg/.test(im.data) ? '.jpg' : '.png') }));
    state.notes.push(note);
    await save();
    return done({ ok: true, note });
  }

  let m = path.match(/^\/note\/([A-Za-z0-9#]+)\/(done|reopen)$/);
  if (method === 'POST' && m) {
    const note = find(m[1]);
    if (!note) return fail('no such note');
    if (m[2] === 'done') {
      note.status = 'done';
      note.done_at = localStamp();
      note.done_by = (body && body.by) || 'me';
      if (body && body.action) note.action = String(body.action).slice(0, 2000);
    } else {
      note.status = 'open';
      delete note.done_at; delete note.done_by;
    }
    await save();
    return done({ ok: true, note });
  }

  if (method === 'POST' && path === '/file-done') {
    const moving = state.notes.filter((n) => n.status === 'done');
    state.filed = state.filed.concat(moving);
    state.notes = state.notes.filter((n) => n.status !== 'done');
    await save();
    return done({ ok: true, filed: moving.length });
  }

  if (method === 'DELETE' && path === '/notes') {
    state.notes = [];
    await save();
    return done({ ok: true });
  }

  m = path.match(/^\/note\/([A-Za-z0-9]+)$/);
  if (method === 'DELETE' && m) {
    state.notes = state.notes.filter((n) => n.id !== m[1]);
    await save();
    return done({ ok: true });
  }

  return fail('not found');
}

// "2026-09-04T19:30:16" in the person's own clock, matching what server.py writes.
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
