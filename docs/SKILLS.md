# Local skills

Skills are the self-hosted replacement for CopilotKit Learning skill delivery.
They are ordinary folders on the owner's disk — auditable, offline, and with no
hosted service involved.

## Layout

```
skills/
  weekly-review/
    SKILL.md
    template.md
  release-notes/
    SKILL.md
    checklist.md
```

`SKILLS_DIR` (default `./skills`) points at the parent folder. Each subfolder is a
skill and must contain `SKILL.md`:

```markdown
---
name: weekly-review
description: How to prepare a weekly review page.
---

1. Read last week's page.
2. Write a short summary with decisions and open questions.
3. Create the page only after the owner approves it.
```

- `name` and `description` are optional; the folder name and the first line are
  fallbacks.
- Other text files in the folder are listed as reference files
  (`.md`, `.txt`, `.json`, `.yaml`, `.csv`, `.html`, `.ts`, `.py`, `.sh`, `.sql`,
  and similar). Hidden files, binaries, and files over 128 KB are ignored.

## Enabling the feature for a Dot

Open **Settings → Specialist → Local skills → Use local skills**. The catalogue is
added to that Dot's system prompt on every turn, and two tools become available:

- `load_skill({ name })` — full `SKILL.md` content plus the file list.
- `read_skill_file({ name, path })` — one reference file from that skill.

Skill content is treated as untrusted reference material, not as instructions
above the Dot's role. Skills are read from disk each turn — edit a file and the
next turn sees it; no restart is needed.

## Safety

- Path traversal is rejected, and reads are restricted to the skill folder.
- File types and sizes are limited.
- Nothing is downloaded, uploaded, or learned automatically.
- No relation to the legacy `learningContainerId` column, which is preserved for
  database compatibility but unused.

## Tests

`tests/skills.test.ts` covers parsing, loading, traversal rejection, and the
empty-library case.
