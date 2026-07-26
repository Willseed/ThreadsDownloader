---
name: execute-atomic-task
description: Use when a ThreadsDownloader implementation subagent must deliver one independently buildable, directly tested change as exactly one scoped Conventional Commit while preserving concurrent work. Update when repeated atomic-task runs expose a missing scope, staging, or verification principle.
---

# Execute Atomic Task

Deliver one local commit whose behavior, ownership, and verification can be reviewed independently. Read the repository's current instructions and task-relevant scripts before acting; keep changing project state out of this skill.

## Core principles

1. **Protect worktree ownership.** Capture the branch, local and remote revisions, and staged, unstaged, and untracked paths before editing. Treat every pre-existing change as someone else's work; stop when ownership overlaps or remote `main` moves.
2. **Deliver one coherent contract.** Keep the change independently useful and buildable. Split unrelated behavior into later tasks without committing a broken intermediate state.
3. **Verify through the affected interface.** Select the smallest direct tests and affected build, type, lint, or format checks from the repository's current scripts. Protect high-risk behavior and data integrity without adding tests merely for coverage.
4. **Make the staged diff the proof.** Stage only explicit owned paths, inspect the complete cached diff and status, include required new files, and create exactly one Conventional Commit only after the scope and verification agree.
5. **Stop at the handoff seam.** Recheck remote `main` and worktree ownership after committing, then report the commit SHA, files, validation, and unresolved facts. Do not push, deploy, approve, or mutate remote services.

## Example

Given a disposable repository with an unrelated unstaged README edit, implement a request to make the path-containment module reject NUL-containing candidates. Leave the README edit untouched, change only the module and its direct contract test, run the relevant checks discovered from the repository, stage those owned paths, and create `fix(security): reject NUL path candidates`. Return that local commit and its evidence without pushing it.
