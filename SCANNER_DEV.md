# Scanner — development notes

**Feature:** you upload one or more photos, and Tithies finds every Magic card in them: each card's outline (its 4 corners), the card and its print. You correct the list, then add it to the Moxfield collection or a binder. This is the "Scanner cards" item of `todo-future.txt`.
**Out of scope:** telling foil from non-foil in a photo. Finish defaults to non-foil and you change it per row.
**What's left to build:** `SCANNER_PLAN.md` (phase 1: every print, phase 2: the real page, phase 3: the bottom line).

---

## 1. Where it stands (2026-11-23)

**Built** (on master; a hidden prototype page, `dashboard.html#/collection/scanner`, not in the menu):
- **Engines:** OpenCV.js 4.12 and onnxruntime-web 1.31.1 on WebGPU, in a sandboxed iframe.
- **Detection:** a trained detector (`card-detector.onnx`), plus the first classic passes (contours, lines, binder grid), still selectable.
- **Recognition:** a fine-tuned DINOv2-small (`card-recognizer.onnx`), or DINOv2-small as downloaded.
- **Matching:** against every print, from an index made by the trainer and published with the models on Hugging Face ("only my prints" is a filter on it). The reference set built in the browser from the owned prints stays, as the developer path.
- **Cleanup:** bad shapes are dropped once the cards are named.
- **Labelling mode:** it makes the labelled photos that measure and train the models.
- **Training kit:** the private repo `tithies-scanner-trainer`, cloned next to this one. It holds the code, the labelled photos and the model versions (`models/vN`). The training runs on the user's PC.

**How it got here** (names right at the first try):

| Step | Names right |
|---|---|
| Classic detection with DINOv2 | 41 % (19 photos) |
| Trained detector | 78 % |
| Fine-tuned recognizer | 98 % |
| v2, both models also trained on labelled photos | 98.5 % (33 test photos) |

**Models v2** (2026-11-21), on the 33 test photos (199 scored cards), against the owned collection (3,910 pictures):

| | v1 | v2 |
|---|---|---|
| Found | 98.5 % (196) | **99.5 % (198)** |
| Extra shapes (after cleanup) | 16 | **12** |
| Name right | 97 % (193) | **98.5 % (196)** |
| Print right | 95.5 % (190) | **96.5 % (192)** |
| Corner error, labels moved by hand | 3.9 % of card height | **3.1 %** |

- **The page gives exactly the trainer's numbers** (`python -m trainer evaluate`; checked 2026-11-23 with both models loaded and the v2 reference set built).
- **Corner error over all labels** (1.9 % v1, 2.3 % v2) favours v1, whose corners drafted the labels: about half were kept as drafted. There's no systematic shift.
- **What's left:**
  - 1 card missed: Marchesa in a fanned hand;
  - 2 wrong names, both cards mostly covered by others (scores 0.54 and 0.37: orange);
  - 4 wrong prints, all same-art reprints (phase 3);
  - 12 extra shapes, all orange (0.46–0.59).
- **Training photos:** the weak spots (fans, offset stacks, binder pages from further away, piles, sleeves at an angle) are mostly training photos now, so the test set measures them little.

**Against every print** (phase 1; v2 index of 2026-11-24 on Hugging Face: 104,896 pictures, int8-384, 40.7 MB plus 4.8 MB of prints):

| On the 33 test photos (199 cards) | Owned collection | Every print | Only my prints |
|---|---|---|---|
| Found | 99.5 % | 99.5 % | 99.5 % |
| Name right | 98.5 % (196) | **98.0 % (195)** | 98.5 % (196) |
| Print right | 96.5 % (192) | **76.4 % (152)** | 96.5 % (192) |

- **On the page** (2026-11-25, in Chrome, downloaded from Hugging Face): exactly `evaluate --index` on the published index, photo for photo. The right print is in the top 5 for 98 % of the cards.
- **Download and opening:** the first download (181 MB) took 9.5 s; after that the page is ready 7.7–8.0 s after a reload (the full index opens in 2.1–2.7 s, alongside the models).
- **Formats:** int8-384 gives exactly the f32 numbers; int8-256 loses 4 prints, f16 nothing.
- **The wrong prints are same-art reprints:**
  - 28 have the same artwork and the same frame (The List, Commander and Jumpstart reprints): only the set symbol and the bottom line differ;
  - 15 more have the same artwork with a small difference, almost always a promo stamp; one is a real frame difference (M11 against CMR);
  - 3 are wrong names.
  - The right print is usually second, a few hundredths behind. Retraining can't fix most of these: the bottom line can (phase 3).

**Every print, technical checks** (2026-11-23):
- **Same numbers as the trainer:** with an index of the owned collection (int8, 384 dimensions), the page's results on the 33 test photos equal `evaluate v2 --format i8-384`, photo for photo. Against the collection, every format holds the same scores; the best scores move by at most 0.0013 in int8-384 and 0.016 at 128 dimensions.
- **Search** (a card is 2 searches: upright and turned): 105,000 rows on WebGPU take 34 ms for 4 cards, 45 ms for 8 and 124 ms for 16, against 1.3 s for 4 cards on the CPU in Chrome.
- **Opening:** the page is ready 7–9 s after a reload, models started and index open (small index).

---

## 2. How it works

**Per photo** (`pipeline.ts`; the heavy work runs in the sandboxed engine, `engine/`):
1. **Find the cards** (`engine/detector.ts`, `detector-decode.ts`):
   - the photo (phone orientation applied) is shrunk to fit 768 px, at the top-left of a grey (114) square;
   - the detector gives a heat map of card centres on 4-pixel cells, and at each cell the card's 4 corners;
   - decoding keeps the local maxima ≥ 0.2, orders the corners, keeps convex shapes of area ≥ 16, and merges overlaps (IoU > 0.5, best first);
   - the corners are scaled back to the full photo.
2. **Flatten** each card from the **full-resolution** photo to 488 × 680 (`warpCard`: warped at up to 2×, then shrunk with area averaging), both ways up.
3. **Name it** (`models.ts`, `engine/features.ts`, `match.ts`):
   - each cut-out goes to 224 × 224, the card padded to 161 px wide on grey (the ImageNet mean);
   - the model's `pooler_output` gives the vector ("padded · CLS", the method kept);
   - the vector is compared by cosine with the every-print index (in a worker, on WebGPU) or the reference set built here, brute force; the better side up wins;
   - all the cards of a photo are named in one search (`Namer` in `pipeline.ts`);
   - the top 5 and the margin to the first other name are kept.
4. **Cleanup** (`cleanup.ts`, "Drop bad shapes", on by default):
   - a shape covering two or more better-named shapes (coverage ≥ 0.8) goes;
   - of two outlines named the same (IoU ≥ 0.25, or the smaller one ≥ 0.6 inside the other), the better stays.
   - The dropped shapes go to `rejected`, with the reason `spanning` or `double`.
5. **Confidence per model** (`confidence` in `pipeline.ts`): the tuned model is "sure" from 0.6 with a margin of 0.08, and "review" from 0.4. DINOv2 keeps 0.5 / 0.05 / 0.3.

**Every-print index** (`index-file.ts`, `print-index.ts`, `search-*.ts`, `gpu-search.ts`):
- **Made** by `python -m trainer index vN` in the trainer repo, with version N's recognizer and the page's exact preparation. It only goes with its own recognizer: the page uses it only when the running recognizer's SHA-256 is the one in its manifest.
- **Kept current** by the trainer repo's daily GitHub Actions job (`python -m trainer refresh`, 13:17 UTC):
  - it finds new prints, new scans (a picture URL's timestamp changed) and removed prints, then embeds only those on the CPU; the other rows are kept exactly as published;
  - it scores the 33 test photos against the new index, and stops when fewer names come out right or more than 2,000 rows would change. A stopped run opens an issue;
  - checked on a local stand-in for the hub: the refreshed index equals a full rebuild byte for byte.
  - Only a new model version's first index is made on the PC.
- **Files:**
  - `index-<date>.bin`: every print's vector (int8 with a scale per row, or f16 / f32; 384 dimensions, or fewer by PCA);
  - `prints-<date>.json.gz`: the print of each vector (Scryfall id, face, name, set, number, language, artwork group, finishes);
  - `manifest.json`: the version, dates, and every file's SHA-256 and size.
- **What's in it:** the paper cards of Scryfall's `default_cards`, without tokens, emblems, art series, or prints with only a placeholder picture. That's about 105,000 pictures with the backs of double-faced cards.
- **Search:** the page keeps the prints; a worker keeps the vectors.
  - It runs on WebGPU (one dispatch for up to 32 queries, the top 5 picked in JavaScript), checked against the CPU path when the index opens.
  - Otherwise it runs on the CPU. JavaScript does about 0.3–0.6 billion multiply-adds a second, which is about 1.3 s for 4 cards over every print in Chrome.
  - "Only my prints" masks the same rows: the collection's prints by id, else by set, number and face.
- **The tests** check the TypeScript search against the trainer's own results (`tests/fixtures/scanner-index`, written by `python -m trainer index --fixture`).

**Published files** (`published.ts`):
- **Where:** the public Hugging Face model repo `tithies/card-scanner`, written by `python -m trainer publish vN`. It holds both models and the index under `vN/`, plus the root `manifest.json`.
- **Checks:** the page reads the manifest at most once a day ("Check for update" forces it). Files are downloaded at the manifest's commit (its `X-Repo-Commit` header).
- **Updates:** a new index alone (same models' SHA-256: `indexOnlyUpdate`) downloads by itself in the background and replaces the open one when no scan is running. New models wait for the "Update" button.
- **Storage:** each file goes into Cache Storage under its SHA-256 (checked), so a new index alone doesn't download the models again. Files the installed manifest no longer lists are removed.
- **Developer path:** dropping `manifest.json` with its index and prints files (and the models, if wanted) installs them the same way.

**Reference set built here** (`reference.ts`, `store.ts`), the developer path for models without an index:
- **What's in it:** the owned prints of the synced collection. Their Scryfall `normal` pictures are fetched politely (4 at a time, at most 10 a second), not kept. The vectors go to IndexedDB `tithies-scanner` → `refs`.
- **Rows:**
  - keyed per model (`MODEL_KEY` for DINOv2, `tuned|<size>|<hash>|<runs>#<id>` for the tuned model), so models never mix;
  - two-faced prints also get their back (`<id>~back`); a back Scryfall doesn't have is remembered (`meta` → `noBack`).
  - A new tuned file replaces the old one and its rows (`dropOtherTuned`).
- **Placeholders:** a non-English print Scryfall only has a placeholder of (the English picture under a "Localized image not available" box) gets the picture of the English print with the same set and number (`pictureStandIns`, recorded in the row's `picture`).
- **Building it** takes 15–20 minutes for 3,910 pictures, and resumes where it stopped.

**Models on the page** (`model-cache.ts`, `published.ts`), three sources:
- **Published:** the version's two models, downloaded with the index. They're used and started on open when they're here.
- **Dropped files:** the detector and the tuned recognizer dropped on the photos box. Any `.onnx` is the detector; a name with "recognizer" is the recognizer.
- **DINOv2-small:** downloaded from Hugging Face at a pinned revision (Xenova's export, 88.5 MB), with the dropped detector.
- **Storage:** everything is kept in Cache Storage `tithies-scanner-models`.

**Other files:**

| File | What it does |
|---|---|
| `protocol.ts`, `engine-client.ts` | The messages to the engine and their types |
| `geometry.ts` | Quads: IoU, coverage, area, ordering |
| `labels.ts`, `score.ts` | `labels.json` and the scoring of scans against it |
| `store.ts` | The Dexie database: reference rows, metadata (also the installed manifest and the last check), label drafts |
| `ui/` | The page: `ScannerPage` (state and options), `PhotoView`, `CardsTable`, `ResultsTable` (scores), `LabelEditor`, `LabelsTable` and `PrintPicker` (labelling) |
| `lines.ts`, `phash.ts`, `engine/detect.ts` | The classic detection passes and the pHash baseline |

---

## 3. The models

Both are trained in the trainer repo (its README has the commands) and versioned there in `models/vN`.

**Detector:**
- **Model:**
  - a ResNet-18 (torchvision, BSD, ImageNet weights) with a small feature pyramid, CenterNet-style;
  - a heat map of card centres on 4-pixel cells, and at each cell the card's 4 corners as offsets;
  - the corner order follows the card up to a half turn, and the loss takes the better of the two orders;
  - input 768 × 768; the ONNX file is about 46 MB.
- **Training data:** generated scenes (`scenes.py`):
  - **layouts:** table spreads, tight rows, binder pages (near and far), fanned hands, offset stacks, piles, single cards;
  - **holders:** sleeves, toploaders, magnetic holders;
  - **extras:** foil, glare, shadows, fingers, wrappers and bags, camera tilt, blur, noise, JPEG;
  - **surfaces:** the user's photos of empty surfaces, Scryfall artwork as playmats, and generated wood, stone, fabric;
  - plus 25 % of each batch from the labelled training photos.
- **Selection:** the best checkpoint is chosen on generated validation scenes. The test photos are measured each epoch, for information only.

**Recognizer:**
- **Model:** DINOv2-small (Apache-2.0) plus a linear head, which starts as the identity.
- **Pairs:** a card's clean picture against the same card "photographed":
  - drawn in a small generated scene (holder, neighbours, a covering card or finger, glare, blur, noise, JPEG);
  - cut out again with its corners off by 0.5–3 % of its height, as the detector gives them;
  - plus 20 % of each batch cut out of the labelled training photos.
- **Loss:** symmetric InfoNCE (temperature 0.05) on batches of 64 pairs.
  - No artwork appears twice in a batch.
  - 30 % of each batch is same-name cards with other artworks, the hard cases (basic lands, reprints with new art).
- **Validation:** 1 artwork in 20 is never trained on, searched among about 3,000 clean pictures.
- **Export:** the same interface as Xenova's DINOv2 file (`pixel_values` → `last_hidden_state`, `pooler_output`), so the page runs either.
- **Why tuned vectors differ so much from DINOv2's:** DINOv2-small's CLS output has a few very large channels, which make all cards look alike (wrong matches at 0.7–0.9). Tuning shrinks them first.

**Versions** (`models/README.md` in the trainer repo):
- **v1:** the detector from ImageNet weights on generated scenes; the recognizer from DINOv2-small.
- **v2:** both fine-tuned from v1 with the labelled photos.

---

## 4. Labelling mode and `labels.json`

Real photos only help the models once each card has its corners and its print. The page's **View: Labels** makes them from a scan, for a person to fix.

- **Drafts:**
  - opening a photo makes one: every card found, with its corners (turned to the card's own top-left) and its best print, unchecked;
  - older name-only labels get the corners of the card found with their name (exact print first, then the better score).
- **Fixing:**
  - **Corners:** drag the 4 handles of the selected card (the filled one is its top-left). The card is named again on release; a print given by a person stays.
  - **Add a card** (A): click its 4 corners, in any order.
  - **Remove a junk shape** (Del), or **turn a card 180°**.
  - **Print:** from the top 5, from any owned print (search), or a card not owned (name, set, number).
  - **Helpers:** "Checked", "Mostly hidden", "Mark all checked", "Next photo to check" (N), zoom (fit, 2×, 4×).
- **Colours:** checked = blue; otherwise the confidence colour; mostly hidden = dashed.
- **Saving:**
  - drafts are saved in the browser as you go (`labels` table of `tithies-scanner`);
  - they win over a `labels.json` dropped later;
  - **Download labels.json** writes every photo.
- **Scoring** (the page's table and the trainer's `evaluate`) uses only cards a person checked:
  - **with checked corners,** labels pair with the shapes found by overlap (IoU ≥ 0.5), so "found" measures the detector;
  - **without corners,** pairing is by name, exact print first.
- **Face-down and unreadable cards:**
  - they're named `Card back` or `Unknown card` and ticked "Mostly hidden";
  - the detector still learns them as cards; recognition skips them.

Format 2:
```json
{ "IMG_0001.jpg": { "width": 4000, "height": 3000, "checked": true, "cards": [
  { "name": "Sol Ring", "set": "cmm", "cn": "410", "scryfallId": "…", "quad": [[x, y], [x, y], [x, y], [x, y]], "checked": true, "manual": true },
  { "name": "Danitha Capashen, Paragon", "quad": [[x, y], …], "hidden": true, "checked": true } ] } }
```
- **Corners:** in the photo's full-resolution pixels with the phone's orientation applied (OpenCV's `imread` applies it too), clockwise from the card's own top-left. A covered card is outlined whole, where it lies.
- **`hidden`:** mostly covered. It's neither a miss nor an extra shape, and not a recognition pair.
- **`checked`:** a person looked at the card, corners and print.
- **`manual`:** a person gave the print (or it came from an older name-only file).

**Split:** `split.json` fixes the test photos, which are never trained on:
- the first 19 photos and 1 in 4 of the others, by a hash of the file name;
- later photos follow the hash rule;
- a folder named `test…` holds test-only photos.

---

## 5. Working method

- **Training** happens on the user's Windows PC (RTX 4070, 12 GB), from the trainer repo:
  - I change the code there and commit (neutral identity); the user pushes, pulls on the PC, trains;
  - `python -m trainer release vN` makes `models/vN` (both `.onnx` files and their PyTorch weights in Git LFS, logs, evaluation), which the user commits and pushes; `--from vN` fine-tunes from those weights.
- **A new version on the page:**
  - **Published:** after `python -m trainer index vN` and `publish vN` on the PC, the page offers "Update" (or "Check for update" first). Index updates after that come from the daily job by themselves.
  - **Before publishing:**
    1. `git pull` the trainer repo;
    2. drop `models/vN/index/manifest.json`, `index-*.bin` and `prints-*.json.gz` on the photos box;
    3. drop the two models too. Files over 50 MB go through the browser tool in parts.
  - **A small index of the collection to try the page:** `python -m trainer index v2 --gallery owned --out work/index/v2-owned --no-eval`. It's never published: `publish` refuses it.
  - **Without an index:** "Built here (my prints)", then "Build the reference set" for the new recognizer.
- **Photos:** a new batch is stripped of its metadata (`python -m trainer photos strip`: GPS, motion-photo video; pixels unchanged), labelled on the page, and committed in the trainer repo's `photos/`. `photos/owned-prints.json` is read from the page's reference set, so the evaluation uses the same gallery.
- **Running the page:**
  1. build (`npm run build:win` copies it to the Windows folder Chrome loads) and reload the extension;
  2. open `dashboard.html#/collection/scanner`; the published models start by themselves, dropped ones with "Start the model";
  3. drop photos (full camera resolution) with `labels.json` to get the scores table.
  - "Copy results JSON" copies every result without pixels.
  - "Keep debug layers" (off by default) keeps the edge maps and rejected shapes, which use a lot of memory over many photos.
- **Local checks:**
  - a CPU Python environment runs the trainer's short runs and `evaluate` (about 12 minutes for a new recognizer's gallery, 1.5 minutes when cached);
  - data loaders start their workers with `spawn`, because forked ones hang on Linux;
  - `SCANNER_PHOTO=<photo> npx vitest run tests/scanner-photo.debug.test.ts` runs the classic detection in Node and writes `<photo>.debug.png` and `.txt` to the temp folder's `scanner-debug/` (`SCANNER_EXPECT=x0,y0,x1,y1` reports the line quad closest to a known card).

---

## 6. Technical findings

- **Both engines need a sandboxed page:**
  - OpenCV.js (embind) and every onnxruntime-web build with WebGPU call `new Function`, which MV3 extension pages forbid;
  - they run in `scanner.html`, a manifest `sandbox` page in a hidden iframe: an opaque origin, no storage, no extension APIs;
  - the Scanner page sends it the photos, the model bytes and onnxruntime's WebAssembly, and keeps every result itself.
- **OpenCV.js trap:** Emscripten's Module has a `then` that resolves with itself, so awaiting it loops forever. `engine/opencv.ts` wraps it and deletes `then`. In Node it must be loaded with `require`.
- **DINOv2-small's ONNX export has fixed position embeddings:** 224 × 224 input only, so the card's proportions are kept by padding.
- **WebGPU on the test machine has a large fixed cost per run:** 680 ms for 1 picture, 1.7 s for 16. Runs are therefore batched by 16 pictures: 8 reference pictures × 2 variants, or 4 cards × 2 sides × 2 variants.
  - It's that machine's GPU path, not the model.
  - Console: `await scannerEngine.call({ type: 'bench', ep: 'webgpu', opt: 'all', runs: 5, batch: 16 })`.
- **onnxruntime build:** the JSEP build (29.5 MB of WebAssembly), single-threaded. Several threads would need cross-origin isolation, which would break the card thumbnails on other pages.
- **Size:** the unpacked extension went from about 2.5 MB to about 43 MB (OpenCV.js 10.9 MB, onnxruntime's WebAssembly 29.5 MB). The models aren't bundled.
- **Playwright and file pickers:** while the browser tool is attached, it intercepts native file dialogs, so the page's file input looks dead. Drag and drop and the tool's file upload work.

---

## 7. Constraints and limits

**Extension (Manifest V3):**
- no code from the internet, so the engines ship inside the extension;
- the model weights and an index are data, so they can be downloaded on first use;
- WebGPU when the browser offers it; WASM otherwise, slower.

**Scryfall** (their API docs, read 2026-11-23 with curl; the browser tool and WebFetch get HTTP 403):
- polite use: one bulk file, pictures at about 8–10 a second, a generic client name (`User-Agent` and `Accept` on API calls);
- their data and images are free "for the primary purpose of creating additional Magic software";
- no paywall, no implied endorsement, no new games;
- "You may not simply repackage, republish, or proxy Scryfall data. Your software must create additional value": the published index is part of a free scanner, and its model card says where everything comes from;
- images: no cropping of the copyright or artist line, no distortion or colour changes when shown.

**Recognition limits:**
- **Same-art reprints:** only the set symbol and the bottom line differ (phase 3, or the user picks).
- **Old cards:** cards from 2003–2014 carry a collector number only, and cards before 1998 none.
- **Small cards:** below about 700 px of card height, the bottom line is unreadable; names hold to much smaller sizes.
- **Covered cards:** fanned or overlapping cards match only on their visible part; a mostly covered card may be missed or misnamed (orange).
- **Glare** through sleeves, toploaders or pockets can hide details.
- **Duplicates:** one card photographed twice counts twice; the user adjusts quantities.
- **Language:** the same art across languages gives the right name, but the language only comes from the bottom line or the user.
- **Foil:** not detected.

**Privacy:** photos never leave the browser. Only Scryfall pictures and the models are downloaded.

---

## 8. References

- **Scryfall bulk files** on 2026-11-19: `oracle_cards` 26 MB, `unique_artwork` 39 MB, `default_cards` 81 MB, `all_cards` 408 MB (`api.scryfall.com/bulk-data`).
  - `default_cards` leaves out most non-English prints, which are looked up one by one.
- **Scryfall card fields used:** `illustration_id`, `finishes`, `games`, `image_uris` / `card_faces[].image_uris`, `image_status`, `lang`, `collector_number`, `set`.
- **magic_card_detector** (contours + pHash, MIT): https://github.com/tmikonen/magic_card_detector. It was the starting point for the classic pass and the pHash baseline; image vectors beat it by far.
