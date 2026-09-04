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
FILED_JSONL = os.path.join(HERE, "filed.jsonl")  # done notes, moved out of the way
FILED_MARKDOWN = os.path.join(HERE, "filed.md")
PORT = int(os.environ.get("REVIEW_NOTES_PORT", "8899"))

LOCK = threading.Lock()

# Every note is "open" until someone marks it "done". Done notes carry who did
# it, when, and a one-line "what was done". "Filing" moves done notes from
# notes.jsonl into filed.jsonl so the working list only shows what is left.


def is_done(note):
    return note.get("status") == "done"


def find_note(notes, key):
    """A note by its id, or by its number ("7" or "#7")."""
    key = str(key).strip().lstrip("#")
    for note in notes:
        if note.get("id") == key:
            return note
    if key.isdigit():
        for note in notes:
            if note.get("n") == int(key):
                return note
    return None


def mark(note, done, action="", by="claude"):
    if done:
        note["status"] = "done"
        note["done_at"] = datetime.now().isoformat(timespec="seconds")
        note["done_by"] = by
        if action:
            note["action"] = str(action)[:2000]
    else:
        note["status"] = "open"
        for key in ("done_at", "done_by"):
            note.pop(key, None)
    return note


def read_filed():
    if not os.path.exists(FILED_JSONL):
        return []
    out = []
    with open(FILED_JSONL, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def next_number(notes):
    """Numbers keep climbing across filing, so #7 never means two things."""
    highest = 0
    for note in notes + read_filed():
        highest = max(highest, note.get("n", 0))
    return highest + 1


def file_done_notes():
    """Move every done note out of the working list. Returns how many moved."""
    notes = read_notes()
    done = [n for n in notes if is_done(n)]
    if not done:
        return 0
    filed = read_filed() + done
    with open(FILED_JSONL, "w", encoding="utf-8") as fh:
        for note in filed:
            fh.write(json.dumps(note) + "\n")
    render_filed_markdown(filed)
    write_notes([n for n in notes if not is_done(n)])
    return len(done)

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


def note_markdown(note):
    tick = "✅ DONE · " if is_done(note) else ""
    lines = [
        f"### {tick}#{note.get('n')} · {note.get('kind')} · `{note.get('route')}`"
        + (f" · {note['title']}" if note.get('title') else ""),
        "",
        note.get("text", "").strip(),
        "",
    ]
    if is_done(note):
        when = (note.get("done_at") or "")[:16].replace("T", " ")
        lines.append(f"- **Done** by {note.get('done_by', '?')} on {when}: "
                     f"{note.get('action') or '(no detail given)'}")
    elif note.get("action"):
        lines.append(f"- **Progress:** {note['action']}")
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
    lines.append(f"- **Mark done:** `python3 ~/Developer/review-notes/server.py done {note.get('n')} \"what you did\"`")
    lines.append("")
    return lines


def grouped_by_app(notes):
    by_app = {}
    for note in notes:
        by_app.setdefault(note.get("app", "?"), []).append(note)
    out = []
    for app in sorted(by_app):
        out.append(f"## {app}")
        out.append("")
        for note in sorted(by_app[app], key=lambda n: -n.get("n", 0)):
            out.extend(note_markdown(note))
    return out


def render_markdown(notes):
    open_notes = [n for n in notes if not is_done(n)]
    done_notes = [n for n in notes if is_done(n)]
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
        "When you have fixed a note, mark it done with the command under it "
        "(say what you did in a sentence). Done notes drop to the bottom; "
        "\"File away\" on the board moves them into `filed.md`.",
        "",
        f"_{len(open_notes)} open, {len(done_notes)} done and not yet filed, "
        f"last updated {datetime.now().strftime('%d %b %Y %H:%M')}._",
        "",
        "# OPEN",
        "",
    ]
    lines.extend(grouped_by_app(open_notes) if open_notes else ["_Nothing open._", ""])
    if done_notes:
        lines.append("# DONE (not yet filed)")
        lines.append("")
        lines.extend(grouped_by_app(done_notes))
    with open(MARKDOWN, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def render_filed_markdown(filed):
    lines = [
        "# Filed mark-up notes",
        "",
        "Notes that were marked done and then filed away from the working list. "
        "Read-only history: what was asked, and what was done about it.",
        "",
        f"_{len(filed)} filed note(s), last updated {datetime.now().strftime('%d %b %Y %H:%M')}._",
        "",
    ]
    lines.extend(grouped_by_app(filed))
    with open(FILED_MARKDOWN, "w", encoding="utf-8") as fh:
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
.card.done{opacity:.62;border-style:dashed}
.card.done .meta .k{color:#2f7d4f}
.done-line{margin-top:8px;font-size:13px;padding:8px 10px;border-radius:8px;background:#e8f3ec;color:#1f5a38}
@media (prefers-color-scheme:dark){.done-line{background:#14261b!important;color:#9fd4b3!important}}
.acts{margin-top:10px;display:flex;gap:6px;align-items:center}
.acts button{font-size:12px;padding:5px 10px}
.acts input{font:inherit;font-size:12px;flex:1;border:1px solid #c2c8bd;border-radius:8px;padding:5px 8px;min-width:0}
.counts{font-size:12px;color:#6b747b;align-self:center;margin-left:auto}
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
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, json.dumps({"error": "bad json"}))
            return
        if not isinstance(body, dict):
            self._send(400, json.dumps({"error": "bad json"}))
            return

        # Mark one note done or open again: POST /note/<id or number>/done
        status = re.match(r"^/note/([A-Za-z0-9#]+)/(done|reopen)$", self.path)
        if status:
            with LOCK:
                notes = read_notes()
                note = find_note(notes, status.group(1))
                if not note:
                    self._send(404, json.dumps({"error": "no such note"}))
                    return
                mark(note, status.group(2) == "done", body.get("action", ""), body.get("by") or "tom")
                write_notes(notes)
            print(f"  note #{note['n']} {'done' if is_done(note) else 'reopened'}: {note.get('action', '')[:70]}")
            self._send(200, json.dumps({"ok": True, "note": note}))
            return

        # Move every done note into filed.jsonl / filed.md.
        if self.path == "/file-done":
            with LOCK:
                moved = file_done_notes()
            print(f"  filed {moved} done note(s)")
            self._send(200, json.dumps({"ok": True, "filed": moved}))
            return

        if self.path != "/note":
            self._send(404, json.dumps({"error": "not found"}))
            return
        note = body
        images = note.pop("images", None)
        with LOCK:
            notes = read_notes()
            note["id"] = uuid.uuid4().hex[:10]
            note["n"] = next_number(notes)
            note["status"] = "open"
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
        open_count = len([n for n in notes if not is_done(n)])
        done_count = len(notes) - open_count
        filed_count = len(read_filed())
        parts = [
            "<!doctype html><meta charset=utf-8>",
            "<meta name=viewport content='width=device-width,initial-scale=1'>",
            "<title>Walkthrough notes</title>",
            f"<style>{BOARD_CSS}</style>",
            "<header><h1>Walkthrough notes</h1>",
            f"<div class=sub>{open_count} open, {done_count} done. Everything you marked while "
            "clicking around, newest first. This page refreshes itself.</div></header><main>",
            "<div class=tools><button onclick='location.reload()'>Refresh</button>"
            "<button onclick=\"navigator.clipboard.writeText(document.body.innerText)\">"
            "Copy all</button>"
            f"<button {'disabled' if not done_count else ''} onclick=\"fetch('/file-done',{{method:'POST',"
            "headers:{'Content-Type':'application/json'},body:'{}'})"
            f".then(()=>location.reload())\">File away {done_count} done</button>"
            "<button onclick=\"if(confirm('Delete every note, open and done?'))fetch('/notes',{method:'DELETE'})"
            ".then(()=>location.reload())\">Clear all</button>"
            f"<span class=counts>{filed_count} filed in <code>filed.md</code></span></div>",
            "<script>"
            "function setDone(id,done){var inp=document.getElementById('act-'+id);"
            "fetch('/note/'+id+'/'+(done?'done':'reopen'),{method:'POST',headers:{'Content-Type':'application/json'},"
            "body:JSON.stringify({by:'tom',action:inp?inp.value:''})}).then(()=>location.reload())}"
            "</script>",
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
        for heading, group in (("Open", [n for n in notes if not is_done(n)]),
                               ("Done, not yet filed", [n for n in notes if is_done(n)])):
            if not group:
                continue
            parts.append(f"<h2 style='font-size:16px;color:inherit'>{heading}</h2>")
            by_app = {}
            for note in group:
                by_app.setdefault(note.get("app", "?"), []).append(note)
            for app in sorted(by_app):
                parts.append(f"<h2>{esc(app)}</h2>")
                for note in sorted(by_app[app], key=lambda n: -n.get("n", 0)):
                    parts.append(self.card(note))
        parts.append("</main><script>"
                     # Refresh only while nobody is typing a "what I did" line.
                     "setInterval(()=>{if(!document.activeElement||document.activeElement.tagName!=='INPUT')location.reload()},15000)"
                     "</script>")
        return "".join(parts)

    def card(self, note):
        done = is_done(note)
        parts = [f"<div class='card{' done' if done else ''}'><div class=meta>"]
        parts.append(f"<span class=k>{'✅ ' if done else ''}#{note.get('n')} · {esc(note.get('kind', ''))}</span>")
        parts.append(f"<span>{esc(note.get('route', ''))}</span>")
        parts.append(f"<span>{esc((note.get('at') or '')[:16].replace('T', ' '))}</span>")
        parts.append("</div>")
        parts.append(f"<div class=txt>{esc(note.get('text', ''))}</div>")
        if done:
            when = (note.get("done_at") or "")[:16].replace("T", " ")
            parts.append(f"<div class=done-line><b>Done</b> by {esc(note.get('done_by', '?'))} on {esc(when)}: "
                         f"{esc(note.get('action') or 'no detail given')}</div>")
        elif note.get("action"):
            parts.append(f"<div class=done-line><b>Progress:</b> {esc(note['action'])}</div>")
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
        nid = esc(note.get("id", ""))
        if done:
            parts.append(f"<div class=acts><button onclick=\"setDone('{nid}',false)\">Reopen</button></div>")
        else:
            parts.append(f"<div class=acts><input id='act-{nid}' placeholder='What was done (optional)'>"
                         f"<button onclick=\"setDone('{nid}',true)\">Mark done</button></div>")
        parts.append("</div>")
        return "".join(parts)


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def cli(argv):
    """Mark notes done from a terminal (this is how Claude does it).

        server.py done 7 "Moved the logo to the back, deployed to sandbox"
        server.py reopen 7
        server.py file          # move every done note into filed.md
        server.py list          # what is open

    Goes through the running server when there is one, so nothing races the
    overlay; falls back to the files when the server is down.
    """
    import urllib.request
    import urllib.error

    def via_server(path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            return json.load(urllib.request.urlopen(req, timeout=3))
        except urllib.error.HTTPError as err:
            return {"ok": False, "error": err.read().decode(errors="replace")}
        except (urllib.error.URLError, OSError):
            return None  # server not running

    cmd = argv[0]
    if cmd == "list":
        for note in read_notes():
            flag = "done" if is_done(note) else "open"
            print(f"#{note.get('n'):<4} {flag:<5} {note.get('app', ''):<28} {note.get('kind', ''):<9} {note.get('text', '')[:80]}")
        return 0
    if cmd in ("done", "reopen"):
        if len(argv) < 2:
            print(f"usage: server.py {cmd} <note number or id> [what was done]")
            return 2
        action = " ".join(argv[2:])
        res = via_server(f"/note/{argv[1].lstrip('#')}/{cmd}", {"action": action, "by": "claude"})
        if res is None:
            notes = read_notes()
            note = find_note(notes, argv[1])
            if not note:
                print("no such note")
                return 1
            mark(note, cmd == "done", action, "claude")
            write_notes(notes)
            res = {"ok": True, "note": note}
        if not res.get("ok"):
            print(res.get("error", "failed"))
            return 1
        note = res["note"]
        print(f"#{note['n']} {'done' if is_done(note) else 'reopened'}: {note.get('text', '')[:60]}")
        return 0
    if cmd == "file":
        res = via_server("/file-done", {})
        moved = res["filed"] if res else file_done_notes()
        print(f"filed {moved} done note(s) into {FILED_MARKDOWN}")
        return 0
    print(__doc__)
    print(cli.__doc__)
    return 2


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))
    if os.path.exists(JSONL):
        render_markdown(read_notes())
    if os.path.exists(FILED_JSONL):
        render_filed_markdown(read_filed())
    print(f"Review notes on http://localhost:{PORT}  ·  notes → {JSONL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
