# Scanner — what's left

What's built and how it works: `SCANNER_DEV.md`. This file is what's left, most important first. Phases 1, 2 and 3 are done: the Scanner is in the menu (*Collection → Scanner*). What's left is improvements, none urgent.

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
4. **Plan mode first** for any big step below, with its open decisions asked before building.

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

**Phase 2 — the Scanner page** (2026-11-27):
- *Collection → Scanner*:
  - photos in (pick or drop);
  - one row per card, its rows shown once named, its print and language checked after;
  - the user's corrections: print picker, language, finish, "Not a card", outlines, missed cards;
  - the cards exported through the existing export dialog;
  - the scan kept in IndexedDB until "Clear scan".
- Checked in the user's Chrome: a real export to a private test binder, all 18 copies verified by the export's own check.
- **Decided with the user:**
  - English when the text says nothing;
  - the classic detection passes and pHash deleted;
  - "Check prints and languages" as a switch, on by default;
  - the table is the export list.
- The prototype is the developer page, `#/collection/scanner/dev`.

---

## Remaining work

### 1. Scanner page follow-ups (optional)

1. **Speed:** see 2.1. The rows already show before the checks, so the wait is mostly while reviewing.
2. **One row per print with a quantity:** today it's one row per card (each tied to its outline), and the export merges the same print, finish and language. A grouped view would help with big scans of duplicates.
3. **Several scan sessions,** named (one per binder page batch, say). Today there's one, until "Clear scan".
4. **Index status in Settings** (version, date, size, "Check for update"): today it's on the Scanner page only, with the files' size in Stored data.
5. **The website** (`site/`) doesn't mention the Scanner yet; the user updates it.
6. **A Selling run from a scanned list** (F2F buy prices), see 4.

### 2. Phase 3 follow-ups (optional, any order)

1. **Speed of the check:** 3.2 s per card (33 s per 6-card photo, against 6.4 s without it). The visual check is 46 % of it, and 65 % of that is OpenCV.js's ECC alignments. The options, cheapest first:
   - **The visual check in 3–4 Web Workers,** each with its own OpenCV.js, started by the sandboxed engine. The same results, that step about 3 times faster: about a third of the checking time saved. Medium work.
   - **The candidates' pictures aligned onto one of them,** instead of pair by pair: 11 alignments instead of 21 with 6 pictures. The results change slightly: measured again in the trainer.
   - **At most 4 pictures instead of 6:** about twice as fast there. Measured again in the trainer.
2. **Promo stamps and The List:** 8 of the 11 prints still wrong are stamped promos or The List's prints, which the visual check keeps as the regular print. If they matter, the next step is a trained same-art verifier at high resolution, on the PC (its own plan).
3. **Small cards:** under about 400 px the number can be misread; Artisan of Kozilek at 318 px went wrong. A minimum card height for reading would keep the search's choice there. Measured again in the trainer.
4. **Real foreign photos:** the languages were measured on Scryfall's foreign pictures "photographed" in generated scenes. Photos of some of the user's 13 foreign cards (8 French, 4 Japanese, 1 German), labelled as usual, would check them on real ones.
5. **The developer page's "Method shown"** still defaults to the search alone ("DINOv2 padded · CLS"), so its top 5 hides the check's pick. One line.

### 3. Models (optional)

- **v3**, only if new labelled photos show weak spots worth training on. Today's misses are cards mostly covered by others: Marchesa in a fanned hand missed, 2 wrong names. v2's PyTorch weights are in `models/v2`, so `--from v2` works.

### 4. Later ideas

- Start a Selling run (F2F buy prices) from a scanned list.
- A Claude vision second opinion on low-confidence cards, with the user's own API key. Photos would leave the browser, and it costs per photo. Not planned.

---

## Open decisions

1. ~~Phase 2: the language of cards whose text says nothing~~: English (2026-11-27).
2. ~~Phase 2: the classic detection passes~~: deleted, with the pHash baseline (2026-11-27).
3. ~~Phase 2: can the check be turned off~~: yes, "Check prints and languages", on by default (2026-11-27).
4. **Phase 3 follow-ups:** which speed option, if any, and whether promo and List prints are worth a trained verifier.

**Prices** used above: Opus 5.5 list prices, $20 per million output tokens, $5 per million cache writes, $0.20 per million cache reads. Actual billing depends on the plan.
