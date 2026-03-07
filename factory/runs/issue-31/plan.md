# Add "c " Short Mention Trigger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `"c "` (lowercase c + space) as a mention trigger so users can type `c what's the weather` instead of `claude: what's the weather`.

**Architecture:** Two code changes needed: (1) Fix `extractQuery` to only strip triggers from the START of messages — the current implementation strips all occurrences, which mangles text containing short triggers mid-word. (2) Change config `.trim()` to `.trimStart()` so trailing spaces in triggers like `"c "` survive env var parsing. Then add tests and update `.env.example`.

**Tech Stack:** TypeScript, Vitest, signal-cli JSON-RPC

---

### Task 1: Fix `extractQuery` to only strip triggers from message start

**Files:**
- Modify: `bot/src/mentionDetector.ts:15-30`
- Test: `bot/tests/mentionDetector.test.ts`

**Why:** The current `extractQuery` uses `indexOf` in a loop to remove ALL occurrences of each trigger from the entire message. For short triggers like `"c "`, this corrupts text: `"c tell me about music scenes"` becomes `"tell me about musiscenes"` because `"c "` appears inside `"music scenes"`. The fix: only strip triggers from the start of the message, iterating until no more triggers match at position 0.

**Step 1: Write failing tests showing the bug and desired behavior**

Add to `bot/tests/mentionDetector.test.ts`, in the `extractQuery` describe block:

```typescript
it('should only strip triggers from the start of the message', () => {
  const detector = new MentionDetector(['c ']);
  // "c " appears inside "music scenes" — must NOT be stripped
  expect(detector.extractQuery('c tell me about music scenes')).toBe('tell me about music scenes');
  expect(detector.extractQuery('c describe the basic stuff')).toBe('describe the basic stuff');
});

it('should strip repeated triggers at the start', () => {
  const detector = new MentionDetector(['@bot']);
  expect(detector.extractQuery('@bot @bot hello')).toBe('@bot hello');
});
```

Also update the existing test on line 18 that tests mid-message stripping (this behavior is changing):
```typescript
// Line 18: change expected result
expect(detector.extractQuery('hey @bot how are you')).toBe('hey @bot how are you');
```

And update line 54 (multiple mentions test):
```typescript
// Line 54: only strips from start, not repeated occurrences
expect(detector.extractQuery('@bot @bot hello')).toBe('@bot hello');
```

And update line 74 (multiple trigger patterns):
```typescript
// Line 74: only strips the leading trigger
expect(detector.extractQuery('@bot bot: hello')).toBe('bot: hello');
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/mentionDetector.test.ts`
Expected: FAIL — current implementation strips all occurrences

**Step 3: Rewrite `extractQuery` to only strip from message start**

Replace `bot/src/mentionDetector.ts` lines 15-30 with:

```typescript
extractQuery(content: string): string {
  let query = content;
  const lowerContent = query.toLowerCase();
  // Find the trigger that matched at position 0 and strip it
  for (let i = 0; i < this.lowerTriggers.length; i++) {
    if (lowerContent.startsWith(this.lowerTriggers[i])) {
      query = query.slice(this.triggers[i].length);
      break;
    }
  }
  return query.replace(/\s+/g, ' ').trim();
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/mentionDetector.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add bot/src/mentionDetector.ts bot/tests/mentionDetector.test.ts
git commit -m "fix: only strip mention triggers from start of message

Prevents mid-message text corruption with short triggers like 'c '
where the trigger pattern appears inside words (e.g. 'music scenes')."
```

---

### Task 2: Fix config parsing to preserve trailing whitespace in triggers

**Files:**
- Modify: `bot/src/config.ts:66`
- Test: `bot/tests/config.test.ts`

**Why:** The current `.trim()` strips trailing whitespace, turning `"c "` into `"c"` — which would match ANY message starting with "c". Using `.trimStart()` preserves intentional trailing spaces while still cleaning leading whitespace from comma-separated formatting. Trailing spaces in triggers are benign for existing triggers (they just require a space after the trigger word, which is always present in natural messages).

**Step 1: Write the failing test**

Add to `bot/tests/config.test.ts` after line 164:

```typescript
it('should preserve trailing whitespace in mention triggers', () => {
  process.env.BOT_PHONE_NUMBER = '+1234567890';
  process.env.MENTION_TRIGGERS = 'claude:,c ';

  const config = Config.load();
  expect(config.mentionTriggers).toEqual(['claude:', 'c ']);
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/config.test.ts`
Expected: FAIL — `"c "` is trimmed to `"c"`

**Step 3: Change `.trim()` to `.trimStart()` in config.ts**

In `bot/src/config.ts` line 66, change:
```typescript
.map(s => s.trim())
```
to:
```typescript
.map(s => s.trimStart())
```

**Step 4: Update existing test for new trimStart behavior**

In `bot/tests/config.test.ts`, update the test at line 150-156. With `.trimStart()`, trailing spaces from env var formatting are preserved:

```typescript
it('should handle mention triggers with extra whitespace', () => {
  process.env.BOT_PHONE_NUMBER = '+1234567890';
  process.env.MENTION_TRIGGERS = ' @bot , bot: , hey bot ';

  const config = Config.load();
  expect(config.mentionTriggers).toEqual(['@bot ', 'bot: ', 'hey bot ']);
});
```

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/config.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add bot/src/config.ts bot/tests/config.test.ts
git commit -m "fix: use trimStart for trigger parsing to preserve trailing spaces

Allows triggers like 'c ' where the trailing space is significant."
```

---

### Task 3: Add mention detector tests for "c " trigger

**Files:**
- Test: `bot/tests/mentionDetector.test.ts`

**Step 1: Add tests for "c " trigger behavior**

Add a new describe block at the end of the `MentionDetector` describe:

```typescript
describe('short trigger "c "', () => {
  const detector = new MentionDetector(['claude:', 'c ']);

  it('should detect "c " at start of message', () => {
    expect(detector.isMentioned('c what is the weather')).toBe(true);
  });

  it('should not match words starting with c without space', () => {
    expect(detector.isMentioned('cat is here')).toBe(false);
    expect(detector.isMentioned('can you help')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(detector.isMentioned('C what is 2+2')).toBe(true);
  });

  it('should extract query without corrupting mid-message text', () => {
    expect(detector.extractQuery('c what is the weather')).toBe('what is the weather');
    expect(detector.extractQuery('c tell me about music scenes')).toBe('tell me about music scenes');
    expect(detector.extractQuery('c describe the basic stuff')).toBe('describe the basic stuff');
  });

  it('should work alongside other triggers', () => {
    expect(detector.isMentioned('claude: hello')).toBe(true);
    expect(detector.extractQuery('claude: hello')).toBe('hello');
  });

  it('should handle just "c " with no query', () => {
    expect(detector.extractQuery('c ')).toBe('');
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/mentionDetector.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add bot/tests/mentionDetector.test.ts
git commit -m "test: add mention detector tests for 'c ' short trigger"
```

---

### Task 4: Update .env.example

**Files:**
- Modify: `bot/.env.example`

**Step 1: Update .env.example with "c " trigger and explanatory comment**

Add `c ` to the MENTION_TRIGGERS line with a comment explaining the trailing space:

```bash
# Note: "c " trigger has a trailing space — this is intentional (matches "c hello" but not "cat")
MENTION_TRIGGERS=@bot,bot:,c
```

**Step 2: Commit**

```bash
git add bot/.env.example
git commit -m "docs: add 'c ' short trigger to .env.example"
```

---

### Task 5: Run full test suite and lint

**Step 1: Run all tests**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 2: Run lint and format check**

Run: `cd bot && npm run check`
Expected: No errors

**Step 3: Fix any issues if found, then commit**

---

## Revisions

Changes from v1 based on devil's advocate review:

1. **Added Task 1 (extractQuery fix):** The original plan claimed `mentionDetector.ts` needed no changes. The devil's advocate correctly identified that `extractQuery` strips triggers from ALL positions, which corrupts mid-message text containing `"c "` (e.g., "music scenes" → "musiscenes"). Fixed by rewriting to only strip from message start.

2. **Updated existing test expectations:** Three existing tests assumed mid-message trigger stripping (lines 18, 54, 74). Updated to reflect the new start-only behavior, which is more correct.

3. **Updated config test for `.trimStart()`:** The test at line 150-156 will now preserve trailing spaces from env var formatting. Updated the expected values — trailing spaces are benign for existing triggers.

4. **Fixed `.env.example`:** Added explanatory comment about the trailing space being intentional.

5. **Dismissed:** Adding `"c "` programmatically in config code. The env var approach works with `.trimStart()`, and the comment in `.env.example` documents the trailing space requirement.
