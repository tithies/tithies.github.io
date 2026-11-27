# Scanner — what's left

What's built and how it works: `SCANNER_DEV.md`. This file is what's left, most important first. Phases 1 and 3 are done; **phase 2, the real Scanner page, is next.**

**Starting a fresh session:**
1. Read `SCANNER_DEV.md` section 1 (where it stands), then "Remaining work" below.
2. In the trainer repo (`tithies-scanner-trainer`, cloned next to this one), run `git pull`. `models/README.md` lists the model versions and their scores. Its README has every command.
3. **Working rules:**
   - Commits go on master, with the neutral identity. The user pushes; a push of this repo is a release.
   - Another session may be working in this repo: commit only the files you changed.
   - No machine paths, logins or personal details in any file, commit or log.
   - Training runs on the user's Windows PC: I prepare the code and the commands, they run them and push `models/vN` (`python -m trainer release vN`).
   - The print and language rules live in two places that must agree: the page (`print-check.ts`, `language.ts`) and the trainer (`trainer/verify.py`). Change both, run `python -m trainer verify fixture --out ../tithies/tests/fixtures/scanner-check` and `npm test`, then measure with `verify prints` (`SCANNER_DEV.md` section 5).
   - The user's Chrome is live: read the Scanner's stored data (label drafts, installed files) before changing any of it.
4. **Plan mode first** for phase 2, with the open decisions below asked before building.

---

## Done

**Phase 1 — every print** (2026-11-23 to 26):
- The every-print index is on Hugging Face (`tithies/card-scanner`). The trainer's daily GitHub Actions job keeps it current, and the page downloads index-only updates by itself.
- On the test photos: names 98.0 %, prints 76.4 %; the page gives the trainer's numbers.
- **Decided with the user:**
  - Hugging Face hosts the files, under a `tithies` account with a neutral e-mail;
  - the index carries the print list;
  - every print by default, with "only my prints" as a filter and no tie-breaker;
  - cards only: no tokens, emblems or art series;
  - the daily refresh stops when names drop or more than 2,000 rows change.

**Phase 3 — same-art reprints and the language** (2026-11-25 to 27):
- On the test photos, against every print: prints **76.4 % → 91.0 %** (152 → 181 of 199), names unchanged. The page gives the trainer's numbers.
- The language is read from the card's own words, its script, the bottom line's code and its printed name. None of the 509 labelled English cards reads as another language.
- **Decided with the user:**
  - the print from both the bottom line's text and a visual check;
  - the language from the card's own text: name, type line, rules text, not only the bottom line's code (the user's idea), plus the printed-name lookup.
- **Decided while measuring:** the bottom line's code doesn't decide before the words. Deciding it first would save about 0.15 s a card, but then a misread code would decide alone.

---

## Remaining work

### 1. Phase 2 — the Scanner page (next)

**Goal:** the whole flow works: photos in, list corrected, cards added to the Moxfield collection or a binder.

**Processing:**
- Photos are queued one after another, with progress for each, and the page stays responsive (the engine already runs in a sandboxed iframe).
- WebGPU when available, WASM otherwise.
- **The print and language check** (phase 3) takes about 3.2 s per card, against under 1 s to find and name it. So a row appears as soon as the card is named, and its check fills in afterwards, while the user reviews the rows already done.

**Page** *Collection → Scanner* (`/collection/scanner`, in the menu):
- **Photo view:** outlines coloured green (sure), orange (needs review) or red (unknown), numbered. Clicking an outline highlights its row, and the other way round. The prototype's `PhotoView` and `CardsTable` are the start.
- **Table:**
  - the cut-out next to the matched card's picture, then name, set, number, language, finish, quantity, confidence;
  - the print and language come from the card's `check` (`scanner-check.ts`), with how they were found (e.g. "read 0216 TDC");
  - a print the check marks "unsure" is orange;
  - the same print can merge into one row with a quantity.
- **Corrections:**
  - "Pick print": the check's candidates first (same-art prints), then every print of that name with pictures. The labelling mode's `PrintPicker` is the start.
  - "Not a card" removes a row.
  - "Missed card": click its 4 corners, as in the labelling mode, and it's named and checked.
  - The language can be changed per row.
- **Defaults:**
  - finish non-foil, set automatically for foil-only or etched-only prints;
  - language as phase 3 read it. When nothing was read it's English for now (decision 1 below).

**Keeping the work:** the scan session (photos, outlines, checks, corrections) stays in IndexedDB until cleared, so a reload doesn't lose 20 photos' worth of fixes. It's listed under *Settings → Stored data* and removed by *Remove all data*.

**Export:**
- Rows become `ExportItem`s (note "Scanned") and go through the existing export list, bar and dialog, as on the Comparator.
- Moxfield's import finds each print by set and number; the Language field carries the language.

**Also:**
- **The prototype's tools** (labelling mode, scores table, methods, "Copy results JSON", debug layers) move to a developer view that stays hidden. OpenCV.js is still needed to flatten the cards.
- **Settings:** index status (version, date, size, update now), backend in use.
- **Tests (vitest):** rows to export items, merging and quantities, the stored session, the corrections.
- **README:** a *Scanner* section. The website is updated separately by the user.

**Code to reuse:**

| Need | Where |
|---|---|
| Export list, bar and dialog to Moxfield | `src/lib/export/list.ts` (`useExportList`), `src/lib/export/ui/ExportBar.tsx`, `ExportDialog.tsx`, used as in `ComparisonPage.tsx` |
| Export item shape | `ExportItem` in `src/lib/export/types.ts` (set, number, finish, language, quantity, Scryfall id; `cardId` can stay empty: Moxfield's CSV import finds the print by set and number) |
| The owned prints | Dexie table `collectionEntries` (the account's collection snapshot) |
| A card's print and language check | `checkCard` in `src/features/scanner/scanner-check.ts`, as `scanPhoto` calls it in `pipeline.ts` |
| Menu entry, route | `src/entrypoints/dashboard/Layout.tsx` (*Collection* section), `src/entrypoints/dashboard/main.tsx` |
| Stored data listing and clearing | `src/features/settings/stored-data.ts` |
| Language badge, card thumbnails | `src/lib/ui/LangBadge.tsx`, `src/lib/ui/CardThumb.tsx` |
| Scryfall picture URL from an id | `src/lib/f2f/links.ts` (`scryfallImage`) |

**Done when:**
- a real photo goes through to a test binder on Moxfield, checked on Moxfield;
- `npm run typecheck` and `npm test` pass.

**Tokens:** about 250–400k output, 3–6M cache writes, 80–150M cache reads (≈ $40–70).

### 2. Phase 3 follow-ups (optional, any order)

1. **Speed of the check:** 3.2 s per card (33 s per 6-card photo, against 6.4 s without it). The visual check is 46 % of it, and 65 % of that is OpenCV.js's ECC alignments. The options, cheapest first:
   - **The visual check in 3–4 Web Workers,** each with its own OpenCV.js, started by the sandboxed engine. The same results, that step about 3 times faster: about a third of the checking time saved. Medium work.
   - **The candidates' pictures aligned onto one of them,** instead of pair by pair: 11 alignments instead of 21 with 6 pictures. The results change slightly: measured again in the trainer.
   - **At most 4 pictures instead of 6:** about twice as fast there. Measured again in the trainer.
2. **Promo stamps and The List:** 8 of the 11 prints still wrong are stamped promos or The List's prints, which the visual check keeps as the regular print. If they matter, the next step is a trained same-art verifier at high resolution, on the PC (its own plan).
3. **Small cards:** under about 400 px the number can be misread; Artisan of Kozilek at 318 px went wrong. A minimum card height for reading would keep the search's choice there. Measured again in the trainer.
4. **Real foreign photos:** the languages were measured on Scryfall's foreign pictures "photographed" in generated scenes. Photos of some of the user's 13 foreign cards (8 French, 4 Japanese, 1 German), labelled as usual, would check them on real ones.
5. **The prototype's "Method shown"** still defaults to the search alone ("DINOv2 padded · CLS"), so its top 5 hides the check's pick. One line, if the prototype stays in use before phase 2.

### 3. Models (optional)

- **v3**, only if new labelled photos show weak spots worth training on. Today's misses are cards mostly covered by others: Marchesa in a fanned hand missed, 2 wrong names. v2's PyTorch weights are in `models/v2`, so `--from v2` works.

### 4. Later ideas

- Start a Selling run (F2F buy prices) from a scanned list.
- A Claude vision second opinion on low-confidence cards, with the user's own API key. Photos would leave the browser, and it costs per photo. Not planned.

---

## Open decisions

1. **Phase 2:** the language of scanned cards whose text says nothing: English, or the collection's usual language.
2. **Phase 2:** keep or drop the classic detection passes (contours, lines, binder grid).
3. **Phase 2:** whether the print and language check can be turned off on the real page (it's most of the time per card).
4. **Phase 3 follow-ups:** which speed option, if any, and whether promo and List prints are worth a trained verifier.

**Prices** used above: Opus 5.5 list prices, $20 per million output tokens, $5 per million cache writes, $0.20 per million cache reads. Actual billing depends on the plan.
