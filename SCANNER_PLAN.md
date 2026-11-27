# Scanner — what's left

What's built and how it works: `SCANNER_DEV.md`. The Scanner is done and in the menu (*Collection → Scanner*). This file lists the improvements left, most useful first; none is urgent.

**Starting a fresh session:**
1. Read `SCANNER_DEV.md` section 1 (where it stands), then "Remaining work" below.
2. In the trainer repo (`tithies-scanner-trainer`, cloned next to this one), run `git pull`. `models/README.md` lists the model versions and their scores; its README has every command.
3. **Working rules:**
   - Commits go on master, with the neutral identity. The user pushes; a push of this repo is a release.
   - Another session may be working in this repo: commit only the files you changed.
   - No machine paths, logins or personal details in any file, commit or log.
   - Training runs on the user's Windows PC: I prepare the code and the commands, they run them and push `models/vN` (`python -m trainer release vN`).
   - The print and language rules live in two places that must agree: the page (`print-check.ts`, `language.ts`) and the trainer (`trainer/verify.py`). Change both, run `python -m trainer verify fixture --out ../tithies/tests/fixtures/scanner-check` and `npm test`, then measure (`SCANNER_DEV.md` section 5).
   - The user's Chrome is live: the scan session and the label drafts there are theirs. Read stored data before changing any of it, test with your own photos, and remove only those.
4. **Plan mode first** for any big step below, with its open decisions asked before building.

---

## Done

- **Phase 1 — every print** (2026-11-23 to 26): the every-print index on Hugging Face (`tithies/card-scanner`), refreshed daily by the trainer's GitHub Actions job. The page downloads index-only updates by itself.
  - **Decided with the user:**
    - Hugging Face hosts the files (a `tithies` account, neutral e-mail);
    - the index carries the print list;
    - every print by default, with "only my prints" as a filter, no tie-breaker;
    - cards only: no tokens, emblems or art series;
    - the daily refresh stops when names drop or more than 2,000 rows change.
- **Phase 3 — same-art reprints and the language** (2026-11-25 to 27): prints **76.4 % → 91.0 %** on the test photos, names unchanged; the language read from the card's own text.
  - **Decided with the user:**
    - the print from both the bottom line's text and a visual check;
    - the language from the card's own words (name, type line, rules text, not only the bottom line's code: the user's idea), plus the printed-name lookup.
  - **Decided while measuring:** the bottom line's code doesn't decide before the words. Deciding it first would save about 0.15 s a card, but then a misread code would decide alone.
- **Phase 2 — the Scanner page** (2026-11-27):
  - photos in, rows first and checks after, the user's corrections;
  - the export through the existing dialog, checked with a real export to a private test binder;
  - the scan kept until "Clear scan";
  - the prototype became the developer page.
  - **Decided with the user:**
    - English when nothing is read;
    - the classic detection passes and pHash deleted;
    - the table is the export list;
    - how cards are taken is a selector: "Read each card" (the default) or "All in <language>" (nothing read);
    - pending cards in violet with a spinning ring;
    - "Clear scan" stops everything at any time.

---

## Remaining work

### 1. Speed of the check

**Today**, in the user's Chrome, the check takes 3.2 s per card on average (median 1.7 s). A 6-card photo takes 33 s with it, against 6.4 s for finding and naming alone. The rows show before the checks, so the wait is mostly while reviewing.

Where the time goes:
- **the visual check, 46 %:**
  - 4.2 s each, on the 80 of 233 cards that needed it; up to 23 s with 6 pictures;
  - 65 % of it is OpenCV.js's ECC alignments, single-threaded: 21 of them with 6 pictures (the cut-out onto each picture, and each pair of pictures).
- **the first Latin reading, 29 %;** the text detection 14 %; the later readings for the language 6 %. These run on the GPU, and the OCR model itself is what's slow, so there's no cheap gain there.

**The options** (they can be combined):
- **A. The visual check in 3–4 Web Workers,** each with its own OpenCV.js, started by the sandboxed engine.
  - The same results; that step about 3 times faster, so a photo goes from about 33 s to about 26 s.
  - Medium work. Check first that the sandboxed page (an opaque origin) can start workers.
- **B. The candidates' pictures aligned onto one of them,** instead of pair by pair: 11 alignments instead of 21 with 6 pictures.
  - The results change slightly: measured again in the trainer (about an hour).
- **C. At most 4 pictures instead of 6:** about twice as fast on the slowest cards.
  - The right print could be 5th or 6th and get missed: measured again.
- **D. Keep scanning while on other dashboard pages.** Today, leaving the Scanner page closes its engine, and the work pauses until you come back.
  - The engine and the job runner would move to the dashboard's layout, started on the first visit to the Scanner.
  - Medium work. The models stay loaded (GPU memory) while the dashboard is open.

### 2. Prints the check still misses

- **Promo stamps and The List:** 8 of the 11 prints still wrong on the test photos are promo-stamped prints or The List's prints, which the visual check keeps as the regular one. If they matter, the next step is a trained same-art verifier at high resolution, on the PC (its own plan).
- **Small cards:** under about 400 px tall, the number can be misread (Artisan of Kozilek at 318 px went wrong). A minimum card height for reading would keep the search's choice there; measured again in the trainer.

### 3. The Scanner page

1. **One row per print with a quantity:** today it's one row per card, each tied to its outline, and the export merges the same print, finish and language. A grouped view would help with big scans of duplicates.
2. **Several scan sessions,** named (say, one per binder): today there's one, until "Clear scan".
3. **The index status in Settings** (version, date, size, "Check for update"): today it's on the Scanner page, and the files' size in Settings → Stored data.
4. **A Selling run from a scanned list** (F2F buy prices).
5. **The website** (`site/`) doesn't mention the Scanner yet; the user updates it.

### 4. Measurements and models

- **Real foreign photos:** the languages were measured on Scryfall's foreign pictures "photographed" in generated scenes. Photos of some of the user's 13 foreign cards (8 French, 4 Japanese, 1 German), labelled as usual, would check them on real ones.
- **v3 models,** only if new labelled photos show weak spots worth training on. Today's misses are cards mostly covered by others (1 missed, 3 wrong names). v2's PyTorch weights are in `models/v2`, so `--from v2` works.
- **The developer page's "Method shown"** still defaults to the search alone, so its top 5 hides the check's pick (the scores table shows both). One line.

### 5. Ideas, not planned

- A Claude vision second opinion on low-confidence cards, with the user's own API key. Photos would leave the browser, and it costs per photo.

---

## Open decisions

1. **Speed:** which of options A–D (section 1), if any.
2. **Promo and List prints:** whether they're worth a trained verifier (section 2).

**Prices** for token estimates: Opus 5.5 list prices, $20 per million output tokens, $5 per million cache writes, $0.20 per million cache reads. Actual billing depends on the plan.
