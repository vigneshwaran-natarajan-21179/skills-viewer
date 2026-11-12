# Skills Viewer

A local dashboard for discovering, inspecting, editing, and reusing AI agent skills. No cloud, account, Electron shell, package install, database, or background watcher.

## Run

Requires Node.js 22 or newer.

For an existing checkout, open a terminal in the application folder. For a fresh private clone, first run `git clone YOUR_PRIVATE_REPOSITORY_URL` and `cd skills-viewer` (replace the URL with the repository's clone URL; GitHub authentication is required).

```sh
node --version
npm start
```

Open **http://127.0.0.1:4317**. No `npm install` is needed. Stop with Ctrl+C. To use another port: `PORT=4320 npm start`. Restart the server after changing backend code; browser refresh alone reloads only frontend assets.

```sh
npm test
npm run check
```

## Pages and in-app help

The **Help & FAQ** page includes these explanations, folder examples, troubleshooting, and startup steps. The information icons and **About this page** disclosures link to the relevant answers.

| Page | Purpose |
| --- | --- |
| Library | Combined inventory of registered skill locations. Search, inspect, edit original instructions, share a link/copy, or remove one selected location. It is not a storage folder. |
| Agents | Named skills destinations and explicit path-existence evidence. Configure a built-in or add a custom agent. No installation or skill compatibility is inferred. |
| Workspaces | Registered repositories or direct skill collections. Discover candidate repositories and explicitly register them. |
| Activity | Last 200 sharing/removal/restore events, managed-link disconnection, and pending recovery entries with Restore. |
| Help & FAQ | Definitions, link/copy behavior, detection rules, architecture, filesystem layout, privacy, and recovery rules. |

An **agent** is the named tool/destination. A **workspace** is a local project directory. A **skill** is a directory containing `SKILL.md` and optional supporting files. **System level** means this user's home-directory agent locations, not all operating-system accounts.

## What agent detection actually means

There is **no AI-based discovery**, executable lookup, package inspection, or process inspection. The built-in list in [core.mjs](./core.mjs) contains known names and paths. Sahaa and Zllm are presets because the original requirements named them; their evidence paths are `~/.sahaa` and `~/.zllm`. Those paths existing does not prove installation, current usage, or skills support.

The **Known agent paths** count excludes Shared library and counts existing evidence paths. Agents shows each exact checked path separately from its skills destination. Sahaa and Zllm have no default skills destination. After configuring an agent, its evidence path becomes the configured skills folder.

A newly installed, unknown agent will **not** appear automatically. Use **Agents → Add agent** and enter its documented skills path. Rescan then checks that registered path. Directories created by sharing count as path evidence too; nothing about that is an installation detector.

## Rescan versus Discover folders

**Rescan** is read-only. It rechecks registered sources, reads skill metadata, resolves directory symlinks, refreshes counts, and reports errors. It does not register new workspaces, copy/link files, execute scripts, or modify skills. Inventory reads also happen on page load and after changes. There is no background watcher.

**Discover folders** searches bounded common project locations for repositories with known skill paths and suggests candidates. Registration remains explicit. It does not discover unknown agent brands or recursively crawl the whole disk.

## Workspace to agent: logs_fw → Sahaa

1. **Workspaces → Add workspace:** enter the absolute path to your `logs_fw` repository. A folder containing skill directories also works. **Discover folders** can find repositories under common project directories.
2. **Agents → Sahaa → Configure:** enter the exact skills folder Sahaa loads. This app deliberately does not assume Sahaa or Zllm support `SKILL.md` or invent a folder convention for them. If an agent does not implement skills, putting files in a folder cannot add that capability.
3. **Library:** select a workspace skill, inspect the instructions and supporting filenames, then **Share with agents**.
4. Choose **Link to source** and Sahaa. Optionally select **Shared library** and other agents too. The full skill directory, including scripts and references, becomes accessible at the destination.

Links work independently of the dashboard. Close the dashboard/server when not in use. Agent reload behavior varies; start a new agent session or use its reload command if it caches skills.

## Discovery and sharing

- Built-in system locations: `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.cursor/skills`, and `~/.gemini/skills`. These are configurable. Detected means the relevant folder exists, not that an agent executable or version has been verified.
- Workspace locations: `.agents/skills`, `.github/skills`, `.claude/skills`, `.codex/skills`, `.copilot/skills`, `.cursor/skills`, `.gemini/skills`, or a directly registered folder containing skill directories. Each skill is a directory containing a regular `SKILL.md`.
- The current working directory is registered initially. Other repositories require registration; discovery suggests candidates but never registers them silently. It searches common `Projects`, `AI Projects`, `Developer`, `code`, `repos`, `work`, and `git` folders and the current project's parent, up to three levels and 1,500 directories. It does not recursively crawl your home directory.
- Skills linked to the same real directory appear once, with all discovered locations. Independent copies appear separately.
- **Link:** no duplicated files; changes to the source affect all links. Moving/deleting the source breaks its links. Agents must support directory symlinks.
- **Copy:** independent snapshot of the full directory. Future edits do not propagate. Copies containing symbolic links or special files are rejected; copies are capped at 25 MiB and 2,000 files/folders.
- **Shared library** follows the `.agents/skills` convention. It is not automatically supported by every agent. For explicit access, share to each configured agent destination.
- Existing destinations are never overwritten, merged, or deleted. Conflicts and partial multi-agent failures are reported per destination.
- Editing `SKILL.md` changes the original source, not a local dashboard copy. Saves check for stale content and use atomic replacement; confirm before saving. This is not a replacement for version control, and simultaneous external writers are not locked out.
- **Activity → Disconnect link** removes only an unchanged symbolic link created by this application. Source files are never deleted. Copies are intentionally not auto-deleted.
- Removing a registration forgets a source/destination only; it does not remove skills or existing links.
- Discovery is bounded at 6,000 candidate skill folders per inventory. `SKILL.md` preview/edit is capped at 512 KiB; inventory names/descriptions are shortened to 160/500 characters. Only a small metadata subset (name and description, including common folded/literal blocks) is parsed; the original Markdown is shown as escaped text, never executed or rendered as raw HTML.

## Remove and restore skills

1. Select the skill in **Library → Remove skill**.
2. Select the exact location and type the skill name to confirm.
3. A symbolic-link location moves only that link to recovery storage; its source stays untouched. An original/copy moves the entire directory, including supporting files.
4. Open **Activity → Removed skills → Restore** to restore the location.

Original sources with other registered locations cannot be removed until those links/registrations are removed. Links outside registered folders cannot be detected: check other consumers first. Removal refuses stale documents or changed locations. Restoring refuses occupied original paths and missing link targets.

Recovery storage is `<profile>/trash/<removal-id>/skill`, **not** the OS Trash. Moves are atomic and must stay on the same filesystem; cross-filesystem removal is refused without deleting or copying the source. There is no automatic expiry or permanent-delete action. Pending recovery records survive history trimming; empty recovery directories may remain after restoration. Recovery is not a version-control backup.

## Architecture and folder structure

In these paths, `~` means your home folder; names beginning with a dot are normally hidden folders on macOS/Linux. Workspace skill folders belong inside the relevant repository, not inside this dashboard's installation directory.

```text
Browser (HTML/CSS/JavaScript)
  -> local HTTP JSON API (server.mjs, 127.0.0.1)
  -> validated filesystem operations (core.mjs)
  -> registered skills + local settings/recovery storage
```

The browser cannot directly read the disk. The Node process operates with your user's permissions. Mutating API requests are serialized and require the current session token. Run one server per profile; other processes and external filesystem writers are not locked out.

```text
skills-viewer/
  package.json        Start, test, and syntax-check commands
  server.mjs          Loopback HTTP server, static assets, API routing
  core.mjs            Discovery, metadata, sharing, editing, removal, settings
  index.html          Library, Agents, Workspaces, Activity, Help & FAQ
  app.js              Frontend state, navigation, forms, API requests
  styles.css          Application layout/styles
  tokens.css          Theme variables
  base.css            Base styling
  icon.svg            App icon
  test/app.test.mjs   Isolated filesystem and HTTP regression checks
  README.md           Setup and operational documentation

~/.config/skills-viewer/
  settings.json       Agent/workspace registry, history, pending recovery
  trash/<id>/skill    Archived skill directory or symbolic link
```

A repository skill example:

```text
logs_fw/.github/skills/log-triage/
  SKILL.md
  scripts/            Optional
  references/         Optional
```

**Link to source** creates a symbolic link such as `~/.copilot/skills/log-triage` pointing to that directory. The source and destination read the same underlying files; no periodic sync occurs. The original source must stay available, and the receiving agent must support that location and symlinks.

## Privacy and footprint

Uses Node's HTTP/filesystem modules and plain HTML/CSS/JavaScript with local system fonts. No runtime dependencies or external network requests. There is no polling: use **Rescan** after external changes. The footer reports the live server process RSS, not browser memory.

The server binds only to `127.0.0.1`. It checks Host and Origin, rejects cross-site requests, uses a per-process token for mutations, and serves only an explicit static asset list. It runs with your filesystem permissions: do not expose it through a network proxy or run it as root. Skill scripts are never executed by this app; review skills before allowing agents to run them.

Settings, the last 200 activity events, and unexpired recovery records are stored atomically in `~/.config/skills-viewer/settings.json`. The directory/file are created only after a configuration change, share, or removal. To isolate data for another profile or testing:

```sh
SKILLS_VIEWER_DATA_DIR=/absolute/path/to/profile npm start
```

Plugin-managed, vendor-specific, disabled, or non-`SKILL.md` instruction formats are not automatically imported. Register a plugin's skills folder explicitly if it follows the directory convention. Custom paths provide file-level integration, not a guarantee of agent compatibility.

The app does not export registered skills when its source is published. Default profile data lives outside the checkout. Keep custom profiles outside the checkout too; `.gitignore` also excludes `settings.json`, `trash/`, `.env` files, and local design metadata. Inspect staged files before publishing.

## Publishing a private repository

From a committed application checkout with GitHub CLI installed:

```sh
gh auth login --hostname github.com --git-protocol https --web
gh repo create skills-viewer --private --source=. --remote=origin --push
gh repo view --json url,visibility
```

Authorize with the GitHub account that should own the repository. Confirm visibility is `PRIVATE`. If that account already has a `skills-viewer` repository or `origin` is already configured, stop and inspect it instead of overwriting its settings or force-pushing.
