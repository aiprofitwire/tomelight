# Contributing to Tomelight

Thanks for helping. Tomelight is small on purpose: a fast, good-looking reader for the files AI tools produce, with just enough editing to finish the job. Contributions that keep it that way are the easiest to merge.

## Ways to help

- **Report a bug.** Use the bug template and attach the smallest Markdown or HTML file that shows the problem. Remove anything private first.
- **Suggest a feature.** Tell us the job you're trying to get done, not only the button you want. "I tick 30 boxes in a content calendar every week" beats "add bulk select".
- **Send a pull request.** For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Run it locally

You need Node 20 or newer and a Mac (the app runs on Linux too for development, packaging targets macOS).

```bash
npm install
npm start      # builds the renderer and launches Electron
npm test       # unit tests for the Markdown and image helpers
```

## Project layout

| Path | What lives there |
|---|---|
| `src/main/` | Electron main process: windows, menus, file IO, settings, the `tlpage://` protocol for HTML pages |
| `src/renderer/app.js` | The whole UI: tabs, modes, sidebar, notes, Image Studio |
| `src/renderer/markdown.js` | Rendering and the pure text helpers (task toggles, table checkboxes, Tidy) |
| `src/renderer/writer.js` | Write mode (TipTap) and its Markdown round trip |
| `src/renderer/editor.js` | Split and Source mode (CodeMirror 6) |
| `src/renderer/webp.js` | Image resizing, WebP output and the metadata scrubber |
| `src/renderer/copyas.js` | Copy for email, web and social, and Paste as Markdown |
| `test/` | Unit tests (`node --test`) |
| `examples/` | Sample workspace for trying features |
| `site/` | The launch page, published to GitHub Pages by `.github/workflows/pages.yml` |

## Ground rules for changes

1. **Never lose a user's words.** Anything that writes to a file must be atomic and must round-trip what it didn't touch. Add a test in `test/unit.test.mjs` for any new text transform.
2. **No network calls.** Tomelight works offline and sends nothing anywhere. Bundle assets instead of loading them from a CDN.
3. **Plain language in the UI.** Labels should make sense to someone who has never heard the word Markdown.
4. **Keep it fast.** Big dependencies need a good reason. Mermaid loads lazily for that reason.
5. **Match the existing style.** Two-space indent, single quotes, semicolons.

## Pull request checklist

- [ ] `npm test` passes
- [ ] You tried the change in the running app (`npm start`)
- [ ] UI changes include a before and after screenshot
- [ ] New behavior is mentioned in `CHANGELOG.md` under Unreleased

By contributing, you agree your work is released under the MIT License.
