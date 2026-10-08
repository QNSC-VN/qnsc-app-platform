# Architecture decision records

One file per decision: `docs/adr/NNNN-slug.md`, written from [`0000-template.md`](./0000-template.md).
An ADR is also how an executing agent reports a failed spike or an acceptance criterion that cannot
be met: write the finding here instead of redesigning silently.

## Numbering

- Four digits, ascending, never reused, never renumbered.
- **Reserved numbers** (the plan refers to them by name, so they are fixed in advance):

  | Number | File                              | Work package |
  | ------ | --------------------------------- | ------------ |
  | 0001   | `0001-job-queue.md`               | WP-6         |
  | 0002   | `0002-identity-v8-better-auth.md` | WP-9         |

- Any other ADR takes the **next free number on `main` at the time you open the PR**, skipping the
  reserved ones. If two PRs pick the same number, whichever merges second renumbers its own file.

## Lifecycle

An accepted ADR is not edited to change its decision. Supersede it: add a new ADR, and set the old
one's status to `Superseded by NNNN`.
