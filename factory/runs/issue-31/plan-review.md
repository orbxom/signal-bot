# Devil's Advocate Review — Issue #31

## Critical Issues Found

### 1. `extractQuery` mid-message corruption (CRITICAL)
`extractQuery` uses `indexOf` in a loop to remove ALL occurrences of a trigger from anywhere in the message. For trigger `"c "`, this mangles common English text:
- `"c tell me about music scenes"` → `"tell me about musiscenes"` (corrupted)
- `"c describe the basic stuff"` → `"describe the basistuff"` (corrupted)

**Fix required:** Change `extractQuery` to only strip triggers from the START of the message, not all positions.

### 2. `.trimStart()` breaks existing config test (HIGH)
Test at `config.test.ts:150-156` expects `' @bot , bot: , hey bot '` → `['@bot', 'bot:', 'hey bot']`. With `.trimStart()`, trailing spaces are preserved: `['@bot ', 'bot: ', 'hey bot ']`.

**Verdict:** This is actually benign — trailing spaces just require a space after the trigger word, which is always present in normal messages. Update the test.

### 3. `.env.example` can't represent `"c "` (HIGH)
Trailing spaces in env var values are invisible and fragile. The plan showed `c` without the trailing space.

**Fix:** Add a comment in `.env.example` explaining the trailing space, or accept that `"c "` must be set with awareness of the trailing space.

## Dismissed Concerns

- **False positives on "C sharp", "c u later"**: Acceptable per the issue — user explicitly wants the short trigger
- **Commit granularity**: Minor style preference, not blocking
