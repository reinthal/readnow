# Agent Instructions for ReadNow

## MCP Usage — Context7

**Always use the Context7 MCP server when available** for looking up documentation of non-standard/third-party packages. Do not rely on training data alone for API details — fetch the latest docs via Context7 first.

Packages in this project that require Context7 lookups:

- **elevenlabs** (ElevenLabs Node SDK) — TTS streaming, voice selection, alignment/timestamps API. The SDK evolves frequently; always verify method signatures and streaming patterns against current docs.
- **pdf-parse** — PDF text extraction. Check for API changes, especially around buffer handling.
- **pdf.js** (pdfjs-dist / CDN) — Browser-side PDF rendering. Verify worker setup and rendering API for the version in use.

## When to use Context7

- Before writing or modifying code that calls any third-party SDK method
- When debugging an API error from ElevenLabs or any external service
- When upgrading package versions — check for breaking changes
- When adding new features that rely on SDK capabilities (e.g., voice cloning, new streaming modes)

## Project Overview

ReadNow is a PDF-to-speech web app:
- **Backend**: Node.js + Express + WebSocket. Handles PDF parsing and proxies ElevenLabs TTS streaming with word-level timestamps.
- **Frontend**: Vanilla JS (no framework). PDF.js for rendering, MediaSource API for streaming audio playback, sliding word window for real-time highlighting.
- All application state lives in the frontend. The backend is stateless.
- The ElevenLabs API key is managed via SOPS-encrypted `secrets.env` and loaded through devenv/direnv.
