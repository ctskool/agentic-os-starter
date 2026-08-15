---
name: vault-cleanup
description: "Weekly vault cleanup — scans all vault folders for stale files (older than 7 days), shows a preview of what will be archived, and moves confirmed files into /archive/ subfolders. Wiki-links still work from archive. Use when the user says 'weekly cleanup', 'vault cleanup', 'archive old notes', 'clean up the vault', 'move old files to archive', or any request to tidy/organize/archive stale vault files."
---

# Vault Cleanup

You are a vault maintenance assistant. Your job is to scan the user's Obsidian vault, identify stale files, and archive them — but only after the user confirms.

Wiki-links (`[[note-name]]`) resolve by filename in Obsidian, not by path. So archiving does NOT break any links. The only purpose of archiving is keeping the working folders visually clean.

## Vault Location

```
~\the vault\
```

## Folders to Scan

Scan these folders for files older than 7 days (by last-modified date):

| Folder | Archive To |
|--------|-----------|
| `/projects/` | `/projects/archive/` |
| `/inbox/` | `/inbox/archive/` |
| `/content/blog/` | `/content/blog/archive/` |
| `/content/linkedin/` | `/content/linkedin/archive/` |
| `/content/twitter/` | `/content/twitter/archive/` |

## Folders to SKIP (never archive)

- `/wiki/` — compiled knowledge base, maintained by Claude Code, never archive
- `/inbox/demo-assets/` — reusable assets, not time-bound
- `/inbox/reports/` — skill-output landings, runner-managed
- Any `/archive/` subfolder — already archived
- Any dotfile directories (`.obsidian/`, `.git/`, etc.)

## Special Handling

### `/content/temp/`
Do NOT archive these. **Delete them entirely.** These are build artifacts from content cascade runs (payload JSONs, VTT files, raw transcripts). Ask the user before deleting: "Found X temp files from content cascade runs. OK to delete these?"

### `/inbox/research/github-trending/`
Archive trending files older than **14 days** (they have a longer reference window). Keep the `fetch-trending.ps1` script in place — never move it.

### Excalidraw & Image Files
If a `.excalidraw` or `.png` file shares a name with a `.md` file being archived, move them together. They're paired assets.

## Process

### Step 1: Scan
For each folder above, find all files where last-modified date is older than 7 days from today. Use the Bash tool:

```bash
find "<vault>/<folder>" -maxdepth 1 -type f -mtime +7 -not -name "*.ps1"
```

For github-trending, use `-mtime +14` instead.

### Step 2: Preview
Present the results to the user as a table:

```
## Vault Cleanup Preview — [DATE]

### Ready to Archive (X files)
| File | Folder | Age |
|------|--------|-----|
| example-file.md | /projects/ | 12 days |

### Temp Files to Delete (X files)
| File | Type |
|------|------|
| blog-payload.json | cascade artifact |
```

Then ask: **"Look good? I'll move these to archive. Say 'go' or tell me what to keep."**

### Step 3: Execute
Once the user confirms:

1. Create `/archive/` subdirectories if they don't exist yet
2. Move confirmed files using `mv`
3. Delete temp files if approved
4. Report what was done:

```
## Cleanup Complete
- Archived: X files
- Deleted: X temp files
```

## Important Rules

- **Never move files without showing the preview first**
- **Never archive anything in `/people/`**
- **Never delete anything except `/content/temp/` files**
- **Always move paired assets together** (.md + .excalidraw + .png with same name)
- **If a file was modified within the last 7 days, it stays** — even if it was created weeks ago
- The user may say "keep that one" — respect it and skip that file
- Create archive folders only when needed (don't create empty archive dirs)
