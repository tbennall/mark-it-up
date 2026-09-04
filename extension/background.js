// Mark it up: the toolbar button.
//
// One click puts the overlay on the current tab. A second click on the same
// tab toggles marking on and off (the overlay handles that itself: running the
// script again when it is already there calls its toggle).
//
// The script runs in the extension's isolated world, not the page's. That is
// deliberate: a live site's Content Security Policy cannot block it, and the
// fetch to the notes server on localhost is governed by this extension's own
// host permission rather than the site's connect-src rule. Everything the
// overlay needs (the DOM, elementFromPoint, a shadow root) exists there.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['notes.js'],
    });
  } catch (err) {
    console.warn('Mark it up could not load on this tab', err);
  }
});

// The overlay's requests to the notes server come through here, so they run
// under this extension's permissions rather than the page's.
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

  if (msg.type !== 'notes') return false;
  fetch(SERVER + msg.path, {
    method: msg.method,
    headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
    body: msg.body ? JSON.stringify(msg.body) : undefined,
  })
    .then(async (r) => reply({ ok: r.ok, data: await r.json().catch(() => ({})), error: r.ok ? '' : 'HTTP ' + r.status }))
    .catch((err) => reply({ ok: false, error: 'Notes server is not running (' + err.message + ')' }));
  return true; // reply arrives asynchronously
});
