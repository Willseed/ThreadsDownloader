---
name: verify-release-state
description: Use when an exact ThreadsDownloader main revision needs remote or final release verification across GitHub Actions, Sonar, the complete local gate, and production evidence. Update when a repository gate interface changes or a real verification exposes a missing evidence state.
---

# Verify Release State

Decide what can truthfully be claimed about one immutable candidate SHA. Read the repository's current verification interfaces at runtime; never turn this skill into release or control-plane automation.

## Core principles

1. **Bind every observation to one revision.** Start with the candidate's full SHA and require local, upstream, remote `main`, GitHub Actions, and Sonar evidence to identify that revision. Treat a mismatch or moving target as unknown, never as the latest equivalent result.
2. **Preserve gate order and provenance.** Require the exact revision's remote verification to complete before Sonar, and require both to converge successfully before running the complete local gate. Recheck the candidate and worktree after local verification.
3. **Reuse the repository's gate interfaces.** Discover the current workflow, package commands, and security checks instead of copying or recreating their logic. Do not weaken, skip, reinterpret, or replace a failing gate.
4. **Keep verdicts independent.** Report remote verification, final local verification, deployment, health, and exposure separately with their evidence. Unknown, skipped, pending, stale, or differently scoped evidence is not a pass.
5. **Exercise validation-only authority.** Inspect remote systems and run existing local verification, but do not edit source or history, push, dispatch, approve, deploy, or change GitHub, Sonar, or production settings. On failure, retrieve only the minimum safe diagnostic needed for the verdict.

## Example

Given a candidate SHA whose exact GitHub Actions `verify` job succeeds while the Sonar verification step reports `SONAR_MEASURES_NOT_ZERO`, mark remote verification failed even if the official Quality Gate says `OK`. Defer the complete local gate, leave deployment, health, and exposure unverified, report the revision-bound evidence, and stop without changing or releasing anything.
