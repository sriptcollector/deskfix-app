# DeskFix (desktop app)

A small assistant that floats on your Mac or Windows screen. Tell it the problem by typing or speaking. It has four parts: **Chat**, **Fix for me**, **Teach me** and **History**.

- **Fix for me**: it looks at your screen, finds the cause and shows what it will change. Nothing changes until you press **Allow fix**. Then it does the work, checks the result, and says "Problem solved" only after the check.
- **Teach me**: it highlights where to click and you do each step. Say **Do it for me** at any point.
- **Stop** and **pause screen viewing** are always on the assistant.

This repository is the whole desktop app, open so anyone can check what it does on their computer. The service it talks to (sign-in, billing, the AI) runs at api.trydeskfix.com. Website: [trydeskfix.com](https://trydeskfix.com).

## What leaves your computer
- **Pictures of your screen**, only during a help session you started, scaled down before they are sent. The server does not keep them.
- **Your voice**, only while the mic is on, turned into words and not kept.
- **What you type** in the help box.
- A short note per problem (your history). It is deleted after 30 days. You can turn it off or clear it in Preferences.

## Rules the AI can't change
These live in this code, not on the server (`app/src-tauri/src/input.rs`, `app/src/agent.ts`):
- No click, typing or setting change happens before you press Allow fix.
- It never types card numbers, social security numbers or one-time codes; you type those.
- Moving the mouse, pressing Esc, saying "stop" or pressing Stop halts everything at once.
- While screen viewing is paused, no picture of the screen is taken.
- Its own windows are hidden from the pictures the AI sees.

## Build it yourself
Needs [Bun](https://bun.sh) and [Rust](https://rustup.rs).
```
cd app
bun install
bunx tauri build
```
Checks: `bunx tsc -b`, `cargo test --lib` (in `app/src-tauri`), and `node scripts/screens.mjs <folder>` (walks every screen and the Allow fix / Cancel / Teach flows against a fake server).

Builds are made by `.github/workflows/release.yml`; each lists its SHA-256. `firstrun.yml` installs a build on fresh Mac and Windows machines with no permissions granted. `tasks.yml` runs real fix and teach tasks.

## License
GPL-3.0. See `LICENSE`.
