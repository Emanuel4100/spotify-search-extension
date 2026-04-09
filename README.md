# Spotify Search (GNOME Shell extension)

Search Spotify from the Activities overview using a `$` prefix, then play via the desktop Spotify client (MPRIS). Optional browser login is only needed for **Add to queue** (`$queue` / `$q`).

## Requirements

- GNOME Shell 49 (adjust `shell-version` in `metadata.json` if you use another release).
- [Spotify for Linux](https://www.spotify.com/download/linux/) (or another build that exposes MPRIS as `org.mpris.MediaPlayer2.spotify`).
- A [Spotify Developer](https://developer.spotify.com/dashboard) app with **Redirect URI** exactly: `http://localhost:8080`

## Commands (Activities search)

| Command | Action |
|--------|--------|
| `$play …`, `$p …`, `$track …`, `$t …` | Search tracks; Enter plays via MPRIS |
| `$queue …`, `$q …` | Search tracks; Enter adds to queue (requires Log in in settings) |
| `$artist …`, `$a …` | Search artists |
| `$album …`, `$al …` | Search albums |
| `$playlist …`, `$pl …` | Search playlists |

Only queries that start with a supported `$` command hit the Spotify API. Normal overview search is unchanged.

## Auth

1. **Search + play**: set **Client ID** and **Client Secret** in extension preferences. The extension uses Spotify’s [Client Credentials](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow) flow for catalog search. No Spotify account login in the browser.
2. **Queue**: click **Log in with Spotify** once so a refresh token is stored. Uses scope `user-modify-playback-state`.

## Build and install

```bash
npm install
npm run install-ext   # copies to ~/.local/share/gnome-shell/extensions/<uuid>/
gnome-extensions enable spotify-search@emanuel.github.io
```

Then restart GNOME Shell (log out/in or `Alt+F2` → `r` on X11) or disable/enable the extension.

## Pack a zip (extensions.gnome.org or manual install)

```bash
npm run pack
```

Produces `<uuid>.shell-extension.zip` containing `metadata.json`, `extension.js`, `prefs.js`, and `schemas/`.

Update `uuid` and `url` in [metadata.json](metadata.json) to match your own namespace and repository before publishing.

If you previously used `spotify-search@yourname.example.com`, disable and remove that folder under `~/.local/share/gnome-shell/extensions/` before enabling the new UUID.

## Feature ideas (backlog)

- Debounce or stronger cancellation for very fast typing.
- Album art in result rows (remote `Gio.FileIcon` with fallback).
- Configurable prefix and default entity type via GSettings.
- Subsearch that filters previous URIs without a new API call when the query only adds characters.
- Clear error when queue fails (no active device, premium required, etc.).
- Translations (`gettext-domain`).

## Credits

Inspired by community tools such as [spotify-search-provider](https://github.com/arrufat/spotify-search-provider).
