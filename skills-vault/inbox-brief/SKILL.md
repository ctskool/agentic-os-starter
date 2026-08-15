---
name: inbox-brief
version: 1.2.0
description: Morning inbox triage for Chase AI's Gmail. Scans the last 24h of inbox via the Anthropic Gmail MCP connector, categorizes messages (leads / urgent / warm threads / sponsor pitches / meetings / noise), qualifies incoming form leads (agency inquiries, mentorship applications) with a quick web search + pursue/pass verdict, surfaces what needs personal attention, then offers to draft replies to new sponsor pitches and personalized outreach to pursued leads. The MCP path is draft-only (Anthropic blocks autonomous send); user clicks Send manually in Gmail. Legacy gws CLI path (send + PDF attachment) remains available as an opt-in advanced mode. Trigger on phrases like 'inbox brief', '/inbox-brief', 'morning inbox', 'check my inbox', "what's in my inbox", 'sponsor triage', 'draft sponsor replies', 'lead triage', 'check for new leads', 'run inbox check'.
---

# Inbox Brief v1.2.0

Runs the morning inbox workflow for Chase AI: scan → classify → qualify leads → summarize → draft replies to new sponsor pitches + pursued leads.

## Prerequisites

**Primary path (MCP, recommended):**
- Anthropic Gmail MCP connector authenticated (`/mcp` → "claude.ai Gmail" → Connected). One-time browser OAuth, no Google Cloud Console setup. Tools auto-load: `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`, `mcp__claude_ai_Gmail__create_draft`, etc.

**Legacy path (gws CLI, opt-in advanced mode for autonomous send + PDF attach):**
- `gws` CLI authenticated as `your-gmail-account`. Verify with `gws auth status`. If `token_valid: false`, run `! gws auth login`. Required ONLY if user explicitly invokes the legacy send mode (see Phase 5).
- Media kit PDF exists at the path in `config.json` (only used by legacy path).

## Configuration

All defaults live in `config.json` in this skill's directory. Relevant fields:
- `email` — Chase's Gmail address (From: header)
- `mediaKitPath` — absolute path to the media kit PDF (legacy path only; MCP cannot attach)
- `mediaKitLink` — Drive share link to the media kit (used in MCP path body, since drafts can't carry attachments)
- `lookbackHours` — default 24; can be overridden per-invocation
- `templateBody` — canned sponsor reply copy with `${firstName}` placeholder
- `excludeSenders` — array of email substrings; any matching thread is auto-skipped
- `leadSources` — array of lead-form fingerprints, each `{label, subjectPrefix, sender, formFields}`. Current sources: `agency` (subject `New Agency Inquiry — <Name>` from `notifications@yourdomain.com`; fields Website / Services / Timeline / Budget / Challenge) and `mentorship` (subject `New Mentorship Application — <Name>`, same sender; fields Situation / Timeline / Biggest Challenge). Add new forms here as they launch.
- `leadTemplateBody` — lead outreach skeleton with `${firstName}`, `${personalizedLine}`, `${bookingLink}` placeholders
- `bookingLink` — scheduling link inserted into lead drafts; if empty, ask the user for it before drafting lead replies

If the user asks to change template copy, exclusions, or the lookback window, edit `config.json` directly (do not hardcode in scripts).

## Workflow

### Phase 1 — Scan

Call `mcp__claude_ai_Gmail__search_threads` with:
- `query`: `in:inbox newer_than:<lookbackHours>h` (or `newer_than:<N>d` if the user specified a day count). Default lookbackHours = 24 from `config.json`.
- `pageSize`: 50 (max allowed).

Parse the returned thread list. Each thread contains a `messages` array; pull the LATEST message per thread for header/snippet, plus thread metadata:
- `id` (threadId), `subject` (from latest message), `sender` (from latest message), `snippet`, `date`, `labelIds`, message count (`threadLength` = messages.length).
- `chaseReplied`: scan thread messages for any with `labelIds` containing `SENT` — true if user has replied in-thread.
- `messageIdHeader`: the latest message's `id` (used as `replyToMessageId` when drafting).

Apply the `excludeSenders` filter from `config.json` — drop any thread whose `sender` substring-matches an entry.

If MCP returns an authentication error, instruct the user to run `/mcp` and re-authenticate "claude.ai Gmail". Stop the workflow.

If results exceed 50, fetch the next page via `pageToken` until `lookbackHours` is fully covered OR you have 100 threads (cap to avoid runaway runs).

### Phase 2 — Classify (STRICT)

Categorize each message into exactly one bucket. When in doubt, prefer the less-aggressive category. Recency: sort within each bucket newest-first.

- 💼 **Leads** — checked FIRST, before all other buckets: any thread whose subject starts with a `subjectPrefix` from `config.json`'s `leadSources` (match sender too when the source specifies one). These are form-submission notification emails — the prospect's identity is in the BODY, not the headers, so ignore sender/`chaseReplied` for this bucket. Route to Phase 2b.
- 🔴 **Urgent** — contract signatures, dated deadlines, security alerts, affiliate-link changes, explicit calendar action items. Must name a concrete thing requiring action.
- 🟡 **Warm threads** — messages where `chaseReplied === true` and the sender is pressing for a decision (follow-up chasing a reply), OR messages from a genuine ongoing partner. NOT new cold outreach.
- 🟢 **Sponsor pitches** — first-touch cold outreach (`chaseReplied === false`) that explicitly asks for a paid partnership, brand deal, sponsored video, IG/TikTok/YT/LinkedIn integration, or similar. **Strict:** exclude anything ambiguous — SaaS tool pitches offering free trials, newsletter pitches, script/thumbnail coaches, "try my AI tool" outreach, agency job-board mass blasts. If it doesn't clearly name a brand + ask to partner, it's noise.
- 📅 **Meetings** — calendar notifications (accepted, declined, updated, action items from a meeting).
- ⚫ **Noise** — everything else: cold coaches, newsletters, promo blasts, tool try-me emails, mass outreach where the sender address ≠ the pitched brand.

### Phase 2b — Qualify leads (only if the Leads bucket is non-empty)

For each lead notification, in order received:

1. **Parse the form data.** Call `mcp__claude_ai_Gmail__get_thread` (FULL_CONTENT) and extract from the body: prospect name, prospect email, plus the source's `formFields` (agency: Website / Services / Timeline / Budget / Challenge; mentorship: Situation / Timeline / Biggest Challenge). The prospect's real identity is INSIDE the body — never the email's sender/recipient headers.
2. **Quick web search.** One or two `WebSearch` calls max per lead — this is a background check, not deep research. Search the prospect's name + email domain (e.g. `"Tim Harris" harrisinvestment.com`). Look for: LinkedIn role/seniority, company site, size/industry, anything confirming a real person with a real business. If the email domain is a free provider (gmail/outlook/yahoo), search name + any company/product mentioned in their form answers instead, and note the weaker signal.
3. **Verdict.** Combine form answers + research into `PURSUE` or `PASS` with a one-line rationale. Weigh by source:
   - **agency** — Budget is the primary signal: `5k-15k` and up = strong pursue lean; `under-5k` needs a redeeming signal (business domain, real website, concrete challenge) to escape PASS. Website provided or business email domain + specific challenge = pursue. Gibberish/keyboard-mash, personal-use asks, or `under-5k` + `exploring` + vague = PASS.
   - **mentorship** — business email domain or research confirms a real business/role; concrete, specific challenge in their own words; timeline "ready to start now" = pursue. Spam/troll, "can't afford" signals, vague copy-paste = PASS.
   - Borderline (e.g. free-mail address but serious, specific challenge — or big budget with weak identity) → present as `PURSUE?` and let the user decide. Never silently drop a lead.
4. Carry `{source, name, email, formAnswers, verdict, rationale, researchNote}` forward to Phase 3.

If `WebSearch` is unavailable or errors, still present the lead with verdict based on form scores alone, flagged `(no web check)`.

### Phase 3 — Present the summary

Render in this format:

```
Inbox brief: N messages in the last Xh, Y unread.

💼 Leads (N)
 1. [name] — [source: agency/mentorship] — [company/role from research, or key form answer] — VERDICT: PURSUE/PASS — [one-line rationale]
 2. ...

🔴 Urgent (N)
- [sender] — [subject] — [what action / by when]

🟡 Warm threads pressing for reply (N)
- [sender] — [subject] — [one-line of what they want]

🟢 New sponsor pitches (N)
 1. [sender] — [brand] — [platform asked: YT-dedicated / short-form / mixed] — [budget if mentioned]
 2. ...

📅 Meetings (N)
- [one-line each]

⚫ Noise: N (not listed)
```

Number the leads and sponsor pitches (separate lists) so the user can say "skip 3 and 7". Keep each line short.

### Phase 4 — Offer the actions

After the summary, ask (include each line only if that bucket is non-empty):

> Leads: N marked PURSUE. Say `pursue all`, `pursue 1,3`, or `pass` — I'll draft personalized outreach to the ones you approve.
>
> Sponsors: want me to draft canned replies to the N pitches? Say `draft all`, `draft except 3,7`, or `skip`.
>
> (Drafts land in Gmail; you review + click Send manually. To autonomously send + attach the media-kit PDF, ask for "legacy send" mode — requires gws CLI.)

### Phase 5 — Execute (MCP draft path, default)

Parse the user's reply:
- `skip` / "no" / "not right now" → stop, take no action.
- `pursue all` / `pursue 1,3` → draft lead outreach for the approved leads (see "Lead drafts" below), independent of any sponsor decision.
- `pass` → no lead drafts; sponsor handling unaffected.
- `draft all` → draft replies for every sponsor pitch identified.
- `draft except X,Y` → exclude those numbered items, draft the rest.
- `legacy send all` (or any explicit "send" verb) → fall through to Phase 5b.
- Freeform (e.g. "rewrite #4 to be more casual") → handle manually: draft the straightforward ones via MCP, ask clarifying questions on the bespoke ones.

For each sponsor pitch to draft:
1. Extract `firstName` from the sender display name (or default to "there" if not parseable).
2. Build the reply body by substituting `${firstName}` in `config.json`'s `templateBody`. Append a line at the bottom: `Media kit: <mediaKitLink from config.json>` (since MCP cannot attach the PDF).
3. Call `mcp__claude_ai_Gmail__create_draft` with:
   - `to`: [extracted plain email of sender; strip any "Name <addr>" wrapping — MCP requires plain addresses]
   - `subject`: the original thread's subject prefixed with `Re: ` if not already.
   - `body`: the substituted template body.
   - `replyToMessageId`: the `messageIdHeader` captured in Phase 1 (so the draft attaches in-thread).
4. Collect the returned draft IDs.

**Lead drafts (for each approved lead):**
1. If `bookingLink` in `config.json` is empty, ask the user for it once and save it to config before drafting.
2. Build the body from `leadTemplateBody`: substitute `${firstName}` (prospect's first name), `${bookingLink}`, and write `${personalizedLine}` yourself — ONE sentence referencing something concrete from THEIR form answers or the Phase 2b research (their stated challenge, company, or situation — e.g. "Positioning and pricing is exactly the kind of thing we can fix fast."). This is the only free-written part; keep the rest of the template verbatim.
3. Call `mcp__claude_ai_Gmail__create_draft` with:
   - `to`: the prospect's email parsed from the form body (plain address).
   - `subject`: agency → `Your project inquiry — next step`; mentorship → `Your mentorship application — next step`.
   - `body`: the substituted template.
   - NO `replyToMessageId` — the notification is a self-sent email; the draft is a NEW message to the prospect, not an in-thread reply.
4. Collect draft IDs and report alongside sponsor drafts.

After all drafts are created, report:
```
Drafted N replies. Review + send manually in Gmail (each draft is attached in-thread).
Failed: K (list with sender + reason if any).
```

### Phase 5b — Legacy send path (opt-in advanced)

Only runs when user explicitly invokes "legacy send" or "send via gws". Requires:
- `gws auth status` returns `token_valid: true`. Otherwise tell user to run `! gws auth login` and stop.
- `mediaKitPath` file exists.

Run: `node "<skill-dir>/scripts/act.js" --action <draft|send> --ids <id1,id2,id3>`

The act.js output is JSON — report it back concisely: number drafted/sent, any failures. Don't dump the full JSON.

Print the final recipient list before any send for Ctrl-C escape. No re-prompt — the explicit "legacy send" already authorized.

### Phase 6 — Save offerings for the warm threads

If there are warm threads or urgent items that the user flagged for personal response ("I'll reply to CodeRabbit myself"), leave them alone. The skill only automates sponsor replies.

## Important constraints

- **Default mode is draft-only.** MCP cannot send autonomously by Anthropic policy. User clicks Send in Gmail.
- **Never invoke legacy send without explicit user phrase.** Phase 5b requires "legacy send" or equivalent literal instruction.
- **Never modify `excludeSenders` in config.json without asking.** If the user says "never draft to X again", confirm, then append to the list.
- **If Phase 1 returns zero sponsor pitches**, say so plainly. Don't force-fit borderline candidates.
- **Respect the "first-touch" rule strictly.** If `chaseReplied === true`, the message is not a sponsor pitch candidate — it belongs in warm threads.
- **Keep the body of canned sponsor replies clean** — use the template from config.json verbatim; don't ad-lib. Lead drafts allow exactly ONE personalized sentence (`${personalizedLine}`); the rest stays template.
- **Lead drafts go to the prospect's parsed email, never the notification sender** — the notification is self-sent; replying in-thread would email Chase himself.
- **Web check is quick, not deep** — max 2 searches per lead. If the user wants a full background workup, that's `/deep-research`, not this skill.
- **Never auto-pass silently.** Every lead appears in the summary with its verdict, including PASS — the user overrides, not the skill.
- **MCP cannot attach the PDF.** Always append the Drive link (`mediaKitLink`) instead. If `mediaKitLink` is missing from config, ask the user to set it.
- **Plain-email recipients only.** MCP rejects `"Name <addr>"` format — strip display names before passing to `create_draft`.

## Troubleshooting

- **MCP "authentication failed" or tools missing** — User runs `/mcp` → select "claude.ai Gmail" → re-authenticate. Hot-reloads in current session.
- **Drafts not landing in-thread** — `replyToMessageId` was missing or wrong. Use the latest message ID from the thread (not the threadId).
- **Plain-email format error** — sender field contained `"Display Name <user@example.com>"`. Strip display name with a regex before passing to `create_draft`.

### Legacy path (only relevant when Phase 5b is invoked)
- **gws `invalid_grant`** — OAuth token expired. User runs `! gws auth login`. Verify with `gws auth status` afterwards. If recurring, publish the OAuth consent screen to Production via Google Cloud Console (kills the 7-day testing-mode refresh-token expiry).
- **`--upload ... outside the current directory`** — irrelevant; act.js uses direct REST POST (not `gws --upload`).
- **Draft subject shows as `Ã—` or mangled chars** — act.js already RFC 2047-encodes non-ASCII subjects. Check that act.js wasn't edited to remove the base64-encoded-word logic.
- **Gmail returns 413 (Request Entity Too Large)** — media kit PDF grew beyond ~5MB. Compress the PDF or refactor act.js to use Gmail's resumable upload endpoint.
