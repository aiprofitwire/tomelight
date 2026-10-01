# Security Policy

Tomelight opens files from your disk, and some of those files (HTML pages) can run code. We take that seriously.

## How HTML pages are isolated

- Each HTML file loads from its own `tlpage://` origin inside a sandboxed frame, separate from the app.
- A page can only read files inside its own folder. Requests outside it are refused.
- Pages cannot reach Tomelight's internals, your settings or other files.
- Markdown is sanitized with DOMPurify before it is shown.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private reporting instead: open the **Security** tab of this repository and click **Report a vulnerability**. Include:

- what an attacker could do,
- a file or steps that reproduce it,
- the Tomelight version and macOS version.

You'll get a reply within 7 days. Once a fix ships, we're happy to credit you in the changelog.

## Supported versions

Security fixes go into the latest release.
