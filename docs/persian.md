# Persian writing guide

Signal writes Persian for short vertical videos and Instagram captions in **Tehrani colloquial** written as
*shekaste-nevisi*, with a pronunciation layer so voices read every line the way a person would. There is no official
standard for written colloquial Persian, so this is a **house style**: versioned, and changed by the person who owns
the project's Persian (see [Sign-off](#sign-off)).

The code lives in `lib/studio/lang/fa/` (normaliser, linter, tokenizer, number words, pronunciation, projection,
line breaks, hashtags, listening-test scoring, mouth shapes). Its word lists live in `lib/studio/lang/fa/data/*.json`;
a project pack adds its own lexicon, glossary and house style ([project-pack-format.md](project-pack-format.md#9-persian-layer)).
The linter and normaliser report by rule id (for example `SK-R3`, `N-05`, `Z03`, `LB-2`), and a pack can switch a
lint rule off in its house style.

Every form below is a **proposal** until the owner, or a reader they name, confirms it.

## Registers

| Register | Used for | Rule |
|---|---|---|
| `colloquial` (default) | Narration, dialogue, speech bubbles, stickers, kinetic captions, the caption body, comment replies | Tehrani colloquial in shekaste spelling; one register per sentence |
| `neutral` | CTA pills, taglines, sub-lines, labels on cards | Words that are the same in both registers: imperatives («نصب کن»), noun phrases; no «است», no «را», no colloquial-only verb forms |
| `formal` | Store and legal lines, price conditions, contest rules, the AI-disclosure label, quotations | Standard orthography; the colloquial lint is off |

**Address mode** is a pack setting: `faAddress: to` (informal singular, the default) or `shoma`. With `shoma`,
colloquial verbs take «ـین» («نصب کنین») and formal text takes «ـید».

Fixed surfaces: brand, product and character names use the glossary spelling; the AI-disclosure label is a fixed
string («ساخته‌شده با هوش مصنوعی» / "Made with AI") that no agent rewrites; quotations stay verbatim.

## Shekaste spelling (summary)

| Area | House form |
|---|---|
| Verbs | Colloquial stems («می‌خوام»، «می‌گم»، «می‌رم»، «می‌دم»، «می‌شم»، «می‌تونم»); آمدن/آوردن written solid («میام»، «میاد»، «میارم»); no future auxiliary (present plus a time word); 2nd person plural «ـین» |
| Copula | «خوبه»، «عالیه»، «کجاست»، «پایه‌ست»، «توئه»، «خوبن» |
| Clitics | «خاله‌م» after a silent ه; «گوشیم» after ی; «بهم»، «بهت»، «بهش»، «ازش»، «باهاش»; «منم»، «اینم» |
| Object marker | «ـو» after a pronoun («منو»، «اینو»), «رو» after a noun; «تو رو», never «تورو» |
| /ān/ → /un/ | Only on an allow-list («خونه»، «نون»، «جون»، «اون»، «مهمونی»، «بارون»، «آسمون»…); never on «ایران»، «داستان»، «زمان»، «قهرمان» or proper nouns |
| Plurals | «ها» kept in writing; spoken «ـا» only on the allow-list («اینا»، «اونا») |
| Formal words in colloquial text | Refused: «آیا»، «می‌باشد»، «گردید»، «نمود»، «لذا»، «جهت»، «کلیه»… |
| Neutral surfaces | Refuse colloquial-only words: «دیگه»، «رو»، «یه»، «اینو»، «واسه»… |

Tone: warm, quick and concrete. A narrated sentence has at most 8 words; a caption page 3-5. Humour comes from the
situation, never from insults, ethnicity, accents, religion, politics or bodies. Kinship words («خاله‌جون»،
«مامان‌بزرگ») are welcome and are not translated literally. At most one «!» per sentence and two per caption page.
No claim the pack's claims policy does not allow.

## Orthography (the normaliser)

`normalizeFa` runs in a fixed order and is idempotent:

- **Characters:** Arabic ي and ك become ی and ک; Arabic digits and Latin digits in Persian text become Persian
  digits; stray tatweel, double spaces and invisible marks are cleaned; a zero-width space becomes a ZWNJ between two
  letters and is removed elsewhere.
- **ZWNJ (half-space):** after «می»/«نمی»; before «ها» after a joining letter (with listed exceptions: «تنها»، «رها»…);
  before «تر»/«ترین» only after listed adjectives («بهتر»، «بیشتر»، «کمتر» stay solid); between a silent ه and its
  clitic; in the listed prefix compounds («بی‌نظیر»، «هم‌بازی») and compounds («مامان‌بزرگ»، «ساخته‌شده»).
- **Ezafe after a silent ه** is written «ه‌ی» in video and social text (a pack can choose the hamza form instead).
- **Diacritics** are not shown on screen, except tanvin after alef and on a «…» callout word.
- **Numbers:** small numbers (1-9) as words in colloquial captions and bubbles; digits for 10 and up, prices, dates
  and stats. No thousands separator below 10,000; «٬» above. Codes and phone numbers are never regrouped.
- **Mixed runs:** a Latin word inside Persian text is allowed only from the glossary (a brand or product name), and is
  isolated in its own direction run.

## Line length and breaks

On a 1080 × 1920 canvas the text box is 960 px wide; Persian type is about 1.1 × the English size. Character counts
are warnings; the real check renders the line in the bundled font and measures it.

| Slot | Max lines | Max characters per line | Max words per page |
|---|---|---|---|
| Kinetic caption | 2 | 22 | 5 |
| Hook headline | 2 | 14 | 4 |
| Speech bubble | 3 | 18 | 9 |
| Sticker word | 1 | 14 | 3 |
| End-card tagline | 1 | 20 | 4 |
| CTA pill | 1 | 16 | 3 |

Break after «،» or «؛», or before «و»، «ولی»، «که»، «تا». Never split an ezafe chain («خونه‌ی مامان‌بزرگ»), a
preposition from its object, or a number from its unit («۵ تا»). No one-word last line; the shorter line is at least
60 % of the longer. Never start a line with punctuation. Text that is not narrated stays on screen at least 0.40 s per
word plus 0.3 s.

## Emoji and hashtags

- Emoji never sit inside a narrated line (a sticker layer instead) and are always removed from the pronunciation.
  At most one per caption page, at the end of the line; at most three per caption language block.
- Hashtags: at most 5 per post, at most 3 Persian; Persian multi-word tags join with «_» («#بازی_فکری»); **no ZWNJ
  inside a hashtag** (the builder joins the letters, or asks when the ZWNJ follows a silent ه); no digits in Persian
  tags; English tags in CamelCase; hashtags last, in their own paragraph. Platform rules are volatile and unverified:
  check them before relying on them.

## Pronunciation layer

Persian omits short vowels and the ezafe, so one spelling can have several readings. Signal keeps three texts for
every narrated line:

| Text | What it is | Who edits it |
|---|---|---|
| `display` | What is on screen: normalised, Persian digits, brand in its own script | The script writer, then the Persian reader |
| `pron` | The canonical pronunciation: numbers, dates, prices and symbols as spoken words; brands and loanwords respelled; the ezafe marked at every junction; short vowels on every homograph, loanword and unknown word; emoji, hashtags and links removed. Plus `roman`, a house transliteration | Built by rules and the language agent; approved by the Persian reader |
| `tts` | What a voice service receives: `project(pron, voice profile)` | Nobody: derived, never edited |

**Marks in `pron`:** kasra on the last letter for an ezafe («فالِ حافظ»), «ه‌یِ» after a silent ه, «یِ» after ا/و;
fatha, kasra and damma where a reading needs them («می‌بُره» cuts versus «می‌بَره» takes); shadda for gemination.

**Rules (examples):** colloquial number words («۱۵» → «پونزده», «۱۴» → «چارده», «۱۸» → «هیجده»); years in full words,
never digit by digit; dates as day + ezafe + month («۳۰ آذر» → «سیِ آذَر»); colloquial times («۱۰:۳۰» → «دَه و نیم»);
«تومَن» in colloquial lines; acronyms as Persian letter names («AI» → «اِی‌آی»); loanwords as Iranians say them, with
«اِ» before an initial s-cluster («استوری» → «اِستوری»); and the Persian word where it is natural («مرحله» rather than
«لول»). No Latin letter may remain in a Persian `pron`.

**Roman:** a, aa, e, o, i, u, kh, gh, sh, ch, zh, j, y, `'` for a glottal stop, `-e`/`-ye` for the ezafe, a hyphen
before a clitic, and an uppercase syllable only for non-default stress (a vocative). It makes the pronunciation
checkable by people who do not read Persian.

**How a line is built:** normalise and lint `display`; tokenize; a deterministic pass for numbers, dates, names,
lexicon matches and unambiguous homographs; then the language agent proposes only a patch (which span gets an ezafe,
which reading, which vowels), never free text. The sync rule must hold: removing the marks from `pron` gives `display`
back for every marked span. A patch that breaks it is refused; after one retry the span goes to the reader. A homograph
no rule decides is flagged for the reader.

**Voice projection** (per voice, set by the listening test): `diacritics` (all, homographs, none), `ezafe` (kasra or
as displayed), `conjO` (the colloquial «و» read /o/ attached), `zwnj` (keep or space) and `ipaInline`.

## Sign-off

Two human gates apply to every Persian line, both by a **named person**: the owner, or a reader they name.

- **Text gate** (after the narration text): the meaning is right and sounds like Tehrani speech, not a translation;
  one register per sentence; the linter shows no errors (any override has a reason); spelling, ZWNJ, ezafe and digits
  are right; every ezafe and homograph reading in `pron` is right; numbers read as a person would say them; names
  match the glossary; `roman` matches how the reader would say it; line breaks and tone rules are met.
- **Listening gate** (after the voice): Tehrani pronunciation; the colloquial endings are audible and not "corrected"
  back to formal; every ezafe is spoken and none added; homographs, numbers, names and acronyms are read as `roman`
  says; stress on the stem's last syllable (vocatives first); questions rise or fall correctly; natural pace; the
  emotion fits the beat.

A sign-off is bound to the exact version the reader saw, so an edit or a regenerate leaves the new version unsigned.
Agents never sign, and mock runs reach Proof with both gates unsigned: a clean Accept needs both signatures on the
current versions; Accept as draft does not. A failed listening item becomes a proposed lexicon entry or a `pron` fix,
and only that line is made again.

## Listening test

Before a Persian voice makes clean proofs, its model and projection settings are chosen by a listening test, and
re-checked after any change to the model, voice, lexicon or projection. The corpus is generic and ships with Signal
(`lib/studio/lang/fa/data/listening-set.json`, 60 items: homographs, ezafe chains, numbers and dates, loanwords and
acronyms, colloquial verbs, questions, long mixed lines); a pack can add its own names.

1. At least three native Tehrani-colloquial listeners, at least one who did not write the corpus; takes normalised
   to the same loudness, played in a blind random order.
2. For each item: mark each target word right or wrong against `roman`; rate naturalness 1-5; and compare pairs of
   conditions A/B.
3. A condition is eligible with at least 98 % target accuracy overall, 100 % on numbers and names, 95 % on ezafe, and
   a mean naturalness of at least 4.0. Among eligible ones, the most accurate wins; on a near tie, the more natural;
   then the simpler projection. Diacritics are kept only when they measurably help.
4. The chosen settings are written to the voice profile (`lockedBy`, `lockedAt`, `testId`), and the result to
   `<pack>/lexicon/listening/<testId>.json`.

The scoring, the harness and the screens run offline on mock voices; a real test needs a voice service switched on,
its key, and the listeners.

## Two languages

Plan once, then write natively in each language: the English line is not a translation of the Persian one (an
offline check flags lines that read as word-for-word glosses). Each language gets its own package and its own caption
by default. Timing comes from each language's own narration; Persian narration runs at about 2.6 words per second
until a voice's measured rate replaces it.

## Changing the house style

A changed form is a data or settings change, never a one-off edit to a line:

- core word lists: `lib/studio/lang/fa/data/*.json` (verb stems, ZWNJ exceptions, compounds, prefix compounds,
  adjectives, silent-ه words, the shift allow-list, the formal deny-list, common misspellings, the core lexicon);
- per project: the pack's `lexicon/fa.json`, `glossary.json` and `style/fa.md` front matter (`faAddress`,
  `ezafeAfterHeh`, `smallNumbers`, `disabledRules`, `allowWords`).

Run `npm test` after a change: the Persian fixtures (`tests/unit/fa-*.test.ts`) pin the normaliser, the linter, the
number words and the pronunciation rules.
