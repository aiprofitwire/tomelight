# Changelog

All notable changes to Tomelight are listed here. Dates are in YYYY-MM-DD.

## [Unreleased]

## [1.1.0] - 2026-10-14

### Added
- Highlighter. Select text in Read or Reader view and pick a color from the selection bar, or press `⇧⌘H`. Highlights are painted over the page and stored inside Tomelight, so your file is never changed.
- Each color means something: yellow is Important, red is Fix this, blue is Question, green is Keep. Click any highlight to change its color, add a note or remove it.
- Copy as AI feedback. One click turns your highlights and notes into a ready-made message, grouped by fixes, questions, what matters and what to keep, that you paste back into ChatGPT, Claude or Gemini.
- Highlights find their sentence again after your AI rewrites the file. Passages that were rewritten are flagged, left out of the feedback, and can be cleared in one click.
- Highlights panel (click the count in the status bar) to see, jump to, copy as Markdown or remove every highlight on a file.

### Changed
- Image settings now live in one place. Settings used to show its own Max width and Quality buttons with different sizes than Image Studio; it now opens Image Studio instead.

## [1.0.1] - 2026-10-01

### Changed
- Wire is now the default theme for new installs. Every other theme is still one click away in Settings.

### Fixed
- Opening Tomelight while an older copy was still running in the background could crash the new copy. It now hands off to the running copy and exits cleanly.

## [1.0.0] - 2026-10-01

The first public release.

### Reading
- Markdown opens as a typeset document: tables, callouts, footnotes, front matter cards, syntax-highlighted code and Mermaid diagrams.
- Open a whole folder, with files in vertical tabs, an outline panel, quick open (`⌘P`) and a command palette (`⌘K`).
- HTML files render like a browser tab, each in its own sandbox, with Page, Reader, Split and Source views.
- Themes: Nebula, Arcane, Parchment and Wire, plus Auto.
- Text zoom from 70% to 200% with a slider, `⌘+` and pinch.

### Editing
- Click any checkbox, including checkboxes inside table cells, and it saves to the file.
- Write mode: edit like a doc, save as Markdown.
- Split and Source modes with a formatting toolbar that writes Markdown for you.
- Tidy (`⌥⌘T`) fixes common AI and copy-paste formatting problems.
- Mark Done stamps a finished seal on a file.

### Sharing
- Copy for email (rich text), web (clean HTML) and social (plain text with X and LinkedIn character counts).
- Paste as Markdown from websites and Google Docs.
- Export to PDF and HTML.

### Image Studio
- Recipes for blog posts, pins, Instagram, Stories, YouTube thumbnails, product photos, banners and newsletters.
- WebP, JPEG or original format, with crop-to-shape and SEO file names.
- Removes GPS location, camera details, EXIF, XMP and IPTC from every image.
- Reads iPhone HEIC photos. Download everything as a zip.

### Notes
- Sticky notes pinned to sections of Markdown and HTML files, stored in the app and never written into the file.
