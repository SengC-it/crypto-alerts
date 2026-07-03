# Signal Tracking Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make email alerts safer to act on by separating tradeable signals from watch-only signals and persisting enough metadata for later realized-performance review.

**Architecture:** Keep strategy generation unchanged. Add a small enrichment boundary in `signalPriority` and `signalStore` so every saved signal carries priority, score, email timestamp, and tracking status. Extend the Supabase schema to store those fields.

**Tech Stack:** Node.js ESM, `node:test`, Supabase SQL schema, existing Gmail/Vercel serverless project.

---

### Task 1: Priority Metadata

**Files:**
- Modify: `src/strategies/signalPriority.js`
- Test: `tests/signalPriority.test.js`

- [ ] Add tests that high-priority signals expose action-oriented metadata and watch signals expose observation-only metadata.
- [ ] Implement priority action labels without mutating input signals.
- [ ] Run `node --test tests/signalPriority.test.js`.

### Task 2: Signal Persistence Enrichment

**Files:**
- Modify: `src/db/signalStore.js`
- Test: `tests/signalStore.test.js`

- [ ] Add tests for `prepareSignalForStorage` to include priority, score, email timestamp, and tracking status.
- [ ] Export and use `prepareSignalForStorage` inside `save`.
- [ ] Run `node --test tests/signalStore.test.js`.

### Task 3: Supabase Schema Fields

**Files:**
- Modify: `supabase/schema.sql`
- Test: `tests/signalStore.test.js`

- [ ] Add schema assertions for the new persistence columns.
- [ ] Add columns and indexes for priority/tracking queries.
- [ ] Run `node --test tests/signalStore.test.js`.

### Task 4: Verification and Release

**Files:**
- Run checks across the repo.

- [ ] Run `npm test`.
- [ ] Inspect `git diff`.
- [ ] Commit scoped changes.
- [ ] Push to GitHub.
- [ ] Deploy production to Vercel and verify the deployment URL.
