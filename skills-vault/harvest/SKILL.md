---
name: harvest
version: 1.0.0
description: "Post-ship wiki distillation. Given a shipped project file (status: done), reads the project plan + linked research + shipped content, drafts a distilled wiki article in the relevant topic folder, cross-links to siblings + source project + shipped content, and updates the topic _index.md plus wiki/_master-index.md. Wiki article is NOT a duplicate of project or content — it's the post-ship harvest: what survives 6 months later. Trigger phrases: 'harvest', '/harvest', 'compile [project] into wiki', 'wiki harvest', 'distill this project'."
---

# Harvest v1.0.0

The rite of completion. A project ships, then `/harvest <project-file>` distills its learnings into the wiki. Without this step, knowledge dies in `/projects` and never compounds.

## Why this exists

The vault's three-stage model assigns each folder a different role:

- `projects/<video>.md` = the PLAN (work-product, time-bounded)
- `content/<platform>/<video>.md` = the SHIPPED artifact (output)
- `wiki/<topic>/<concept>.md` = the DISTILLED learning (evergreen)

After ship, project + content are static. The wiki is where insight survives. Manual harvest is friction → skip → wiki rots. This skill automates the harvest so wiki coverage scales with ship rate.

The output is NOT a project recap and NOT a content duplicate. It's "what we learned doing this, what still holds true later, links to source project + content + sibling concepts."

## How it works

### Step 1: Resolve input

User invokes with a project file path. Accept any of:

- Absolute: `projects/2026-04-28-higgsfield-mcp-video.md`
- Bare slug: `2026-04-28-higgsfield-mcp-video`
- Wiki-link: `[[2026-04-28-higgsfield-mcp-video]]`

Resolve to absolute vault path. If the file doesn't exist, ask the user to confirm the project filename. If multiple projects match an ambiguous slug, list them and ask.

### Step 2: Read source material in parallel

Single message, multiple tool calls:

1. **Project file** — read fully. Extract frontmatter (`status`, `date`, `tags`, `topic`, etc.) + body.
2. **Linked research** — scan project body for `[[...]]` wiki-links and `inbox/research/...` paths. Read each linked file that exists.
3. **Shipped content** — if the project mentions a slug present in `content/<platform>/`, read those artifacts to ground the distillation in what actually shipped.
4. **Wiki master index** — read `wiki/_master-index.md` for current topic list.

If `status:` is not `done` or `archived` in frontmatter, surface a warning: "Harvest convention is post-ship — `status` is currently `<X>`. Proceed anyway?" Wait for confirmation.

### Step 3: Propose target topic folder

Current canonical topics (as of 2026-05-12):

- `agentic-os-patterns` — vault-as-memory, cockpit, runner, taxonomy, direct-exec
- `ai-dev-tools` — Claude Code, Codex, Aider, MCP servers, design tools
- `ai-models-comparison` — Opus/GPT/DeepSeek, dual-stack economics
- `automation-patterns` — n8n MCP, hooks, Task Scheduler cadence
- `claude-code-skills` — SKILL.md format, skill-creator, ecosystem
- `content-strategy` — content cascade, posting strategies, per-platform reach
- `rag-systems` — RAG frameworks, Obsidian RAG, graph RAG
- `video-strategy` — YT title meta, Kallaway hooks, evergreen rotation, retention

Inspect topic by reading `wiki/<topic>/_index.md` if the match is ambiguous.

**Decision tree:**
1. If project frontmatter has `topic:` field matching one of the 8 → propose that.
2. Else infer best fit from project tags + body. State your reasoning in one line: `→ proposing topic: <X> because <Y>`.
3. If genuine fit doesn't exist in the 8, propose a NEW topic folder and explain why. Ask user confirmation before creating.
4. If user disagrees with the proposal, accept their override.

### Step 4: Derive article slug + check collision

Slug = the CONCEPT, not the project's filename. Examples:

- `projects/2026-04-28-higgsfield-mcp-video.md` → article slug `higgsfield-mcp-server` (concept-named) NOT `2026-04-28-higgsfield-mcp-video` (project-named with date)
- `projects/2026-04-15-caveman-mode-philosophy.md` → `caveman-mode-philosophy`

Lowercase, hyphens, no date prefix. Wiki articles are evergreen → no date prefix.

Check `wiki/<topic>/<slug>.md` doesn't already exist. If it does:
- If the existing article covers the same ground → ask user whether to UPDATE existing (merge new findings) or write a sibling article with a more-specific slug.
- If it covers different ground despite slug match → pick a more-specific slug and continue.

### Step 5: Draft the article

Match existing wiki style. Template:

```markdown
---
topic: <topic-folder>
date: <today YYYY-MM-DD>
source_project: "[[<project-filename-no-extension>]]"
source_research: "[[<linked-research-1>]]"  # optional, only if linked
source_content: "[[<shipped-content>]]"     # optional, only if linked
---

# <Concept Title — title-case, no date>

## TL;DR
<2-4 sentences. What the concept IS, why it matters, what specifically was learned. Written for future-you in 6 months.>

## Key Takeaways
- <bullet 1 — distilled finding, not a project recap>
- <bullet 2>
- <bullet 3 — 3-7 bullets total>
- ...

## <Body Section 1>
<Distilled content. Reference the project's specific moves, but written as a general pattern. NO "we did X in this video" — instead "X works because Y, with the trade-off Z".>

## <Body Section 2>
...

## When to use this / when not to
<If applicable — boundaries, anti-patterns, situations where the concept fails.>

## Related
- [[<sibling-article-1>]] — one-line relationship description
- [[<sibling-article-2>]] — ...
- [[<source-project>]] — original plan
- [[<source-content>]] — shipped artifact (if applicable)
```

**Voice guidance:**
- Past-tense narrative ("we shipped X") is wrong. Present-tense pattern ("X compounds because Y") is right.
- Specific numbers + named tools survive longer than generic claims. Keep them.
- Active voice. Cut hedging.
- Length: 200-600 words body. Less is better. The wiki rewards distillation.

### Step 6: Cross-link to siblings

Before writing, glob `wiki/<topic>/*.md` (excluding `_index.md`) and read 2-4 most-relevant siblings. Add `[[sibling-slug]]` wiki-links in the body where the concepts connect. Then OPTIONALLY edit 1-2 siblings to add a back-reference under their `## Related` section. This is what keeps the graph dense.

Don't add backlinks blindly — only when the connection is genuine. A weak cross-link is worse than none.

### Step 7: Write article + update indexes

Three writes in order:

1. **Article:** `wiki/<topic>/<slug>.md` (full content from Step 5).
2. **Topic index:** read `wiki/<topic>/_index.md`, append new line under `## Articles`:
   ```
   - [[<slug>]] — <one-sentence hook, ~15 words, matches the article's TL;DR opening>
   ```
   Preserve existing article entries + ordering convention used in the file.
3. **Master index:** read `wiki/_master-index.md`. Update the topic's article count in parentheses (e.g. `(5 articles)` → `(6 articles)`). If a NEW topic folder was created in Step 3, add a new line for the topic with its `_index.md` link.

### Step 8: Brief summary

End your reply with:

```
HARVESTED <project-slug> → wiki/<topic>/<slug>.md
- topic: <topic> (was <N> → <N+1> articles)
- cross-linked: <K> siblings
- backlinks added to: <list or "none">
```

## Boundaries

- DO NOT rewrite the source project file or shipped content. The wiki article is ADDITIVE.
- DO NOT auto-trigger on `status: done` flips. Manual invocation only — the user decides when to harvest.
- DO NOT create new topic folders without user confirmation. The 8 existing topics cover most cases; new ones dilute the index.
- DO NOT delete or rename existing wiki articles to make room. Sibling articles with overlapping scope is fine — different angles compound.
- DO NOT fabricate cross-links. Every `[[wiki-link]]` must point at an actual file in `wiki/`.
- DO NOT include date prefix in article slug. Wiki is evergreen; date belongs in frontmatter only.
- If the project's research links resolve to missing files, note them in the article frontmatter with a `# unresolved` comment but don't write fake backlinks.
- If the user supplies a project file with `status:` not yet `done`, warn before proceeding (Step 2 confirmation gate).

## Related

- [[CLAUDE]] — `## Wiki System` section defines the wiki doctrine this skill enforces
- [[plan-today]] — counterpart on the front end of the project lifecycle
- [[weekly-review]] — periodic retrospective; surfaces candidate projects to harvest
