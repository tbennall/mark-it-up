# Mark it up

Point at anything on any page, say what is wrong with it, and the note lands
in a file Claude reads. Works on a local dev server and on a live site alike.

## Get it

You need Python 3 (already on every Mac) and Google Chrome. Nothing to install.

```bash
git clone https://github.com/tbennall/mark-it-up.git ~/Developer/review-notes
```

Any folder works; the commands below assume that one.

## One-time setup (about a minute)

1. Start the notes server and leave it running:

   ```bash
   python3 ~/Developer/review-notes/server.py
   ```

2. In Chrome, open `chrome://extensions`, switch on **Developer mode** (top
   right), click **Load unpacked**, and choose the folder
   `~/Developer/review-notes/extension`.

3. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next
   to **Mark it up**.

## Every day

- On any tab, click the orange **Mark it up** button in the toolbar, or press
  **Alt+Shift+N**. A pill appears top right and marking is on.
- Hover highlights whatever is under the mouse. Click it, pick a type (Fix
  this, Redesign, Idea, Question, Broken), type your note, save.
- `[` widens the selection to the box around it, `]` narrows it back.
  "Drag a box" marks a whole region instead of one thing.
- **Show me what you mean.** Every note card has a "Show me what you mean"
  section. Three ways to use it:
  - **Paste a screenshot.** On a Mac, `Cmd+Ctrl+Shift+4` copies a bit of the
    screen to the clipboard; then `Cmd+V` in the note drops it in.
  - **Add image** opens a file picker, or drag a picture from Finder onto the card.
  - **Add link** takes a web address of a site you want it to look like. Any
    address typed into the note text is picked up as a link too.
  - **Snap what I marked** (toggle, remembers itself) also attaches a picture
    of the thing you pointed at, so the "before" travels with the note.
- Press **N** (or the pill) to stop marking and use the page normally.
- Read your notes at http://localhost:8899, or tell Claude
  "work through my mark-up notes" and it reads `notes.md` here.

Local Map My Turf dev servers (ports 5187, 5188, 5287) put the pill on the
page by themselves when started with `TURF_REVIEW_NOTES=1`, so the button is
only needed for everything else.

## When something gets done

Every note is open until someone marks it done. Then it drops to the bottom of
`notes.md` with a line saying who did it, when, and what they did.

- **Claude** marks a note done from the terminal after fixing it:

  ```bash
  python3 ~/Developer/review-notes/server.py done 7 "Moved the logo to the back, deployed to sandbox"
  ```

- **You** can do the same on the board (a "Mark done" button on every card,
  with an optional "what was done" box) or from the in-page "My notes" list.
  "Reopen" puts it back.
- **File away** on the board (or `server.py file`) moves every done note out
  of the working list into `filed.md`, a read-only history of what was asked
  and what was done. Note numbers never repeat, so "#7" always means one thing.
- `server.py list` prints what is open and done, one line each.

## What is in here

- `server.py`: the collector. Standard library only, port 8899.
- `extension/notes.js`: the overlay. The one copy everything uses.
- `extension/manifest.json`, `background.js`: the Chrome extension.
- `notes.jsonl`, `notes.md`: your notes, machine and human form.
- `refs/`: the pictures attached to notes, named `<note id>-<n>.png`.
- `filed.jsonl`, `filed.md`: done notes that have been filed away.

## If the pill does not appear

- Is the server running? The pill still appears without it, but saving says
  "Notes server is not running" and keeps the note in that browser only.
- Chrome's own pages (`chrome://...`) cannot be marked. Everything else can.
- After editing `notes.js`, press the reload arrow on the extension's card in
  `chrome://extensions` so Chrome picks up the new file.
