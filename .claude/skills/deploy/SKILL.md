---
name: deploy
description: Deploy obsidian-spaced-repetition plugin to local Obsidian vault. Use when user says /deploy, "部署", "deploy", "部署到 obsidian", "更新插件", "deploy plugin". Builds and copies plugin files to ~/webric/.obsidian/plugins/obsidian-spaced-repetition-rickwen/.
---

# Deploy to Obsidian

Target: `~/webric/.obsidian/plugins/obsidian-spaced-repetition-rickwen/`

## Workflow

1. Ask user which deploy mode using AskUserQuestion:

| Mode | Build? | Files copied |
|------|--------|-------------|
| code | Yes | `main.js` |
| css | No | `styles.css` |
| code+css | Yes | `main.js` + `styles.css` |
| full | Yes | `main.js` + `styles.css` + `manifest.json` |

2. If target dir doesn't exist, `mkdir -p` first.
3. Run build if needed: `pnpm build`
4. If build fails, stop immediately. Do not copy stale files.
5. Copy files per selected mode. Source paths:
   - `build/main.js` (build output)
   - `styles.css` (project root)
   - `manifest.json` (project root)
6. Never overwrite `data.json` — that's Obsidian's plugin settings.
7. Remind user to reload plugin in Obsidian (toggle off/on or Cmd+R).
