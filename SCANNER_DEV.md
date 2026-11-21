# Scanner — development notes

**Status (2026-11-20):** prototype page with a trained detector and a fine-tuned recognizer: 98 % of cards named right on the 19 test photos (41 % at the start). A labelling mode makes real training and test data. See "0. Current state and next steps" just below.
**Feature:** you upload one or more photos, and Tithies finds every Magic card in them. It returns a list of the detected cards, each with its position in the photo (so the page can draw an outline around it), the card and its print. You correct the list, then add it to the Moxfield collection or a binder. This is the "Scanner cards" item of `todo-future.txt`.
**Out of scope:** telling foil from non-foil in a photo. Finish defaults to non-foil and you change it per row.

---

## 0. Current state and next steps (2026-11-20)

**Built** (hidden page `dashboard.html#/collection/scanner`, on master, not pushed):
- **Engines:** OpenCV.js 4.12 and onnxruntime-web 1.31.1, WebGPU, in a sandboxed iframe.
- **Detection:** the trained detector (`card-detector.onnx`, threshold 0.2), plus the classic passes.
- **Recognition:**
  - the fine-tuned DINOv2-small (`card-recognizer.onnx`), or DINOv2 as downloaded; padded · CLS;
  - each model has its own reference set: the owned prints, back faces included.
  - Both model files are dropped on the photos box and kept in Cache Storage.
- **Labelling mode** (View: Labels) and `labels.json` format 2 (see "Labelling mode" in section 6).
- **Training kit `scanner-train/`:**
  - detector: `synth.py`, `train.py`, `export.py`;
  - recognizer: `crops.py`, `train_recog.py`, `export_recog.py`;
  - training runs on a separate Windows PC (RTX 4070), see "Working method" below.

**Scores on the 19 test photos** (107 cards):
- names 98 % (105 / 107), prints 96 % (100 / 104);
- every card found was named right; 2 cards were not found;
- 12–13 extra shapes, low scores, shown orange.
- Details under Phase 4.

**Batch 2** (51 more photos in `scanner-samples/batch2/`, 2026-11-20, not labelled yet): 461 shapes found, 368 green (80 %).
- **Works well:** table spreads (small cards too), white table in sun, carpet, blanket, bed, binder close-ups, the storage tray.
- **Struggles:**

| Kind of photo | Files (`PXL_20261120_…`) | Scan |
|---|---|---|
| Binder pages from further away | `201024215`, `201030477` | 1 card found on a full page; 9 on two pages |
| Fanned hands | `200435284`, `200441842`, `200608106`, `200935920`, `201733355`, `201744369`, `201749336` | mostly orange; the far fan has nothing green and a 3,144 px shape |
| Offset stacks held in hand | `201327370`, `201539832`, `202017871`, `202028053` | few cards found |
| Sleeved cards at an angle | `200313518` | 9 of 13 orange |
| Piles among bags, or stacked on a blanket | `202115291`, `201411141`, `201414718` | few found, mostly orange |

- 36 photos of empty surfaces are in `scanner-samples/backgrounds/`, for the generator.

**Labelled (2026-11-20):** all 70 photos, 619 cards with checked corners (`scanner-samples/labels.json`).
- **Split:** `split.json` holds 33 test photos (the first 19 plus 1 in 4 of batch 2 by hash; 199 scored cards) and 37 training photos (312 scored cards). Photos in a subfolder named `test…` are always test photos.
- **Shared prints:** the same decks appear in several photos, so test and training photos share prints. `eval.py` also reports the test prints that appear in no training photo.

**Measured offline** (`scanner-train/eval.py`, the page's pipeline: detector decode, warp both ways, recognizer):
- **Test photos, current models, against the owned collection** (3,897 pictures, `owned-prints.json` read from the page's reference set):
  - 98.5 % found (196 / 199), 23 extra shapes (16 with the cleanup), corners off by 1.9 % of the card height;
  - 96 % of names right (191 / 199), 94.5 % of prints right (188 / 199).
  - A small gallery (607 pictures) gave the same names and 96 % prints: the collection's similar reprints cost 3 prints.
- **Training photos** (not trained on yet): 91.7 % found. The misses are concentrated in the batch-2 weak spots, e.g. 0 / 7 on the far binder page `201024215`.
- **Wrong names on found cards** score 0.45–0.53, so they show orange.

**Built since:**
- **Cleanup on the page** (`cleanup.ts`, "Drop bad shapes", default on): it drops an outline around two better-named neighbours, or a second outline of one card. Test photos: 23 → 16 extra shapes, no card lost.
- **Generated scenes** for the weak spots: tight rows, offset stacks in hand, far binder pages, narrow fans, wrappers and bags.
- **Real photos in training:** `train.py --init --real` (25 % of batches) and `train_recog.py --init --real` (20 % real cut-outs). The real test photos are measured each epoch for information only.
- README section 8 has the commands for the 4070 PC.

**Next:** the user runs README section 8 on the 4070 (`fetch_real.py`, baseline `eval.py`, both fine-tunes, exports, `eval.py` again). Then the new models are loaded on the page and the test photos rescanned. The first plan, for reference:
1. **Test / training split:** the first 19 photos plus 1 in 4 of the others, chosen from a hash of the file name, so it never changes. Test photos never go into training.
2. **`scanner-train/eval.py`:**
   - it runs the exported detector and recognizer on the labelled test photos and gives the page's numbers: found (IoU ≥ 0.5), extra shapes, name and print right;
   - recognizer gallery: the labelled prints plus distractors from `data/cards`;
   - images read with EXIF orientation, like the labels.
3. **Real photos in training:**
   - detector: fine-tune from the current `best.pt` on labelled training photos mixed with generated scenes;
   - recognizer: real cut-outs (warped along the label corners) paired with their clean Scryfall pictures, downloaded by `scryfallId`.
4. **Generated scenes for the failures above:** fans where only narrow strips show, offset stacks held in hand, binder pages from a distance (small pockets), piles, and tightly touching cards (the shapes that span two cards).
5. **Cleanup without training:**
   - drop a shape that contains two cards named better;
   - of two overlapping outlines named the same print, keep the better one.
6. **Face-down and unreadable cards in the labels:** while labelling, a card lying face down is named `Card back`, and a visible card nobody can identify `Unknown card` (no set or number, never a guess). Both are ticked "Mostly hidden", so the current scoring neither misses nor counts them.
   - The training code must still treat it as a card **for the detector**: it is fully visible, unlike a covered card.
   - It must skip it for recognition.
   - A proper "face down" field in the labelling mode would be cleaner.

Later: phase 1 (every print), phase 2 (the real page and Moxfield export), phase 3 (bottom line, for same-art reprints).

**Working method:**
- **Training happens on the user's Windows PC** (RTX 4070, 12 GB). Scripts go there as a zip built from the commit (`git archive --format=zip HEAD scanner-train`), copied to the user's Windows home; nothing is pushed for it.
- **Results come back:** the user copies `*.onnx`, `*.json` and logs into `scanner-train/` (gitignored; the recognition log is `log-recog.txt`).
- **Local checks:** a CPU venv at `~/.venvs/scanner-train` for short runs. Data loaders use `spawn`, because forked workers hang on Linux.
- **Photos:** `scanner-samples/` is gitignored.

---

## 1. Feasibility in short

It is feasible fully inside the extension, with no server. Finding the cards and naming them is solid. The exact print is the hard part.

| | What to expect |
|---|---|
| Outlines (coordinates) | Reliable when cards lie apart. Touching cards and binder pages may need the trained detector (phase 4). |
| Card name | Very likely right on decent photos, non-English cards included (same art). To be measured on real photos in phase 0. |
| Exact print | Partial. Good when the art differs between prints, or when the bottom line is readable (phase 3). Same-art reprints and old cards need the user to pick. |
| Language | Read from the bottom line when it's readable (phase 3), otherwise English, and the user can change it. |
| Foil | Not detected. Default non-foil; set automatically for prints that only exist in foil or etched. |

---

## 2. How it works (pipeline)

1. **Find the cards.** Each card's outline comes back as 4 corners plus a bounding box, in the photo's own pixels (after phone orientation is applied). The page draws them as an SVG overlay sized to the photo, so tilted or rotated cards still get a tight outline.
   - **Shape detection** (phase 0): edges and contours, keeping 4-sided shapes with a card's proportions (63×88 mm, ≈ 0.716) and a plausible size, allowing for tilt. Nested outlines (a sleeve around its card) are dropped. Good for cards spread apart on a plain table. Weak on touching cards, binder pages, busy backgrounds and glare.
   - **Trained detector** (phase 4, only if needed): a small model that outputs each card's 4 corners, trained on fake photos made from Scryfall images.
2. **Flatten** each card into a straight 488×680 picture using its 4 corners (a homography). Also try it upside down and keep whichever matches better.
3. **Identify by image similarity.** A small model turns each flattened card into a vector of numbers. That vector is compared with a reference index of every Scryfall print: about 100k prints at about 128 bytes each, ≈ 15–25 MB, built offline, hosted outside the extension and cached in IndexedDB. A brute-force search over the whole index takes a few tens of milliseconds in a Web Worker.
4. **Pick the print.** The art gives the card and usually the variant (borderless, showcase, extended art, old or new frame). Same-art reprints (Sol Ring, basic lands, Commander reprints) differ only by the set symbol and the bottom-left line, so:
   - read that line with OCR on cards printed since 2014 (phase 3);
   - optionally narrow the candidates to prints the user owns;
   - otherwise show a "pick the print" choice, like Selling's red "needs review" dot.
5. **Output for each card:** corners, box, top candidates with scores, confidence, and what OCR read (once phase 3 exists).
6. **Export.** Rows become export items and go through the existing Moxfield export (preview, live read, change log).

### Result shape (sketch, to refine in phase 0)

```ts
type Point = { x: number; y: number };

interface ScanDetection {
  id: string;
  photoId: string;
  /** Card corners in the photo's pixels (orientation applied), clockwise from the card's top-left. */
  corners: [Point, Point, Point, Point];
  /** Axis-aligned box around the corners, for plain rectangles. */
  box: { x: number; y: number; w: number; h: number };
  /** The card was upside down in the photo. */
  rotated180: boolean;
  /** Best matches first. */
  candidates: { scryfallId: string; name: string; set: string; cn: string; score: number }[];
  confidence: 'sure' | 'review' | 'unknown';
  /** What OCR read on the bottom line (phase 3). */
  ocr?: { raw: string; set?: string; cn?: string; lang?: string };
}
```

---

## 3. Approaches considered

| Approach | Verdict |
|---|---|
| **Image vectors (embeddings) vs an index of every print** | **Chosen.** Robust to imperfect crops and lighting, fast, runs locally. |
| Perceptual hash (pHash) of the whole card | Rejected as the main method. The open-source [magic_card_detector](https://github.com/tmikonen/magic_card_detector) uses it (contours + pHash), but its author tested it only on Alpha (≈ 300 cards) and notes it fails when the crop includes too much or too little border. At 100k prints it won't hold. Kept as a baseline to compare against in phase 0. |
| OCR of the card name only | Gives the name but not the print. Card name fonts and small cards in a photo make it unreliable. Fuzzy matching against names would help, but image vectors are better. OCR is kept for the bottom line only (phase 3). |
| Claude vision with the user's own API key | Least code (send the photo, get a list back), good at names in messy photos. But the boxes are only approximate, each photo costs money (a few cents on Opus 5.5, a fraction of a cent on Haiku 5.5, at list prices), photos leave the browser, Tithies would have to store an API key, and the prints it gives need checking against Scryfall. **At most an optional second opinion on low-confidence cards**, not the base. |
| Shape detection vs trained detector | Shape detection first (no training, small). Trained detector only if the phase 0/2 measurements show it's needed. |

---

## 4. Constraints and limitations

**Extension (Manifest V3):**
- No code may be loaded from the internet, so the image-processing engines (OpenCV.js, onnxruntime-web, Tesseract.js) ship inside the extension.
- The model weights and the index are data, so they can be downloaded on first use.
- The extension pages' CSP may need `'wasm-unsafe-eval'`, which MV3 allows.
- Multithreaded WASM needs cross-origin isolation (the manifest's `cross_origin_embedder_policy` / `cross_origin_opener_policy`). Without it, it runs single-threaded and slower.
- WebGPU is used when the browser offers it; WASM otherwise, which is slower.

**Size:**
- The zip is about 0.8 MB today. The engines add about 10–20 MB.
- The model (5–25 MB) and the index (15–25 MB) are a first-use download, not part of the zip.

**Permissions:** `cards.scryfall.io` (reference images) and the index host.

**Scryfall:**
- Building the index downloads about 100k images once (several GB, a few hours at a polite pace).
- Their API docs couldn't be read from the dev machine (HTTP 403), so their image-use and rate rules are **not verified yet**. Check them before phase 1. Send the headers they ask for, with a generic client name.

**Recognition limits:**
- **Same-art reprints:** only the set symbol and the bottom line differ, so they need OCR (phase 3) or the user picks.
- **Old cards:** cards from 2003–2014 have a collector number only, and cards before 1998 have none. OCR helps less, and the user picks more often.
- **Small cards in a big photo** (many cards in one shot): the name is still likely right, but the bottom line is unreadable below about 700 px of card height.
- **Fanned or overlapping cards:** only visible parts can match, so expect misses. The trained detector (phase 4) helps.
- **Glare** through sleeves, toploaders or binder pockets can hide details.
- **Duplicates:** one card photographed twice is counted as two copies; the user adjusts quantities.
- **Language:** the same art across languages means the name matches, but the language comes only from OCR or the user.
- **Foil:** not detected.

**Privacy:** photos never leave the browser. Only Scryfall reference images and the index are downloaded.

---

## 5. Existing code to reuse

| Need | Where |
|---|---|
| Scryfall image URL from a Scryfall id | `src/lib/f2f/links.ts` (`cards.scryfall.io/{size}/front/{a}/{b}/{id}.jpg`) |
| The prints the user owns (phase 0 candidate set) | Dexie table `collectionEntries` (account's collection snapshot, `card.scryfallId`) |
| Export list, bar and dialog to Moxfield | `src/lib/export/list.ts` (`useExportList`), `src/lib/export/ui/ExportBar.tsx`, `ExportDialog.tsx`, used the same way as `ComparisonPage.tsx` |
| Export item shape | `ExportItem` in `src/lib/export/types.ts` (set, cn, finish, lang, qty, scryfallId; `cardId` can stay empty, since Moxfield's CSV import finds the print by set + number) |
| Menu entry | `src/entrypoints/dashboard/Layout.tsx`, *Collection* section |
| Route | `src/entrypoints/dashboard/main.tsx` |
| IndexedDB | `src/lib/db.ts` (Dexie, currently version 4) |
| Stored data listing / clearing | `src/features/settings/stored-data.ts`, *Settings → Stored data*, *Remove all data* |
| Language badge, card thumbnails | `src/lib/ui/LangBadge.tsx`, `src/lib/ui/CardThumb.tsx` |

---

## 6. Phases

Order: **0 → decide → 1 → 2 → measure → 3 and/or 4**, one phase per session.

### Phase 0 — Prototype on real photos

**Goal:** before spending on the rest, find out whether detection finds the cards in photos taken the way they'll really be shot, and whether image matching names them right.

**Build:**
- **Hidden test page** `#/collection/scanner` (not in the menu yet). Drop one or more photos on it; it outlines each card with a number. Clicking a card shows its flattened picture, the 5 best matches with scores, and timings.
- **Shape detection** with OpenCV.js (quickest to try): downscale to about 1500 px on the long side, grayscale, blur, threshold and edges, contours, keep 4-sided shapes with a card's proportions and a plausible size, drop nested outlines, order the corners.
- **Flattening** to 488×680, trying upside down too.
- **Matching against owned prints only** (about 4k prints from the synced collection):
  - download their Scryfall `normal` images once (a few hundred MB, a few minutes);
  - turn each image into a vector and cache it in IndexedDB;
  - compare two off-the-shelf models (one small and fast, one larger and more accurate), and pHash as a baseline.
- Add `scanner-samples/` to `.gitignore`.

**Done when** there are numbers on the sample photos: cards found, missed and false, name right at first try, print right at first try and in the top 5, seconds per photo. Then decide:
- is shape detection good enough, or is phase 4 needed?
- which model wins?
- continue at all?

**Needed:** 5–10 photos taken the way the scanner will really be used (table, binder pages, fanned stack…) in `scanner-samples/`, and what's right for each (or confirm the labels from screenshots).

**Risks:** the engines' size; the CSP for WASM; downloading about 4k reference images.

**Tokens:** about 100–150k output and 30–50M cache reads (≈ $15–25).

**Decided before building (2026-11-19):**
- the prototype ships hidden in releases (reachable by URL, not in the menu);
- quality over size: OpenCV.js and onnxruntime-web are bundled (≈ +41 MB unpacked);
- photos to support: cards spread on a table, binder pages, fanned/overlapping, many cards per photo. The scanner may require high-resolution photos; cards too small to detect are tolerated;
- matching against owned prints only.

#### Phase 0 — how to run

1. Build and load the extension, then open `dashboard.html#/collection/scanner` (not in the menu).
2. **1. Engine and model:** *Download and start the model* (88.5 MB from Hugging Face, once; then from Cache Storage).
3. **2. Reference set:** *Build the reference set*: every print of the current account's synced collection, from Scryfall's `normal` images (≈ 107 KB each, not kept). About 15 minutes for ~3,900 prints on the test machine; it can be stopped and resumes.
4. **3. Photos:** drop photos (full camera resolution) and `labels.json` together. Each photo is scanned at once; *Scan all again* re-runs them with the current options:
   - *Simulate lower resolution* (100 / 50 / 33 / 25 %) finds the smallest card size that still works;
   - *Detection size* is the long side the photo is shrunk to for detection (corners are scaled back; cards are flattened from the full photo);
   - *Keep debug layers* keeps the edge map and the rejected shapes, shown with *Edges* and *Rejected shapes*.
5. **Scores:** a table per method (labelled / detected / unpaired, name and print right at first try and in the top 5, name hit rate by card height). *Copy results JSON* copies everything without pixels.

`labels.json` (in the gitignored `scanner-samples/`), format 1: one entry per physical card, set and number optional:
`{ "IMG_0001.jpg": [{ "name": "Sol Ring", "set": "cmm", "cn": "410" }, { "name": "Counterspell" }] }`

#### Labelling mode (2026-11-20)

Real photos only help the models once each card has its corners and its print. The page's **View: Labels** makes them from the scan, for a person to fix:
- **Drafts:**
  - Opening a photo in Labels makes a draft: every card found, with its corners (turned to the card's own top-left) and its best print, unchecked.
  - With older name-only labels, each label gets the corners of the card found with its name (exact print first, then the best match: a card outlined twice gets the better outline), and keeps its print. Labels left unpaired show "needs an outline".
- **Fixing:**
  - **Corners:** drag the 4 handles of the selected card (the filled one is its top-left). The card is named again on release; a print given by a person stays.
  - **Add a card** (A): click its 4 corners, in any order.
  - **Delete** (Del) a junk shape; **turn 180°**.
  - **Print:** pick it from the scanner's top 5, from any of your prints (search), or as a card you don't own (name, set, number).
  - "Checked", "Mostly hidden", "Mark all checked", "Next photo to check" (N), and zoom (fit, 2×, 4×).
- **Colours:** checked = blue; otherwise the confidence colour; mostly hidden = dashed.
- **Saving:** drafts are saved in the browser as you go (`labels` table of `tithies-scanner`). Dropping the same photo again brings them back, and they win over a `labels.json` dropped later. **Download labels.json** writes format 2 for every photo.
- **Scoring uses only cards a person checked** (or from an older file): a draft is the scanner's own guess.
  - With **checked** corners, labels pair with the cards found by overlap (IoU ≥ 0.5). "Found" then measures the detector alone, and "extra shapes" are what it found that is no card. Corners copied from a scan into a draft would find themselves, so they don't count until checked.
  - Without corners, pairing is by name, exact print first (two Forests no longer get swapped).

Format 2:
```json
{ "IMG_0001.jpg": { "width": 4000, "height": 3000, "checked": true, "cards": [
  { "name": "Sol Ring", "set": "cmm", "cn": "410", "scryfallId": "…", "quad": [[x, y], [x, y], [x, y], [x, y]], "checked": true, "manual": true },
  { "name": "Danitha Capashen, Paragon", "quad": [[x, y], …], "hidden": true, "checked": true } ] } }
```
- **Corners:** in the photo's full-resolution pixels with the phone's orientation applied (OpenCV's `imread` applies it too), clockwise from the card's own top-left.
- **Covered cards:** a fanned or covered card is outlined whole, where it lies (the detector's convention). `hidden` marks one mostly covered: it is neither a miss nor an extra shape, and not a recognition pair.
- **`checked`:** a person looked at the card: corners and print.
- **`manual`:** the print was given by a person, or came from a format-1 file. It counts for scoring before its corners are checked, and moving the corners keeps it.

**Photos to take next** (40–80, your own cards, full resolution):
- **Small cards:** 20–40 cards on a table in one shot; full 9-pocket binder pages from arm's length.
- **Binders:** other binders and pocket colours; glare; the page sideways.
- **Fans and piles:** fans where only a strip of a card shows; offset piles.
- **Holders:** coloured and matte sleeves, double sleeves, toploaders, one-touch holders.
- **Light:** daylight, warm lamp, flash; shadows of a hand or phone.
- **Surfaces:** busy playmats, carpet, bedding.
- **Angles:** straight down, and tilted 30–45°.
- **Special cards:** foils, borderless and showcase frames, non-English cards, tokens, basic lands, back faces.
- **Backgrounds:** 10–20 more photos with no cards.

One in four new photos (and the first 19) stays out of training, as the test set.

Console tuning: `await scannerEngine.call({ type: 'bench', ep: 'webgpu', opt: 'all', runs: 5, batch: 16 })` times the model with other session options.

#### Phase 0 — findings so far

- **Both engines need a sandboxed page.** OpenCV.js (embind) and every onnxruntime-web build with WebGPU call `new Function`, which the extension pages' CSP forbids (`'unsafe-eval'` is not allowed in MV3 extension pages). They run in `scanner.html`, a manifest `sandbox` page loaded in a hidden iframe. It has an opaque origin, no storage and no extension APIs: the Scanner page sends it the photos, the model bytes and onnxruntime's WebAssembly, and keeps every result (IndexedDB, Cache Storage).
- **OpenCV.js trap:** Emscripten's Module has a `then` that resolves with itself, so `await`ing it (or returning it from an async function) loops forever in microtasks. `engine/opencv.ts` wraps it and deletes `then`.
- **The DINOv2-small ONNX export (Xenova) has fixed position embeddings:** only 224 × 224 input (16 × 16 patches). 224 × 308 fails. The card's proportions are kept by padding (161 × 224 centred) instead; both "squashed" and "padded" are measured.
- **WebGPU on the test machine has a large fixed cost per model run**: 680 ms for 1 picture, 800 ms for 4, 1.7 s for 16 (≈ 105 ms a picture). The CPU (one thread) takes ≈ 900 ms a picture. A trivial WebGPU read-back there takes ≈ 100 ms, and a naive 1024³ matmul reaches ≈ 18 GFLOPS, so it's that machine's GPU path, not the model (`'all'` graph optimization, JSEP and the newer WebGPU build behave the same). Runs are therefore batched by 16 pictures: 8 reference images (2 resizes each), or 4 photo cards (2 ways up × 2 resizes).
- **onnxruntime build:** the JSEP build (`onnxruntime-web`, `ort-wasm-simd-threaded.jsep.wasm`, 29.5 MB) is used. One thread only: several would need cross-origin isolation, which would break the image thumbnails on other pages.
- **First real photo** (one borderless foil card in a toploader, 3024 × 4032, close up): detection fails, matching works.
  - The card's left and right edges barely exist in the image (silver-grey foil against grey plastic); its outline joins the art's and the toploader's edges, so no closed card shape is found. A line-based pass (lines.ts: long straight edges, two near-parallel pairs, sides checked on the edge map) was added; on this photo it still builds wrong quads from the text box and the toploader.
  - With the card's corners placed by hand (`scannerDebug.identifyQuad` in the console), every method names it first, print included: DINOv2 padded · CLS 0.872 vs 0.762 for the next card, squashed · CLS 0.858 vs 0.710, pHash 0.781 vs 0.688.
  - So close-ups of cards in toploaders or sleeves need either a "place the corners yourself" fallback or the trained detector (phase 4).
- **Tooling:** `SCANNER_PHOTO=scanner-samples/x.png npx vitest run tests/scanner-photo.debug.test.ts` runs detection in Node (OpenCV.js works there when loaded with `require`: an ESM import loops on its `then`) and writes `x.debug.png` (cards, line quads, lines) and `x.debug.txt`. `SCANNER_EXPECT=x0,y0,x1,y1` reports the line quad closest to a known card box. PNG only.
- **File picker and Playwright:** while the Playwright MCP is attached to the browser, it intercepts native file dialogs: the page's file input looks dead. Drag and drop works, and so does feeding files through the MCP's `browser_file_upload`.
- **Size:** the unpacked extension went from ≈ 2.5 MB to ≈ 43 MB (OpenCV.js 10.9 MB in the sandbox chunk, onnxruntime's WebAssembly 29.5 MB). The model (88.5 MB) is downloaded, not bundled.

#### Phase 0 — baseline on real photos (2026-11-19)

19 photos (Pixel phone, 4000 × 3000, plus the earlier toploader shot), 107 cards, labelled in `scanner-samples/labels.json` (104 with their exact print, checked against the owned prints). Current detection (contours + lines + binder grid), matching against the 3,855 owned prints.

| Photo type | Photos | Cards named right, first try (DINOv2 padded · CLS) |
|---|---|---|
| Binder pages (9-pocket) | 3 | 16 / 24 (67 %) |
| Table, cards out of sleeves, plain surface (wood, granite, mat) | 7 | 20 / 42 (48 %) |
| Deck boxes as background | 2 | 3 / 6 |
| Toploaders, one-touch holders | 2 | 2 / 4 |
| Sleeved cards on wood | 1 | 1 / 9 |
| Busy background (knit blanket), straight and angled | 2 | 2 / 16 |
| One card held in hand | 1 | 0 / 1 (squashed · CLS: 1 / 1) |
| Fanned hand | 1 | 0 / 5 |
| **All** | **19** | **44 / 107 (41 %)** |

By method, over all photos: DINOv2 squashed · CLS 41 % first try (46 % top 5), padded · CLS 41 % (50 %), squashed · mean 26 %, padded · mean 26 %, pHash 20 %. 124 shapes were detected, about 70 of them not a labelled card (pocket and sleeve edges, text boxes, deck-box seams, cards cut by the photo's edge).

**What it says:**
- **Detection is the bottleneck, not matching.** Among the shapes that were a card, cards 600 px tall or more are named right at the first try 84–95 % of the time (CLS variants), and top 5 adds little over top 1: when the outline is right, the first answer is usually right. The toploader photo with hand-placed corners confirms it (0.872 vs 0.762).
- Detection holds up only on clean cases: borders visible against a plain surface, or binder pockets. It fails on sleeves, toploaders, busy backgrounds, angled shots and fanned cards, and it adds many false shapes (most with low match scores, under 0.5).
- **Keep DINOv2 with the CLS token**: mean pooling and pHash are far behind. Squashed and padded tie at first try; padded is slightly better in the top 5. To decide on better crops, after phase 4.
- **Basic lands:** names right (Forests 4 / 4) but prints mostly wrong (1 / 4): same-name lands with similar landscapes get mixed up.
- Not measured yet: the minimum card size (every photo here is full resolution with large cards).

**Decision:** phase 4 (trained detector) goes next, before phases 1–2. These photos and labels are its test set.

### Phase 1 — Reference index of every print

**Goal:** recognize any card, not only owned ones.

**Offline builder** (a Node script, e.g. `scripts/scanner-index/`, run locally at first):
1. **Card list.** Download Scryfall's `default_cards` bulk file (81 MB on 2026-11-19) and keep paper prints only (`games` includes `paper`). Double-faced cards get both faces (`card_faces[].image_uris`). Keep per print:
   - Scryfall id, name, set, set name, collector number, language;
   - `finishes` (to set foil-only prints automatically);
   - `illustration_id` (groups same-art reprints for phase 3).
2. **Images.** Download the `normal` images at a polite pace, resumable, into a gitignored cache folder: about 100k images, several GB, a few hours the first time.
3. **Vectors.** Compute them with **the same model and the same image preparation as the browser** (ideally the same ONNX model run with onnxruntime-node), so the numbers match exactly.
4. **Pack.** Normalize, shrink to about 128 dimensions as int8, write a binary index plus a print list, and a small manifest (date, count, model id and hash, sizes). About 15–25 MB.

**Hosting:** recommended on **GitHub Release assets**.
- The Pages workflow rebuilds the site on every push and can't redo a multi-GB build each time.
- Updates stay cheap: a job downloads the previous index and embeds only new prints, or prints whose image Scryfall has replaced (image URLs carry a `?timestamp` that changes). That's a few hundred images per set, so it fits easily in a scheduled GitHub Action.
- GitHub Pages limits (100 MB per file, 1 GB per site) would also fit, but publishing the index there ties it to the site's build.

**In the extension:**
- On first scanner use: download the manifest and the index with a progress bar, and store them in IndexedDB (Dexie version 5).
- Check once a week for a newer index.
- Search runs in a Web Worker: top 10 by dot product over the int8 vectors.

**Done when:** the phase-0 photos do as well or better against every print, the first download and load takes under about 10 seconds, and one incremental update has been published.

**Tokens:** about 100–150k output and 30–50M cache reads (≈ $15–25), plus hours of machine time (no tokens).

### Phase 2 — The Scanner page

**Goal:** the whole flow works: photos in, list corrected, cards added to the Moxfield collection or a binder.

**Processing:**
- Runs in a Web Worker so the page stays responsive: photos are queued one after another, with progress for each.
- Phone photo orientation is applied (`createImageBitmap`, `imageOrientation: 'from-image'`).
- Uses WebGPU when available, WASM otherwise.

**Page** *Collection → Scanner* (`/collection/scanner`):
- **Photo view:** outlines coloured green (sure), orange (needs review) or red (unknown), with numbers. Clicking an outline highlights its row, and the other way round.
- **Table:** the user's crop next to the matched card's image, then name, set, number, language, finish, quantity and confidence. The same print can be merged into one row with a quantity.
- **Corrections:**
  - "Pick print" shows the best candidates plus every print of that name, with images;
  - "Not a card" removes a row;
  - "Missed card": drag a box over it to identify it.
- **Defaults:** finish non-foil (set automatically for foil-only or etched-only prints); language English unless changed.

**Keeping the work:** the scan session (photos, outlines, corrections) is saved in IndexedDB until cleared, so a reload doesn't lose 20 photos' worth of fixes. It's listed under *Settings → Stored data* and removed by *Remove all data*.

**Export:**
- Rows become `ExportItem`s (note "Scanned") and go through the existing export list, bar and dialog, as on the Comparator.
- Moxfield's import finds each print by set + number, and the Language field carries the language.

**Also:**
- **Settings:** index status (date, size, update now), backend in use (WebGPU or WASM).
- **Manifest:** host permissions for `cards.scryfall.io` and the index host; CSP for WASM.
- **Tests (vitest):** corner ordering and shape filter, homography, index search on a small synthetic index, rows to export items, merging and quantities, stored data; one small sample photo as a smoke test.
- **README:** a *Scanner* section. The website is updated separately.

**Done when:** a real photo goes through to a test binder on Moxfield, checked on Moxfield, and `npm run typecheck` and `npm test` pass.

**Tokens:** about 250–400k output and 80–150M cache reads (≈ $35–60).

**Later idea:** start a Selling run (F2F buy prices) from a scanned list.

### Phase 3 (optional) — Reading the bottom line for the exact print

**Goal:** tell same-art reprints apart, and read the language.

**What the cards carry:**
- Since 2014, cards print their number, rarity, set code and language at the bottom left (e.g. `0123 R · MH3 · EN`; older 2014–2022 cards say `123/269 R` over `M15 · EN`).
- Cards from 2003–2014 have a number only, and cards before 1998 have none.

**How:**
- Only when the best match has same-art reprints (several prints share its `illustration_id`), or to read the language.
- Re-cut that corner from the **full-resolution** photo (not the downscaled one) at about 3× scale, sharpen and binarize it.
- Read it with Tesseract.js, limited to the characters that can appear there (`tessedit_char_whitelist`).
- Parse number, rarity, set code and language (EN FR DE IT ES PT JA KO RU ZHS ZHT PH…), then pick the reprint whose set and number match.
- The row shows what was read (e.g. "read MH3 · 0123 · EN"), so the user sees why a print was chosen.
- A card too small to read (under about 700 px tall) falls back to the print picker.

**Done when:** print accuracy on modern cards is measured before and after.

**Tokens:** about 100–200k output and 30–60M cache reads (≈ $15–30).

### Phase 4 (optional) — A trained detector

**Status (2026-11-19):** the training kit is in `scanner-train/` (Windows instructions in its README), and the Scanner page can load its output (`card-detector.onnx` dropped on the photos box; "Find cards with": classic, trained detector or both). Training runs on the user's RTX 4070 (12 GB).
- **Model:** ResNet-18 (torchvision, BSD) with a small feature pyramid, CenterNet-style. It predicts a heat map of card centres on 4-pixel cells, and at each cell the card's 4 corners as offsets. The corner order follows the card up to a half turn; the loss takes the better of the two orders. Input 768 × 768, the photo letterboxed at the top-left with grey 114. The ONNX file is ≈ 46 MB.
- **Scenes:** `synth.py` (≈ 150 ms a scene at 1024 on one CPU core). Layouts: table spreads, binder pages (1–2 pages, empty pockets), fanned hands, piles, single cards. Holders: sleeves, toploaders, magnetic holders. Also foil, glare, shadows, fingers, distractor shapes, camera tilt (rendered on a canvas 30 % larger, so no edges show), blur, noise and JPEG. Backgrounds: the user's photos of empty surfaces, Scryfall artwork as playmats, and generated wood, stone, fabric and plain surfaces.
- **Checked here:** a 100-step CPU run learns (validation F1 0.05 → 0.13); the export matches PyTorch to 6e-7; the browser decodes the same cards as Python on a test scene.

**First trained detector (2026-11-20):** trained on the RTX 4070 in 5 h (30 epochs × 1,000 steps × 16 scenes, 27 scenes/s, limited by the data loading on Windows). Generated test scenes at the best epoch (23): F1 0.93 (precision 0.88, recall 0.98), mean corner error 4.8 px at 768 px input. On the 19 real photos (same labels as the baseline):

| Photo type | Classic detection | Trained detector (threshold 0.3) |
|---|---|---|
| Plain table (wood, granite, mat) | 20 / 42 | 40 / 42 |
| Toploaders, one-touch holders | 2 / 4 | 4 / 4 |
| Sleeved cards on wood | 1 / 9 | 6 / 9 |
| Knit blanket (straight and angled) | 2 / 16 | 9 / 16 |
| Binder pages | 16 / 24 | 16 / 24 |
| Deck boxes as background | 3 / 6 | 4 / 6 |
| Fanned hand | 0 / 5 | 1 / 5 |
| One card in hand | 0 / 1 | 1 / 1 |
| **All** (DINOv2 padded · CLS, first try) | **44 / 107 (41 %)** | **81 / 107 (76 %)**; threshold 0.2: **83 / 107 (78 %)**, prints 76 / 104 |

- Detection is no longer the main limit: 112 shapes found for 107 cards (30 not a labelled card, against about 70 before). Cards 600 px tall or more that it finds are named right 99 % of the time (padded · CLS).
- **Padded · CLS is the method to keep** (78 % at threshold 0.2; squashed · CLS 71 %, mean pooling 54 %, pHash 50 %).
- What fails now is mostly **matching on hard crops**: sleeve and pocket reflections (sleeved cards on wood; binder page photographed sideways under glare), small, slanted and blurred cards in an angled shot, fanned cards (the crop includes the cards on top), and back faces of double-faced cards (Volcanic Fissure: the reference set only has front faces). Basic lands still get the wrong print (Forests 4 / 4 names, 1 / 4 prints).
- Default detector threshold set to 0.2.

**Back faces in the reference set (2026-11-20):** owned prints with two faces get a second picture (Scryfall's `back` image), stored as `<id>~back` and indexed under the print, so a match on it names the print and the card list shows the back. A print whose back picture is a 404 (adventures, split, flip cards: two names, one picture) is remembered in the `meta` table and not asked again. In the test collection: 115 two-faced prints, 55 back pictures, 60 without one. Result on the 19 photos: unchanged at 83 / 107 (prints 76 / 104). They show one back face (Volcanic Fissure, sleeved, on the knit blanket): its back picture now comes second, at 0.78 against 0.78 for the wrong first answer; before, it wasn't among the candidates at all.

**Recognition fine-tune (kit ready, 2026-11-20):** `scanner-train/` also fine-tunes DINOv2-small for this job (README step 7).
- **Pairs:** `crops.py` photographs one card (random holder, neighbours in a mini scene, a covering card or a finger, glare, blur, noise, JPEG, 200–900 px tall), then flattens it with corners off by 0.5–3 % of its height, as the detector would. The other side of the pair is the card's clean picture, prepared exactly like the page does (224 × 224, card padded to 161 px wide, grey ImageNet mean around).
- **Training:** `train_recog.py`, symmetric InfoNCE (temperature 0.05) on batches of 64 pairs; 30 % of each batch is same-name cards with other artworks (basic lands, reprints with new art), and an artwork never appears twice in a batch. A linear head (identity at the start) on the CLS output; backbone learning rate 2e-5, head 1e-3.
- **Validation:** photos of 1 artwork in 20 that training never sees, searched among their clean pictures plus 2,000 others: share found first (right print) and right name.
- **Export:** `export_recog.py` gives `card-recognizer.onnx` with the same inputs and outputs as the Xenova file (`pixel_values` → `last_hidden_state`, `pooler_output`), so the page runs it unchanged. Dropped on the photos box, it's kept in Cache Storage and selected ("Recognition: Tuned"). Its reference vectors are stored apart (rows keyed by a hash of the file), so switching models never mixes vectors; each model needs its own "Add missing prints".
- **Checked here:** a CPU run on the 357 local cards (12 steps of 8 pairs) moves validation top-1 from 0.727 to 0.864 (22 cards, so noisy, but the direction is right). The export matches PyTorch (lowest cosine 1.000000). In the user's Chrome, the exported file (89 MB) was dropped on the page: it runs on WebGPU, builds its own reference rows (`tuned|<size>|<hash>|…#<id>`, back faces included) next to the DINOv2 ones, and scans a photo; the test model and its rows were removed afterwards.
- **Data workers start with "spawn"** on every system: forked workers hung on Linux once the main process had used threads (Windows always spawns).
- **Why tuned vectors differ so much from DINOv2's** (cosine 0.3 for the same card after 12 steps, with weights moved under 1 %): DINOv2-small's CLS output has a few very large channels (mean |x| ≈ 5 against 1.7 typical) that make all cards look alike (wrong matches at 0.7–0.9). Tuning shrinks them first (to 1.5–2.9), so different cards look less alike (0.39 → 0.27). The full run warms up over 500 steps; the tiny run had one.

**First tuned recognition model (2026-11-20):** trained on the RTX 4070 in 2 h 40 min (20 epochs × 500 steps × 64 pairs, about 60 pairs/s, limited by the pair generation on 10 CPU workers). 19,681 training pictures, 1,101 validation cards (artworks never trained on) searched among 3,101.

| | Right print first | Right name first |
|---|---|---|
| DINOv2-small as is | 0.643 | 0.724 |
| After epoch 1 | 0.906 | 0.971 |
| Best (epoch 15, kept) | **0.948** | **0.986** |
| Epoch 20 | 0.945 | 0.987 |

- It levels off from epoch 6 (0.93–0.95); training loss 0.024 at the end. A longer run would add little; more varied pairs would add more.
- **On the 19 real photos** (trained detector, threshold 0.2; reference set of the 3,855 owned prints, 3,910 pictures with back faces, built with the tuned model in 14 min):

| | DINOv2 as is | Tuned |
|---|---|---|
| Name right, first try (padded · CLS) | 83 / 107 (78 %) | **105 / 107 (98 %)** |
| Print right, first try | 76 / 104 (73 %) | **100 / 104 (96 %)** |
| Shapes not matching a labelled card | 31 | 13 |

  (The page's own table says 98 / 104 prints: it pairs labels to cards by name only, so it can pair two Forests the wrong way round. Pairing exact prints first gives 100.) Squashed · CLS and both mean variants also reach 97–98 % names now: the choice of variant matters much less.
- **What's left:**
  - 2 names, both not found by the detector: Eldrazi Displacer in the bottom-left pocket of a binder page (fully visible: a plain miss), and Danitha Capashen, almost all hidden behind Bond of Discipline in the fanned hand (only a strip with its name shows).
  - 2 prints: Viscera Seer (CMR vs TDC) and Bonders' Enclave (M3C vs OTC) are same-artwork reprints with the same frame; only the set symbol and collector number differ. That's phase 3 (reading the bottom line), or a choice left to the user.
  - The 13 extra shapes: 1 real card the labels missed (Sulfuric Vortex as "Hades Grip", half out of the frame, named right at 0.83), 1 second outline of Pay No Heed (0.54, next to the real one at 0.90), and 11 shapes that span two neighbouring cards, or a small piece where fanned cards overlap (the 413 px "Massacre Wurm" in the fan). Those score 0.39–0.55, against 0.73 for the 10th percentile of right cards (median 0.875).
- **Confidence limits per model:** the tuned model gets "sure" from 0.6 with a margin of 0.08 ("review" from 0.4); DINOv2 keeps 0.5 / 0.05 / 0.3. On these photos that makes 105 of the 106 right cards sure and none of the 12 wrong shapes. These limits come from the same photos, so they need checking on new ones.
- **Next steps it suggests:** drop a shape that contains two better-scoring cards, and keep one of two overlapping shapes named the same print (the better score), before showing the list.

**Plan as written before the kit:**



**When:** only if the measurements show that shape detection misses touching cards, binder pages, playmats, glare or fanned stacks.

**Training data:**
- A Python generator pastes 1–20 Scryfall cards (from the phase 1 image cache) onto random backgrounds (tables, playmats, binder page templates), with sleeves, tilt, rotation, scale, overlap, glare, blur, noise and compression.
- The exact corners of every visible card are known, because the generator placed them. That gives 20–50k labelled images.
- About 50–100 real photos, labelled, are kept back to check the results.

**Model:**
- A small model that outputs each card's 4 corners (oriented boxes or keypoints), exported to ONNX at about 6–12 MB and downloaded like the index.
- Training takes 1–3 hours on a GPU (Colab works); a CPU is impractical.
- **Licence check:** Ultralytics YOLO is AGPL-3.0, so prefer Apache or MIT options (YOLOX, RTMDet) or a small model of our own.
- It plugs in behind the same "find cards" step; shape detection stays as the fallback when the model isn't downloaded.

**Done when:** it beats shape detection on the real photos, at under about 1 second per photo with WebGPU.

**Tokens:** about 150–250k output and 40–80M cache reads (≈ $20–40), plus GPU hours.

---

## 7. Token and cost estimates

**Calibration** (measured from the Tithies sessions so far; 20 sessions ≈ 3.0M output, 28M cache writes, 990M cache reads):

| Past session | Output | Cache writes | Cache reads |
|---|---|---|---|
| Initial extension build | 394k | 4.0M | 106M |
| Decks sync / comparator | 361k | 5.3M | 149M |
| Multi-account | 357k | 2.0M | 98M |
| Comparator overhaul + Moxfield export | 473k | 6.4M | 242M |
| Languages | 213k | 2.6M | 81M |
| Medium features (7 sessions) | 100–200k | 0.25–1.9M | 22–77M |

**Scanner estimate:**

| Phase | Output | Cache reads | ≈ $ at list price |
|---|---|---|---|
| 0. Prototype | 100–150k | 30–50M | $15–25 |
| 1. Reference index | 100–150k | 30–50M | $15–25 |
| 2. Scanner page | 250–400k | 80–150M | $35–60 |
| 3. Bottom-line OCR (optional) | 100–200k | 30–60M | $15–30 |
| 4. Trained detector (optional) | 150–250k | 40–80M | $20–40, plus GPU hours |
| **Core (0–2)** | **0.45–0.7M** | **140–250M** | **≈ $60–110** |
| **All phases** | **0.8–1.2M** | **220–400M** | **≈ $100–170** |

- **Prices:** Opus 5.5 list prices: $20/M output, $0.20/M cache reads, $5/M cache writes (1.25× the $4/M input). Actual billing depends on the plan.
- **For comparison:** the core is about the size of the Languages and Multi-account sessions together.
- **What drives the cost:** cache reads are about 97% of all tokens, and each step costs more as a session's context grows. One phase per session keeps it down.

---

## 8. Open decisions

1. **What will be photographed:** cards spread on a table, binder pages, fanned stacks? This decides whether phase 4 is likely.
2. **Index hosting:** GitHub Release assets (recommended) or elsewhere?
3. **Downloads:** is a 15–25 MB first-use download (model + index) and a 10–20 MB bigger zip OK?
4. **Phase 4 hardware:** a local GPU, or Colab?
5. **Which embedding model** (decided by phase 0's measurements).
6. **Optional Claude vision fallback** for low-confidence cards (needs an API key in Tithies): yes or no?

---

## 9. References

- Scryfall bulk files on 2026-11-19: `oracle_cards` 26 MB, `unique_artwork` 39 MB, `default_cards` 81 MB, `all_cards` 408 MB (from `api.scryfall.com/bulk-data`).
- Scryfall card fields used: `illustration_id`, `finishes`, `games`, `image_uris` / `card_faces[].image_uris`, `lang`, `collector_number`, `set`.
- magic_card_detector (contours + pHash, MIT): https://github.com/tmikonen/magic_card_detector and its write-up https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector/
