# Amber web UI

Svelte 5 + Vite. Built static and served by the server from `web/dist`; talks only to `/api`.

- `npm run dev` — Vite dev server, proxies `/api` to `http://localhost:3000` (run the server too).
- `npm run build` — production build into `dist/`.
- `npm run check` — svelte-check + tsc.

Components live in `src/lib/`: `App.svelte` (shell + infinite scroll), `TopBar` (search + filters), `Card`, `Detail` (metadata, note editor, reader/archive), `Reader` (clean text view), `Settings` (token, quick-save, bookmarklet, import/export, maintenance). State is in `src/lib/store.svelte.ts`; the API client and types are in `src/lib/api.ts`.

See the repo root [`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md).
