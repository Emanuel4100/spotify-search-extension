# Contributing

## Prerequisites

- Node.js and npm
- `glib-compile-schemas` (glib2)
- **GNOME Shell 49** only in [`metadata.json`](metadata.json) until other versions are tested (imports and APIs differ per Shell).

## Workflow

```bash
npm install
npm run typecheck   # tsc --noEmit — run before pushing when TS changes
npm run build       # esbuild → extension.js, prefs.js
npm run compile-schemas
npm run install-ext # copies bundle + schemas + data into ~/.local/share/gnome-shell/extensions/<uuid>/
```

After changing **`schemas/*.xml`**, run **`npm run compile-schemas`**; reinstall so `gschemas.compiled` updates in the extension directory.

## Packaging

```bash
npm run pack
```

Creates `<uuid>.shell-extension.zip` in the repo root (see [`scripts/pack.mjs`](scripts/pack.mjs)).

## Committed bundles

`extension.js` and `prefs.js` are **tracked in git** for convenience. After editing `src/`, run **`npm run build`** and commit the updated bundles so clones match sources.
