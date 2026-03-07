# Code Review Log — Issue #35

## Findings & Fixes

1. **Hardcoded timeout in view_pull_request** — Used `30000` instead of `GH_TIMEOUT` constant. Fixed.
2. **Unused JSON fields in list_pull_requests** — `createdAt,updatedAt` fetched but never displayed. Removed.
3. **Missing test for invalid merge strategy** — Added test verifying `fast-forward` is rejected with "Invalid strategy" error.
4. **CLAUDE.md outdated** — Still said github.ts had 1 tool. Updated to reflect 7 tools.

## Already Addressed (found during review but tests existed)

- Invalid review event test — already covered
- REQUEST_CHANGES/COMMENT without body — already covered

## Verification

- 695 tests passing (18 github tests including new invalid strategy test)
- Lint + format clean
- PR #37 marked ready for review
