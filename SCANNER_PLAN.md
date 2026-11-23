# Scanner — plan of the remaining phases

What's built and how it works: `SCANNER_DEV.md`. This file is what's left, in order: **phase 1 → phase 2 → phase 3**, one phase per session.

**Starting a fresh session:**
1. Read `SCANNER_DEV.md` section 1 (where it stands), then the next phase below.
2. In the trainer repo (`tithies-scanner-trainer`, cloned next to this one): `git pull`. `models/README.md` lists the model versions and their scores; the latest version's two `.onnx` files are the ones the Scanner page should have.
3. **Working rules:**
   - Commits go on master, never pushed (the user pushes; a push of this repo is a release).
   - Commits use the neutral identity.
   - No machine paths, logins or personal details in any file or log.
   - Training runs on the user's Windows PC: I prepare the code and the commands, they run them and push `models/vN` (`python -m trainer release vN`).
4. **Plan mode first:** each phase starts in plan mode, with the decisions marked "decide first" asked before building.

---

## Phase 1 — Every print

**Goal:** recognize any card, not only the owned ones. The Scanner is for adding cards to the collection, so mostly cards that aren't in it yet.

**Status (2026-11-23): built, waiting for the measure on the PC.**
- **Decided with the user:**
  - Hugging Face hosts the files (`tithies/card-scanner`, under a `tithies` account with a neutral e-mail);
  - the index carries the print list;
  - every print by default, with "only my prints" as a filter and no tie-breaker;
  - cards only: no tokens, emblems or art series.
- **Built in the trainer:**
  - `fetch --every-print`;
  - `evaluate --gallery every-print | mine --formats --save`;
  - `index vN` (with `--update` and `--fixture`);
  - `publish vN`, which refuses an index that isn't every-print.
- **Built in the extension:**
  - `published.ts` (manifest, download, storage by SHA-256, daily check, developer drop);
  - `index-file.ts`, the search worker with WebGPU (`gpu-search.ts`);
  - "Only my prints", and Settings → Stored data;
  - tests against the trainer's fixture.
- **Checked:** page = `evaluate` with a small index of the collection; search speed; opening time (`SCANNER_DEV.md` section 1).
- **Left, in order:**
  1. **PC:**
     - `git pull`, then `python -m trainer fetch --every-print` (about 4 h, 11 GB);
     - then `evaluate v2 --gallery every-print --formats --save` and `evaluate v2 --gallery mine --save`;
     - commit and push `models/v2/eval-*.json`.
  2. **Choose** the format (the smallest within about 0.5 point of f32), and whether a v3 is needed (names down by more than about 1 point). A v3 gets its own plan-mode round. It needs v2's weights in `models/v2` first (`release v2 --add-weights`).
  3. **PC:** `python -m trainer index v2 --format <chosen>`, then commit and push `models/v2/index`.
  4. **The user:**
     - create the Hugging Face account `tithies` (neutral e-mail) and the public model repo `card-scanner`;
     - `hf auth login`, then `python -m trainer publish v2`.
  5. **Page:**
     - "Download" from Hugging Face;
     - the 33 test photos give `evaluate v2 --gallery every-print --format <chosen>`'s numbers;
     - opening time with the full index.
  6. **One update:** when Scryfall adds prints, `index v2 --update`, then `publish v2`; the page picks it up.

The steps below are the original plan, kept for the details.

**Today:**
- **Reference set:** the page builds it in the browser from the owned prints: 3,910 pictures, about 15–20 minutes per model (`reference.ts`), stored in IndexedDB.
- **Search:** brute force over those vectors (`match.ts`, `search-index.ts`).
- **Models:** dropped on the photos box by hand (Cache Storage). DINOv2-small comes from Hugging Face at a pinned revision.

**Decide first (with the user):**
1. **Where the public files live.** The tuned model files and the index are downloaded by every user's browser:

   | Host | Notes |
   |---|---|
   | **Hugging Face** (a public model repo under a neutral name) | Cross-origin downloads work (checked on the DINOv2 file the page already downloads); no new extension permission; files pinned by revision. Needs an account or organization. |
   | GitHub Releases | Checked 2026-11-23: the download redirects without a cross-origin header, so the extension needs host permissions for `github.com` and `release-assets.githubusercontent.com` (an optional permission, asked on first use). |
   | GitHub Pages | Cross-origin works; 100 MB a file (the recognizer is 89 MB); tied to the website's builds (the user updates the site separately). |

2. **Licences and terms** before publishing:
   - DINOv2-small (Apache-2.0);
   - the detector's ImageNet-initialised ResNet-18 (torchvision, BSD);
   - Scryfall's terms for data derived from their images. The index holds vectors, not pictures. Their API docs couldn't be read from the dev machine before (HTTP 403).
3. **What the page matches against:**
   - every print by default;
   - whether "only my prints" stays as an option;
   - whether owned prints win ties between same-art reprints.

**Steps:**
1. **Measure first, on the PC** (new trainer options):
   - `python -m trainer fetch --every-print`: every paper print of Scryfall's `default_cards` (both faces), into the same picture store. About 100k pictures, about 10 GB, about 4 hours at 8 a second.
   - `python -m trainer evaluate v2 --gallery every-print`: the test photos against every print. Today, against the owned collection: 98.5 % names, 96.5 % prints. Expect prints to drop (more same-art reprints) and names to hold.
   - Also measured: the index format (float32, float16, int8; 384 dimensions or fewer, by PCA) against names, prints and size.
2. **If names or prints drop:** a v3 recognizer, with a sample grown towards every print and more same-art reprints as hard negatives (`train recognizer --from v2`, then `release v3`).
3. **Index builder:** `python -m trainer index vN`. It writes:
   - the vectors of every print, made by version N's recognizer with the page's exact preparation (padded · CLS; `evaluate` already matches the page number for number);
   - the print list (Scryfall id, face, name, set, set name, number, artwork id, finishes);
   - a manifest (version, the model files' SHA-256, count, dimensions, date, the bulk file's date).
   - An index only ever goes with its own model version.
4. **Publish** the version's two model files, the index and the manifest together (`python -m trainer publish vN`, or by hand the first time).
5. **Extension:**
   - **First use:** the manifest, then the model files (Cache Storage, as today) and the index (IndexedDB, a new Dexie version), with progress.
   - **Updates:** a manifest check at most once a day. A newer version replaces model and index together.
   - **Search:** about 100k dot products per side of each card, in the sandboxed engine or a worker; tens of milliseconds expected.
   - **Non-English prints:** the index holds the default (mostly English) prints. The page reports the print (set and number); the language is a phase 2 default or phase 3's reading.
   - **The owned reference set:** kept as an option or as the tie-breaker (decision 3), otherwise removed.
   - **Settings → Stored data** lists the index and the models, and *Remove all data* clears them.
   - Dropping model files on the page stays, as a developer path.
6. **New sets:** `python -m trainer index vN --update` embeds only new prints, or prints whose picture changed (Scryfall's image URLs carry a timestamp), then publishes. By hand on the PC at first; maybe a scheduled job later.

**Done when:**
- names and prints among every print are measured offline and on the page (same numbers);
- the page downloads model and index on first use, and loads them in under about 10 seconds afterwards;
- one update (a new set) has been published and picked up.

**Tokens:** about 150–250k output, 2–4M cache writes, 50–100M cache reads (≈ $25–45 at list prices), plus hours of downloads and GPU on the PC (no tokens).

---

## Phase 2 — The Scanner page

**Goal:** the whole flow works: photos in, list corrected, cards added to the Moxfield collection or a binder.

**Processing:**
- Photos are queued one after another, with progress for each, and the page stays responsive (the engine already runs in a sandboxed iframe).
- WebGPU when available, WASM otherwise.

**Page** *Collection → Scanner* (`/collection/scanner`, in the menu):
- **Photo view:** outlines coloured green (sure), orange (needs review) or red (unknown), numbered. Clicking an outline highlights its row, and the other way round. The prototype's `PhotoView` and `CardsTable` are the start.
- **Table:** the cut-out next to the matched card's picture, then name, set, number, language, finish, quantity, confidence. The same print can merge into one row with a quantity.
- **Corrections:**
  - "Pick print": the best candidates, plus every print of that name with pictures. The labelling mode's `PrintPicker` is the start.
  - "Not a card" removes a row.
  - "Missed card": click its 4 corners, as in the labelling mode, and it's named.
- **Defaults:**
  - finish non-foil, set automatically for foil-only or etched-only prints;
  - language English unless changed. Decide: maybe the collection's usual language.

**Keeping the work:** the scan session (photos, outlines, corrections) stays in IndexedDB until cleared, so a reload doesn't lose 20 photos' worth of fixes. It's listed under *Settings → Stored data* and removed by *Remove all data*.

**Export:**
- Rows become `ExportItem`s (note "Scanned") and go through the existing export list, bar and dialog, as on the Comparator.
- Moxfield's import finds each print by set and number; the Language field carries the language.

**Also:**
- **The prototype's tools** (labelling mode, scores table, methods, debug layers) move to a developer view that stays hidden. Decide: whether the classic detection passes stay. OpenCV.js is still needed to flatten the cards.
- **Settings:** index status (version, date, size, update now), backend in use.
- **Tests (vitest):** rows to export items, merging and quantities, the stored session, the corrections.
- **README:** a *Scanner* section. The website is updated separately by the user.

**Code to reuse:**

| Need | Where |
|---|---|
| Export list, bar and dialog to Moxfield | `src/lib/export/list.ts` (`useExportList`), `src/lib/export/ui/ExportBar.tsx`, `ExportDialog.tsx`, used as in `ComparisonPage.tsx` |
| Export item shape | `ExportItem` in `src/lib/export/types.ts` (set, number, finish, language, quantity, Scryfall id; `cardId` can stay empty: Moxfield's CSV import finds the print by set and number) |
| The owned prints | Dexie table `collectionEntries` (the account's collection snapshot) |
| Menu entry, route | `src/entrypoints/dashboard/Layout.tsx` (*Collection* section), `src/entrypoints/dashboard/main.tsx` |
| Stored data listing and clearing | `src/features/settings/stored-data.ts` |
| Language badge, card thumbnails | `src/lib/ui/LangBadge.tsx`, `src/lib/ui/CardThumb.tsx` |
| Scryfall picture URL from an id | `src/lib/f2f/links.ts` (`scryfallImage`) |

**Done when:**
- a real photo goes through to a test binder on Moxfield, checked on Moxfield;
- `npm run typecheck` and `npm test` pass.

**Tokens:** about 250–400k output, 3–6M cache writes, 80–150M cache reads (≈ $40–70).

**Later idea:** start a Selling run (F2F buy prices) from a scanned list.

---

## Phase 3 — The bottom line

**Goal:** tell same-art reprints apart, and read the language.

**Why:**
- All 4 wrong prints with the right name on today's test photos are same-art reprints:
  - Bonders' Enclave OTC against M3C (twice);
  - Sakura-Tribe Elder M3C against MKC;
  - Path of Ancestry CMM against M3C.
- The right print scored within 0.002–0.016 of the wrong one, so the picture can't tell them apart.
- Among every print (phase 1) there are more of them.

**What the cards carry:**
- Since 2014, the number, rarity, set code and language at the bottom left (e.g. `0123 R · MH3 · EN`; 2014–2022 cards print `123/269 R` over `M15 · EN`).
- Cards from 2003–2014 carry a number only, and cards before 1998 none.

**How:**
- **When:** only when the best match has same-art reprints (several prints share its `illustration_id`), or to read the language.
- **Reading:**
  - re-cut that corner from the full-resolution photo at about 3× scale, sharpen and binarize it;
  - read it with Tesseract.js (bundled: no remote code), limited to the characters that can appear there;
  - parse number, rarity, set code and language (EN FR DE IT ES PT JA KO RU ZHS ZHT PH…), then pick the reprint whose set and number match.
- **Showing it:** the row says what was read (e.g. "read MH3 · 0123 · EN"), so the user sees why a print was chosen.
- **Small cards:** a card too small to read (under about 700 px tall) falls back to the print picker.

**Done when:** print accuracy is measured before and after, on the test photos (offline with `evaluate` and on the page), modern cards apart.

**Tokens:** about 100–200k output, 1–3M cache writes, 30–60M cache reads (≈ $15–30).

---

## Open decisions, in one place
1. ~~Phase 1: where the public files live~~: Hugging Face (2026-11-23).
2. ~~Phase 1: licences and Scryfall's terms~~: read 2026-11-23 (`SCANNER_DEV.md` section 7); the model card says where everything comes from.
3. ~~Phase 1: what to match against~~: every print, "only my prints" as a filter, no tie-breaker.
4. **Phase 2:** the default language of scanned cards.
5. **Phase 2:** keep or drop the classic detection passes.
6. **Optional, any time:** a Claude vision second opinion on low-confidence cards, with the user's own API key (photos would leave the browser, and it costs per photo). Not planned.

**Prices** used above: Opus 5.5 list prices, $20 per million output tokens, $5 per million cache writes, $0.20 per million cache reads. Actual billing depends on the plan.
