# Repository Guidelines

## Project Structure & Module Organization
This repository is a Chrome Manifest V3 extension. Keep the file boundaries intact:

- `manifest.json`: extension metadata, permissions, icons, and entry points.
- `background.js`: service worker for session state, Chrome APIs, CDP capture, zip export, and skill packaging.
- `content-script.js`: DOM event capture injected into web pages.
- `popup.html`, `popup.css`, `popup.js`: toolbar popup UI and user actions.
- `icons/`: packaged extension icons.
- `README.md`: user-facing setup and export format notes.

There is no `src/` build layer. Edit runtime files directly.

## Build, Test, and Development Commands
- `node --check background.js`
  Validates service worker syntax.
- `node --check content-script.js`
  Validates content script syntax.
- `node --check popup.js`
  Validates popup logic syntax.
- `chrome://extensions`
  Enable Developer Mode, then use `Load unpacked` or `Reload` on this folder for manual testing.
- `git status --short`
  Review local changes before commit.

## Coding Style & Naming Conventions
- Use 2-space indentation in JSON and 2 spaces in JS/CSS/HTML to match the existing files.
- Prefer plain ES modules style without build tooling; keep code browser-native and MV3-compatible.
- Use descriptive camelCase for functions and variables, for example `buildSkillPackage`, `recordDomEvent`.
- Keep filenames lowercase with hyphenated or simple names already used in the repo, such as `content-script.js`.
- Do not introduce unnecessary dependencies or build steps.

## Testing Guidelines
There is currently no automated test framework. Use focused manual verification:

- Reload the unpacked extension after each change.
- Test `Start`, `Stop`, and `Export Skill` flows from the popup.
- Verify generated zip contents: `meta.json`, `index.json`, `step.llm.md`, `steps/`, and `raw/`.
- For code changes, run `node --check` on every edited JavaScript file.

## Commit & Pull Request Guidelines
Recent commits use short imperative messages, for example:

- `Add browser skill recorder extension`
- `Add extension icons`

Follow that pattern: `Add ...`, `Fix ...`, `Update ...`. Keep each commit scoped to one change. PRs should include a concise summary, manual test notes, and screenshots when popup or icon visuals change.

## Security & Configuration Tips
- Do not weaken permissions casually; changes to `debugger`, `downloads`, `tabs`, or `host_permissions` need justification.
- Keep sensitive input redaction behavior intact, especially password handling in `content-script.js`.
