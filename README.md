# Mark it up

Point at anything on any web page, say what is wrong with it, and hand the
notes to Claude. A Chrome extension. Nothing else to install.

You click a thing on the page, pick a type (Fix this, Redesign, Idea,
Question, Broken), write a sentence, and optionally attach a screenshot or a
link of what it *should* look like. When you are done, one button gives you a
zip with a `notes.md` file and the pictures. Drop those into a Claude chat and
say "work through my mark-up notes". Claude gets the exact element, the page
it was on, your words, and your pictures.

## Install (about two minutes, no technical knowledge needed)

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Find the zip in your Downloads folder and double-click it. You get a
   folder called `mark-it-up-main`. Move that folder somewhere it can stay,
   like Documents. (If you delete it later, the extension stops working.)
3. In Chrome, type `chrome://extensions` into the address bar and press
   Enter.
4. Top right of that page, switch on **Developer mode**.
5. Click **Load unpacked** (top left). In the file picker, open the folder
   from step 2, then open the `extension` folder inside it, and click
   **Select**.
6. Click the puzzle-piece icon in Chrome's toolbar, then the pin next to
   **Mark it up**, so its button is always visible.

That is it. If Chrome ever says "Developer mode extensions" when it starts,
click Keep.

## Using it

- Open the page you want to comment on. Click the **Mark it up** button in
  the toolbar (or press **Alt+Shift+N**). A pill appears top right and a
  small toolbar appears at the top of the page.
- Move the mouse: whatever is under it lights up. Click it. A card appears.
- Pick a type, write what is wrong or what it should become, and press
  **Save note** (or Cmd+Enter).
- Under the words, the card has **Show me what you mean**:
  - **Paste a screenshot.** On a Mac, `Cmd+Ctrl+Shift+4` copies a bit of the
    screen; then `Cmd+V` inside the note drops it in. Or click **Add image**,
    or drag a picture from Finder onto the card.
  - **Add link.** A web address of a site you want it to look like. Any
    address you type into the note itself is picked up too.
  - **Snap what I marked.** A toggle that also attaches a picture of the thing
    you pointed at, so the "before" travels with the note.
- `[` widens the selection to the box around the thing, `]` narrows it back.
  **Drag a box** on the toolbar marks a whole region instead of one thing.
- Press **N** (or the pill) to stop marking and use the page normally.
- **My notes** on the toolbar lists everything you have marked, with a
  **Done** button on each (and **Reopen** if you change your mind).

It works on ordinary websites and inside embedded pages, so you can mark
things inside a Claude artefact too.

## Getting your notes to Claude

Open **My notes** and click **Export zip**. A file called
`mark-it-up-notes.zip` lands in Downloads. Double-click it to unzip, then
drag the `notes.md` file and the pictures in the `refs` folder into your
Claude chat. Tell Claude what you want done with them.

**Copy notes** puts the text on the clipboard instead, for a quick paste
without pictures.

Your notes stay inside your own Chrome until you export them. They are not
sent anywhere.

## For people who use Claude Code (optional)

If you run Claude Code on a Mac, there is a small server that writes the
notes straight to files that Claude reads, so there is nothing to export.
It also gives you a web page listing everything, with Mark done and File
away buttons. Start it and leave it running:

```bash
python3 ~/path/to/mark-it-up/server.py
```

- Notes land in `notes.md` and `notes.jsonl` next to `server.py`, pictures
  in `refs/`. The board is at http://localhost:8899.
- Tell Claude "work through my mark-up notes". When Claude has fixed one it
  marks the note done:

  ```bash
  python3 server.py done 7 "Moved the logo to the back, deployed to sandbox"
  ```

  Done notes drop to the bottom of `notes.md`. **File away** on the board (or
  `python3 server.py file`) moves them into `filed.md`, a read-only history.
  `python3 server.py list` shows what is open, one line each.
- The extension notices the server on its own. With it running, notes go to
  the files; without it, they stay in the extension and you export them.

## What is in here

- `extension/`: the Chrome extension. `notes.js` is the overlay,
  `background.js` keeps the notes.
- `server.py`: the optional notes server for Claude Code users. Standard
  library only, port 8899.

Your own notes never go into this repository: `notes.*`, `filed.*`, `refs/`
are ignored by git.

## If something is off

- **No pill appears:** Chrome's own pages (`chrome://...`) cannot be marked.
  Everything else can. Try the toolbar button again.
- **"Snap what I marked" complains:** click the toolbar button once on that
  tab, then try again. Chrome only allows the snapshot after you have clicked.
- **After editing `notes.js`** (developers only): press the reload arrow on
  the extension's card in `chrome://extensions`.
