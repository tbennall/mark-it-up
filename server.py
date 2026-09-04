#!/usr/bin/env python3
"""Review-notes collector: the "Mark it up" tool's back end.

Serves the overlay script, takes the notes back from any page it is running
on, and writes them to files Claude reads. Standard library only.

    python3 ~/Developer/review-notes/server.py     # http://localhost:8899

Notes land beside this file: notes.jsonl (machine) and notes.md (human).
The overlay itself is extension/notes.js, the one copy the Chrome extension,
the dev-server injection and the bookmarklet all share.
"""

import base64
import json
import os
import re
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
JSONL = os.path.join(HERE, "notes.jsonl")
MARKDOWN = os.path.join(HERE, "notes.md")
SCRIPT = os.path.join(HERE, "extension", "notes.js")
REFS = os.path.join(HERE, "refs")  # reference images, one file per attachment
PORT = int(os.environ.get("REVIEW_NOTES_PORT", "8899"))

LOCK = threading.Lock()

# A note may carry pictures ("make it look like this") and links ("like this
# site"). Pictures arrive from the overlay as data URLs and are written to
# refs/<note id>-<n>.<ext>; the note keeps the file name, never the bytes.
DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$")
REF_FILE = re.compile(r"^[a-z0-9]+-\d+\.(png|jpg|webp|gif)$")
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}
MAX_IMAGES_PER_NOTE = 8


def save_images(note_id, images):
    """Write each data-URL image to refs/ and return what the note should keep."""
    saved = []
    if not isinstance(images, list):
        return saved
    os.makedirs(REFS, exist_ok=True)
    for index, img in enumerate(images[:MAX_IMAGES_PER_NOTE]):
        if not isinstance(img, dict):
            continue
        match = DATA_URL.match(img.get("data") or "")
        if not match:
            continue
        ext = "jpg" if match.group(1) in ("jpeg", "jpg") else match.group(1)
        file_name = f"{note_id}-{index + 1}.{ext}"
        try:
            raw = base64.b64decode(match.group(2), validate=False)
        except (ValueError, base64.binascii.Error):
            continue
        with open(os.path.join(REFS, file_name), "wb") as fh:
            fh.write(raw)
        saved.append({
            "file": f"refs/{file_name}",
            "name": str(img.get("name") or file_name)[:120],
            "role": "marked" if img.get("role") == "marked" else "reference",
            "w": img.get("w"),
            "h": img.get("h"),
        })
    return saved


def clean_links(links):
    """Keep only real http(s) links, de-duplicated, at most 20."""
    out = []
    for link in links if isinstance(links, list) else []:
        if isinstance(link, str) and re.match(r"^https?://\S+$", link) and link not in out:
            out.append(link[:2000])
    return out[:20]


def remove_images(note):
    for img in note.get("images") or []:
        name = os.path.basename(img.get("file", ""))
        if REF_FILE.match(name):
            try:
                os.remove(os.path.join(REFS, name))
            except OSError:
                pass


def read_notes():
    if not os.path.exists(JSONL):
        return []
    out = []
    with open(JSONL, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def write_notes(notes):
    with open(JSONL, "w", encoding="utf-8") as fh:
        for note in notes:
            fh.write(json.dumps(note) + "\n")
    render_markdown(notes)


def render_markdown(notes):
    by_app = {}
    for note in notes:
        by_app.setdefault(note.get("app", "?"), []).append(note)
    lines = [
        "# Tom's mark-up notes",
        "",
        "Written by pointing at running apps and live sites, not by hand. "
        "Newest first inside each app.",
        "",
        "Reference images live in `refs/` beside this file (open them with the "
        "Read tool). A **Reference** is what Tom wants it to look like; a "
        "**Screenshot of what I marked** is how it looks today.",
        "",
        f"_{len(notes)} note(s), last updated {datetime.now().strftime('%d %b %Y %H:%M')}._",
        "",
    ]
    for app in sorted(by_app):
        lines.append(f"## {app}")
        lines.append("")
        for note in sorted(by_app[app], key=lambda n: -n.get("n", 0)):
            lines.append(f"### #{note.get('n')} · {note.get('kind')} · `{note.get('route')}`"
                         + (f" · {note['title']}" if note.get('title') else ""))
            lines.append("")
            lines.append(note.get("text", "").strip())
            lines.append("")
            if note.get("element"):
                lines.append(f"- **Element:** {note['element']}")
            if note.get("selector"):
                lines.append(f"- **Selector:** `{note['selector']}`")
            if note.get("target_kind") == "area":
                rect = note.get("rect") or {}
                lines.append(
                    f"- **Region:** {rect.get('w')}×{rect.get('h')} at "
                    f"({rect.get('x')}, {rect.get('y')}), viewport {note.get('viewport')}"
                )
            lines.append(f"- **URL:** {note.get('url')}")
            for link in note.get("links") or []:
                lines.append(f"- **Reference link (make it like this):** {link}")
            for img in note.get("images") or []:
                what = ("Screenshot of what I marked" if img.get("role") == "marked"
                        else "Reference image (make it like this)")
                lines.append(f"- **{what}:** `{img.get('file')}` ({img.get('name')})")
            lines.append("")
    with open(MARKDOWN, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


BOARD_CSS = """
:root{color-scheme:light dark}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eff1ee;color:#14181a}
@media (prefers-color-scheme:dark){body{background:#0e1113;color:#e6e9e5}
 .card{background:#161a1d!important;border-color:#262c30!important}
 .meta{color:#868f96!important} code{background:#1c2124!important}}
header{padding:26px 22px 10px;max-width:900px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#6b747b;font-size:13px}
main{max-width:900px;margin:0 auto;padding:10px 22px 60px}
.card{background:#fff;border:1px solid #dce0da;border-radius:12px;padding:14px 16px;margin:0 0 10px}
.meta{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#6b747b;
 display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.meta .k{color:#a8382a}
.txt{white-space:pre-wrap;font-size:15px}
code{background:#f2f4f0;padding:1px 5px;border-radius:4px;font-size:12px;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.det{margin-top:8px;font-size:12px;color:#6b747b}
.empty{padding:60px 0;text-align:center;color:#6b747b}
.bm{display:inline-block;background:#14181a;color:#fff;text-decoration:none;font-weight:700;
 padding:7px 15px;border-radius:8px;cursor:grab;margin-left:6px}
.tools{display:flex;gap:8px;margin:12px 0 18px}
button{font:inherit;font-size:13px;font-weight:600;border:1px solid #c2c8bd;background:#fff;color:#14181a;
 border-radius:8px;padding:8px 14px;cursor:pointer}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#6b747b;margin:24px 0 10px}
.refs{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}
.refs a.link{font-size:12px;color:#a8382a;word-break:break-all;align-self:center}
.refs a.thumb{display:block;border:1px solid #dce0da;border-radius:8px;overflow:hidden;background:#f2f4f0}
.refs a.thumb img{display:block;max-height:160px;max-width:260px}
.refs .cap{font-size:10px;color:#6b747b;padding:2px 6px;text-transform:uppercase;letter-spacing:.04em}
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/notes.js":
            with open(SCRIPT, "r", encoding="utf-8") as fh:
                self._send(200, fh.read(), "application/javascript; charset=utf-8")
        elif path == "/notes":
            self._send(200, json.dumps({"notes": list(reversed(read_notes()))}))
        elif path in ("/", "/index.html"):
            self._send(200, self.board(), "text/html; charset=utf-8")
        elif path.startswith("/refs/"):
            name = path[len("/refs/"):]
            full = os.path.join(REFS, name)
            if not REF_FILE.match(name) or not os.path.exists(full):
                self._send(404, json.dumps({"error": "not found"}))
                return
            with open(full, "rb") as fh:
                self._send(200, fh.read(), IMAGE_TYPES[name.rsplit(".", 1)[1]])
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path != "/note":
            self._send(404, json.dumps({"error": "not found"}))
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            note = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, json.dumps({"error": "bad json"}))
            return
        if not isinstance(note, dict):
            self._send(400, json.dumps({"error": "bad json"}))
            return
        images = note.pop("images", None)
        with LOCK:
            notes = read_notes()
            note["id"] = uuid.uuid4().hex[:10]
            note["n"] = (max([n.get("n", 0) for n in notes]) + 1) if notes else 1
            note["links"] = clean_links(note.get("links"))
            note["images"] = save_images(note["id"], images)
            notes.append(note)
            write_notes(notes)
        extras = ""
        if note["links"] or note["images"]:
            extras = f"  [{len(note['links'])} link(s), {len(note['images'])} image(s)]"
        print(f"  note #{note['n']}  {note.get('app')}  {note.get('kind')}: "
              f"{note.get('text', '')[:70]}{extras}")
        self._send(200, json.dumps({"ok": True, "note": note}))

    def do_DELETE(self):
        if self.path == "/notes":
            with LOCK:
                for note in read_notes():
                    remove_images(note)
                write_notes([])
            self._send(200, json.dumps({"ok": True}))
            return
        match = re.match(r"^/note/([a-z0-9]+)$", self.path)
        if not match:
            self._send(404, json.dumps({"error": "not found"}))
            return
        with LOCK:
            keep = []
            for note in read_notes():
                if note.get("id") == match.group(1):
                    remove_images(note)
                else:
                    keep.append(note)
            write_notes(keep)
        self._send(200, json.dumps({"ok": True}))

    def board(self):
        notes = read_notes()
        by_app = {}
        for note in notes:
            by_app.setdefault(note.get("app", "?"), []).append(note)
        parts = [
            "<!doctype html><meta charset=utf-8>",
            "<meta name=viewport content='width=device-width,initial-scale=1'>",
            "<title>Walkthrough notes</title>",
            f"<style>{BOARD_CSS}</style>",
            "<header><h1>Walkthrough notes</h1>",
            f"<div class=sub>{len(notes)} note(s). Everything you marked while "
            "clicking around, newest first. This page refreshes itself.</div></header><main>",
            "<div class=tools><button onclick='location.reload()'>Refresh</button>"
            "<button onclick=\"navigator.clipboard.writeText(document.body.innerText)\">"
            "Copy all</button>"
            "<button onclick=\"if(confirm('Delete every note?'))fetch('/notes',{method:'DELETE'})"
            ".then(()=>location.reload())\">Clear all</button></div>",
            "<div class=card style='border-style:dashed'>"
            "<b>On any site:</b> click the Mark it up button in Chrome's toolbar "
            "(the extension in <code>~/Developer/review-notes/extension</code>), "
            "or press <code>Alt+Shift+N</code>. On a local Map My Turf dev server the "
            "pill is already there. Press <code>N</code> to start and stop marking."
            "<div class=det>No extension handy? Drag this to the bookmarks bar instead: "
            "<a class=bm href=\"javascript:(function()%7Bvar%20s=document.createElement('script');"
            "s.src='http://localhost:8899/notes.js?'+Date.now();document.body.appendChild(s);%7D)();\">"
            "Mark it up</a> (some live sites block it; the extension never is).</div></div>",
        ]
        if not notes:
            parts.append("<div class=empty>Nothing marked yet.</div>")
        for app in sorted(by_app):
            parts.append(f"<h2>{esc(app)}</h2>")
            for note in sorted(by_app[app], key=lambda n: -n.get("n", 0)):
                parts.append("<div class=card><div class=meta>")
                parts.append(f"<span class=k>#{note.get('n')} · {esc(note.get('kind', ''))}</span>")
                parts.append(f"<span>{esc(note.get('route', ''))}</span>")
                parts.append(f"<span>{esc((note.get('at') or '')[:16].replace('T', ' '))}</span>")
                parts.append("</div>")
                parts.append(f"<div class=txt>{esc(note.get('text', ''))}</div>")
                det = []
                if note.get("element"):
                    det.append(f"{esc(note['element'])}")
                if note.get("selector"):
                    det.append(f"<code>{esc(note['selector'])}</code>")
                if det:
                    parts.append(f"<div class=det>{'<br>'.join(det)}</div>")
                refs = []
                for link in note.get("links") or []:
                    refs.append(f"<a class=link href=\"{esc(link)}\" target=_blank rel=noopener>"
                                f"\U0001f517 {esc(link)}</a>")
                for img in note.get("images") or []:
                    cap = "what I marked" if img.get("role") == "marked" else "make it like this"
                    refs.append(f"<a class=thumb href=\"/{esc(img.get('file'))}\" target=_blank>"
                                f"<img src=\"/{esc(img.get('file'))}\" alt=\"{esc(img.get('name'))}\">"
                                f"<div class=cap>{cap}</div></a>")
                if refs:
                    parts.append(f"<div class=refs>{''.join(refs)}</div>")
                parts.append("</div>")
        parts.append("</main><script>setTimeout(()=>location.reload(),15000)</script>")
        return "".join(parts)


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


if __name__ == "__main__":
    if os.path.exists(JSONL):
        render_markdown(read_notes())
    print(f"Review notes on http://localhost:{PORT}  ·  notes → {JSONL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
