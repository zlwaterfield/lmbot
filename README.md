# lmbot

Auto-categorizes [Lunch Money](https://lunchmoney.app) transactions, and finds duplicates.

Built on the [Lunch Money v2 API](https://lunchmoney.dev/v2/docs). Every command that
writes is **dry-run by default** — you always see the table before anything changes.

## Setup

```bash
npm install
cp .env.example .env       # add your Lunch Money token
cp rules.example.json data/rules.json
```

`LUNCH_MONEY_TOKEN` comes from <https://my.lunchmoney.app/developers>.
`ANTHROPIC_API_KEY` is optional — without it, run with `--no-llm` and the first two
tiers still work offline.

## The first run

```bash
lmbot learn --year 2025            # teach it from your own history
lmbot categorize --month 2026-08   # preview
lmbot categorize --month 2026-08 --apply
lmbot confirm --month 2026-08 --apply     # clear the rest of the review queue
```

`learn` matters more than it looks. It reads transactions you already categorized and
builds a payee→category map from *your* habits, so most of your recurring merchants get
categorized without an LLM call ever happening.

## How a transaction gets categorized

Three tiers. Each one only sees what the tier above it couldn't answer, so the expensive
tier runs on the smallest possible set.

| Tier | Source | Cost | Confidence |
|---|---|---|---|
| **rules** | your regexes in `data/rules.json` | free | 1.0 — always wins |
| **memory** | learned from your own categorization history | free | 0.8–0.99, scaled by how consistently you've categorized that payee |
| **llm** | Claude, given your category list minus import defaults | ~cheap | whatever the model reports |

Anything landing below `--min-confidence` (default 0.7) is left alone rather than guessed at.

**Location stripping.** A city identifies where you were, not who you paid, and leaving it
in the key breaks matching twice over: the same merchant in two branches gets two entries,
while two unrelated merchants in one neighbourhood look nearly identical. `nodo leslieville
toronto` and `woof gang leslieville toronto` share two of three tokens despite being a
restaurant and a dog groomer.

`learn` infers which tokens are locations from your own data — a merchant name appears in
one key, a city appears in dozens — so it works for any country without a hardcoded list.
The first token is never stripped, since that is the merchant name even when it is also a
place (`toronto parking authority` survives intact). Real effect on one account:

```
"shoppers drug mart" <- "shoppers drug mart etobicoke" + "shoppers drug mart toronto"
"winners"            <- "winners etobicoke" + "winners toronto" + "winners toronto on"
"starbucks"          <- "starbucks coffee toronto" + "starbucks" + "starbucks toronto"
```

Two known limits. A city the corpus has **never seen** is not stripped, so that transaction
falls through to the LLM rather than being guessed at — no string rule can tell `winners` →
`winners mississauga` (same merchant, new city) from `amazon` → `amazon web services`
(different merchant), and a wrong category is worse than none. And the inference is
statistical, so it needs a reasonable spread of history before it has signal.

**Payee normalization** is what makes the memory tier work. `SQ *BLUE BOTTLE 4471`,
`BLUE BOTTLE COFFEE #12 OAKLAND CA`, and `TST* BLUE BOTTLE` all collapse to the same key,
so one learned merchant covers every variant your bank throws at it.

**The knowledge base.** Every tier resolves against your live category list, pulled fresh
each run. The LLM gets it as a grouped prompt block with descriptions and income flags, and
any category id it returns that isn't a real, assignable, non-archived leaf is dropped
before it can reach the API. See exactly what the model is told:

```bash
lmbot categories --prompt
```

## Commands

### `categorize` — fill in what's empty

Only touches transactions that are **uncategorized and unreviewed**. Grouped and split
transactions are skipped (the API can't update them).

#### "Uncategorized" includes import defaults

A Plaid sync assigns a category to everything it imports, so *having* a category is not the
same as somebody having categorized it. A transaction sitting in `Payment, Transfer` while
still unreviewed is no more categorized than an empty one, and lmbot treats it that way.

The review flag is the signal of intent: **once you review a transaction, it is left alone**,
placeholder or not.

Find out which categories yours actually land in:

```bash
lmbot categories --usage --last-days 30
```

```
COUNT  CATEGORY           ID  CATEGORIZE TOUCHES IT?
    3  Payment, Transfer  90  yes — placeholder
    1  (uncategorized)     —  yes — no category
    1  Transfer           91  no
    1  Food > Coffee      11  no
```

The built-in list is `Payment, Transfer`, `Uncategorized`, `Unknown`, `Other`,
`General Merchandise`, `General Services`, `Miscellaneous`. It is deliberately short —
a plain `Transfer` category is *not* on it, because that is a perfectly good category
somebody chose on purpose. Override per-run or permanently:

```bash
lmbot categorize --placeholder "Payment, Transfer" --placeholder "Needs Review"
lmbot categorize --no-placeholders          # only a truly empty category counts
cp placeholders.example.json data/placeholders.json
```

Entries match a category name, a `"Group > Name"` path, or a numeric id; naming a group
covers everything in it. A name that matches nothing is reported as a warning rather than
silently ignored.

```bash
lmbot categorize --month 2026-08
lmbot categorize --last-days 30 --apply
lmbot categorize --no-llm --apply            # rules + memory only, no LLM cost
lmbot categorize --month 2026-08 --apply --mark-reviewed
```

#### Marking things reviewed

`--mark-reviewed` marks everything it categorizes. `--auto-review` is the narrower version:
mark reviewed **only where the evidence earns it**.

```bash
lmbot categorize --last-days 30 --auto-review --apply
```

| Tier | Auto-reviewed? |
|---|---|
| **rule** | yes — you wrote the rule, it is already a statement of intent |
| **memory** | only on an exact payee match seen ≥3 times, at ≥0.9 confidence |
| **llm** | no — deferring to the model is exactly the case worth a glance |

The two conditions on memory are doing different jobs. Confidence answers *"is this the
right category?"*; the observation count answers *"how much history is behind that?"* A
payee seen twice and a payee seen fifty times both score 0.99, so confidence alone would
auto-review a coincidence. A fuzzy (non-exact) payee match never auto-reviews, however
often that payee recurs.

Tune with `--auto-review-min`, `--auto-review-observations`, and `--auto-review-llm`.
The dry-run table has a `REVIEWED` column so you can see the split before committing.

To **back-run over history**, add `--include-reviewed` so it also picks up old
uncategorized transactions you already marked reviewed:

```bash
lmbot categorize --year 2024 --include-reviewed --apply
```

### `confirm` — clear the review queue

Lunch Money's own import rules categorize plenty of things correctly on their own:

```
UBER CANADA/UBERTRIP TORONTO, ON   Uber / Lift / Taxi    unreviewed
RBC LIFE INSURANCE CO. MISSI       Health Insurance      unreviewed
TORONTO HYDRO BPY                  Home Utility Bill     unreviewed
```

There is nothing to categorize here — the category is already right — but every one still
sits unreviewed waiting for a human. `confirm` runs the cascade over them and, where an
independent tier reaches the **same** category, marks them reviewed.

```bash
lmbot confirm --last-days 30
lmbot confirm --last-days 30 --apply
lmbot confirm --no-llm --apply           # rules + memory only
```

Every candidate lands in exactly one bucket:

| | |
|---|---|
| **agree**, above the floor | marked reviewed — the agreement is the corroboration |
| **agree**, below the floor | left for you |
| **disagree** | left alone, and pointed at `lmbot audit` |
| no opinion | left for you |

**This command only ever writes `status`.** It never changes a category, however confident
it is — overwriting a category is `audit`'s job and carries a much higher burden of proof.
Import-default categories are skipped: agreeing with a placeholder confirms nothing, and
those belong to `categorize`.

One thing to be aware of: a transaction confirmed here becomes reviewed, and `learn` trusts
reviewed transactions. That is intentional — the category came from your sync's rules and an
independent tier agreed, which is two sources rather than one guess — but if you want a
stricter line, `--no-llm` confirms only from your own rules and history.

### `audit` — find ones it got wrong

The mirror of `confirm`. Both look at transactions that already have a category and run the
cascade over them — `confirm` acts on **agreement**, `audit` acts on **disagreement**.

```
DATE          AMOUNT  PAYEE              CURRENT    SUGGESTED     VIA   CONF
2026-08-10  9.00 CAD  STARBUCKS TORONTO  Groceries  Coffee Shops  rule  100%
```

Its confidence floor is **0.85**, higher than `categorize`'s 0.7, because overwriting a
category destroys a decision you already made — that needs more evidence than filling an
empty one. It is the only command that changes an existing category, so it is also the only
one worth reading line by line before `--apply`.

Import-default categories are skipped: a transaction in `Payment, Transfer` is not
miscategorized, it is uncategorized, and reporting every one as a disagreement would bury
the real findings. No tier can propose an import default as a "correction" either.

```bash
lmbot audit --last-days 90
lmbot audit --year 2025 --include-reviewed
lmbot audit --last-days 90 --apply           # accept the changes
```

### `payees` — align merchant names

Banks emit the same merchant a dozen ways. This collapses them to one name.

```bash
lmbot payees --year 2025
lmbot payees --month 2026-08 --apply
lmbot payees --no-llm --apply            # heuristic only, no LLM cost
```

```
STARBUCKS 8007827282  800-782-7282 ×3 | STARBUCKS STORE 09876 AUSTIN TX ×1  →  Starbucks
SQ *BLUE BOTTLE 4471 ×2 | SQ *BLUE BOTTLE COFFEE 8823 ×1                    →  Blue Bottle
```

It works **per merchant, not per transaction** — you approve `Starbucks` once and every
spelling of it moves. Same cascade shape as categorizing:

| Tier | Source |
|---|---|
| **alias** | a decision you already approved, saved in `data/payees.json` |
| **existing** | a clean name you already typed on some of these transactions |
| **clean** | heuristic: strip phone numbers, store numbers, ref codes, city/state, `SQ *`/`TST*` prefixes, then title-case |
| **llm** | only for clusters still messy after the heuristic |

Clusters are merged by merchant similarity, so `BLUE BOTTLE` and `BLUE BOTTLE COFFEE` become
one entry. The threshold is deliberately conservative — `Amazon` and `Amazon Web Services`
score ~0.48 and stay separate. Tune with `--merge-similarity` (default 0.72).

Two things are never touched: `original_name` (the raw bank descriptor, which the API
treats as read-only) and any name you already typed cleanly. Every approved decision is
saved to `data/payees.json`, so the next run resolves it instantly at the alias tier —
and that file is hand-editable if you want to force a specific name.

### `duplicates` — find and delete repeats

```bash
lmbot duplicates --year 2025
lmbot duplicates --month 2026-08 --delete
```

Groups are classified and only the first two are ever proposed for deletion:

- **exact** — same account, date, amount, and payee.
- **likely** — same account and amount, within `--days-apart` (default 3), similar payee.
- **cross-account** — same amount across *different* accounts. Usually a transfer or a card
  payment, so it's excluded unless you pass `--cross-account`.

Equal-and-opposite pairs across two accounts are detected as transfers and never touched.
Split and grouped transactions are excluded entirely.

Within each group lmbot picks which record to **keep** — preferring reviewed, then
categorized, then the Plaid-synced record over a manual or CSV one — so deleting the rest
loses the least information.

> Deletion is permanent. The API has no undo. lmbot asks for confirmation, and refuses to
> delete at all in a non-TTY unless you pass `--yes`.

### `learn` — rebuild the memory tier

```bash
lmbot learn --year 2025
lmbot learn --min-count 3 --min-share 0.8    # stricter
lmbot learn --dry-run                        # preview without saving
```

`learn` refuses two kinds of input, both for the same reason: neither is evidence of what
*you* do.

1. **Import defaults.** A transaction a sync dropped into `Payment, Transfer` that nobody
   reviewed. Learn from it and the memory tier concludes the placeholder is correct, then
   reproduces it forever.
2. **lmbot's own LLM guesses.** If you `--apply` LLM suggestions and re-run `learn`, the
   tool would promote its own guesses into "what the user does" and repeat them at high
   confidence — laundering a guess into a fact. Journal entries written by the LLM tier are
   quarantined until you review those transactions.

Reviewing a transaction clears both: that is you accepting the category. `--reviewed-only`
is the strict version — learn from nothing else.

```bash
lmbot learn --year 2025 --reviewed-only
```

`learn` applies the same placeholder rule as `categorize`: a transaction a sync dropped
into an import-default category that nobody ever reviewed is **not** learned from. Without
that, the memory tier learns that `Payment, Transfer` is the right answer and then
confidently reproduces it forever. Reviewing such a transaction makes it real signal again —
that is you accepting the category.

A payee is only trusted once it appears `--min-count` times (default 2) *and*
`--min-share` of those agree on one category (default 0.7). A merchant you split evenly
across two categories teaches nothing, so it's left for the LLM. Re-run it after a big
manual categorization session.

### `explain` — why didn't this match?

```bash
lmbot explain "WOOF GANG LESLIEVILLE   TORONTO"
```

```
normalized   "woof gang leslieville toronto"
memory key   "woof gang leslieville"  (dropped location tokens: toronto)

memory
  no exact key match — nearest stored keys:
      0.51  nodo leslieville toronto        Restaurants    2×
      0.51  timmie leslieville toronto on   Coffee        10×
  best is 0.51, below the 0.70 fuzzy threshold — treated as unknown
```

A near-miss and a total miss look identical in a summary line. This shows the whole chain —
normalization, the derived memory key, which location tokens were dropped, the nearest
stored keys with their scores, and any matching rule — so you can tell whether to add a
rule, categorize it once and re-run `learn`, or leave it to the LLM.

Pass `--offline` to skip loading categories (ids instead of names, no API call).

### `undo` — reverse a run

Every `categorize`/`audit`/`payees` write is journaled to `data/journal/` with the previous
value first. Undo restores only the fields that run actually wrote — reversing a rename
never touches a category.

```bash
lmbot undo --list
lmbot undo                    # reverse the most recent run
lmbot undo 2026-08-31T12
```

Deletions are journaled too, but can't be reversed — the journal keeps the full snapshot.

## Date selection

Shared by `categorize`, `audit`, `payees`, `duplicates`, and `learn`:

```
--month 2026-08        --year 2025           --last-days 30
--start 2026-01-01     --end 2026-06-30      --limit 200
```

Defaults: 90 days for `categorize` and `duplicates`, 365 for `audit` and `payees`, 730 for `learn`.

## Writing rules

`data/rules.json`. Checked top to bottom, first match wins, and a match skips both the
memory and LLM tiers.

**Start by checking them.** The example file ships with generic category names (`Coffee`,
`Rent`, `Income`) that almost no real account uses verbatim, so a fresh copy is mostly
broken rules:

```bash
lmbot rules          # which load, which are broken, and what to rename them to
lmbot rules --fix    # apply the unambiguous ones
lmbot rules --test   # which rules actually match transactions, which never fire
```

```
✗ Coffee shops: no category named "Coffee" — did you mean "Food & Drink > Coffee Shops"?
✗ Rent: no category named "Rent" — did you mean "Mortgage / Rent"?
✗ Rideshare: no category named "Transportation" — did you mean "Transport > Transportation
  Other" or "Transport > Uber / Lift / Taxi"?
```

`--fix` only rewrites rules with exactly **one** candidate. Where two categories are
plausible — `Transportation` could be either of two above — picking one silently would put
real money in the wrong place, so those are left for you.

```json
{
  "rules": [
    {
      "name": "Coffee shops",
      "category": "Food > Coffee",
      "match": "\\b(starbucks|blue bottle|peet'?s)\\b"
    },
    {
      "name": "Paycheck",
      "category": "W2 Income",
      "match": "\\b(direct dep|payroll)\\b",
      "sign": "credit"
    },
    {
      "name": "Rent",
      "category": "Rent",
      "match": "\\brent\\b",
      "amount_min": 500,
      "review": true
    }
  ]
}
```

| Field | |
|---|---|
| `category` | **required** — name, `"Group > Name"` path, or numeric id |
| `match` | **required** — JavaScript regex source, as a string |
| `flags` | regex flags, default `"i"` |
| `fields` | fields to search, default `["payee", "original_name", "notes"]` |
| `amount_min` / `amount_max` | bounds on `abs(amount)` |
| `sign` | `"debit"` (money out) or `"credit"` (money in) |
| `account_ids` | restrict to specific plaid/manual account ids |
| `notes` | note text stamped on the transaction when the rule fires |
| `review` | override `--mark-reviewed` for this rule |

A rule naming a category that doesn't exist in your account is reported with the closest
real names and skipped — the run continues.

## Cost

The category list is sent with `cache_control`, so it's cached across every batch in a run.
Transactions go up 25 at a time (`--batch-size`). With `learn` run first, most transactions
never reach the LLM at all.

Default model is `claude-opus-5`. For a large historical backfill where cost matters more
than accuracy:

```bash
ANTHROPIC_MODEL=claude-haiku-4-5 lmbot categorize --year 2023 --include-reviewed
```

## Safety

- Every writing command is dry-run until you pass `--apply` (or `--delete`).
- Interactive confirmation before writes; `--yes` to skip in scripts.
- Only uncategorized + unreviewed transactions are touched by default.
- LLM output is validated against the live category list — a hallucinated, archived, or
  group-level id never reaches the API.
- Rate limiting is handled (85/min against a 100/min cap) with `Retry-After` backoff.
- Journaled writes, reversible with `lmbot undo`.

## Tests

```bash
npm test
```

Covers payee normalization and cleanup, merchant clustering (including the conservative
merge that keeps Amazon and Amazon Web Services apart), the duplicate classifier (transfer
pairs, split children, keeper selection), and the LLM tier's response validation against a
stubbed client.
