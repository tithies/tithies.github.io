# Scanner — development notes

**Status:** phase 0 (prototype) in progress (2026-11-19): the hidden test page is built; measurements on real photos are pending. See "Phase 0 — how to run" and "Phase 0 — findings so far" under section 6.
**Feature:** you upload one or more photos, and Tithies finds every Magic card in them. It returns a list of the detected cards, each with its position in the photo (so the page can draw an outline around it), the card and its print. You correct the list, then add it to the Moxfield collection or a binder. This is the "Scanner cards" item of `todo-future.txt`.
**Out of scope:** telling foil from non-foil in a photo. Finish defaults to non-foil and you change it per row.

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

`labels.json` (in the gitignored `scanner-samples/`): one entry per physical card, set and number optional:
`{ "IMG_0001.jpg": [{ "name": "Sol Ring", "set": "cmm", "cn": "410" }, { "name": "Counterspell" }] }`

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
