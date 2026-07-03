---
name: Example Skill
description: A template showing the SKILL.md format — replace this with a one-line trigger the bot reads to decide when to load the skill.
---

# Example Skill

This is a **skill** — a reusable pack of instructions the bot loads on demand.

- Only the `name` and `description` above are injected into the bot's system prompt.
- The bot loads this full body (everything below the frontmatter) only when a task
  matches the description, by calling its `use_skill` tool with this folder's slug.
- Put extra reference files next to this `SKILL.md`; the bot can open them with
  `read_file` once the skill is loaded.

## When to use

Describe the situations this skill applies to, so the model can recognize them.

## Steps

1. First do this.
2. Then do that.
3. Report the result.

## Notes

Anything else the bot should know while performing this task.

---
To install a skill: drop a folder `<slug>/SKILL.md` into `AIROUTER_HOME/skills/`,
or create/import one from the **Skills** tab in the control panel. Slugs are
lowercase letters, digits, `-` and `_`.
