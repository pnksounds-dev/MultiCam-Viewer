# MultiCamViewer — Skills & Workflow Rules

## Planning Documentation

Whenever a plan is discussed or created (whether it's a bug fix plan, feature plan, refactor plan, or any systematic multi-step plan):

1. **Write it to `docs/plans/`** — Create a markdown file named after the plan topic (e.g., `docs/plans/multi-instance-lifecycle-fixes.md`).
2. **Include a timestamp** — At the top of the plan, record the date and time the plan was created (ISO 8601 format, e.g., `2026-07-13T13:07:00Z`).
3. **Track completion status** — Each plan item must have a status: `[ ]` for pending, `[x]` for completed. Update the status as work progresses.
4. **Record completion timestamp** — When the entire plan is completed, add a "Completed:" timestamp at the top of the document.
5. **Update the plan as it evolves** — If the plan changes (items added, removed, or reprioritized), update the document and note the change with a timestamp.

### Plan File Template

```markdown
# [Plan Title]

**Created:** 2026-07-13T13:07:00Z
**Status:** In Progress | Completed
**Completed:** (fill in when done)

## Items

- [ ] 1. [Description] — [priority]
- [ ] 2. [Description] — [priority]
- [x] 3. [Description] — [priority] (completed: 2026-07-13T14:30:00Z)

## Notes

[Any relevant context, decisions, or changes made during execution.]
```
