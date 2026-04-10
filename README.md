# Spotify Search (GNOME Shell extension)

Search and play Spotify from the **Activities overview**. Results use a **list layout** (provider column with a **bundled icon**, album art thumbnails, and **track title — artist**). After you log in, **liked tracks** matching your query appear first on `$play`.

## How it works

1. You type a **command** in overview search (e.g. `$play daft punk`).
2. `[src/command.ts](src/command.ts)` parses the prefix (`$play`, `$queue`, `$album`, …) and the search query.
3. `[SpotifySearchProvider](src/spotify-search-provider.ts)` asks the Spotify **Web API** for results (user token with PKCE or optional **client credentials**). For `$play` on tracks, it may also scan your **saved library** for matches.
4. URIs and API payloads are cached in memory for the session; album art can be cached under the extension directory.
5. Choosing a result **activates** playback: **MPRIS `OpenUri`** (running Spotify), then **Web API** `PUT /me/player/play`, then `**spotify --uri=…`**, then `**xdg-open**`. **Queue** uses `POST /me/player/queue` when logged in.

The extension ships a synthetic `**appInfo`** (`[src/list-app-info.ts](src/list-app-info.ts)` + `[data/spotify-search-sidebar.svg](data/spotify-search-sidebar.svg)`) so GNOME Shell uses **list** search results and shows a reliable sidebar icon even without a host `spotify` desktop/icon.

## How to use

1. **Install** the extension (see [Install](#install)) and **enable** it; restart the session on Wayland if needed (`metadata.json` → `uuid`).
2. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), open the app that matches the **bundled client id** (or your own if you override `client-id`) and add redirect URI `**http://127.0.0.1:8080`** exactly (or the custom URI you configure below).
3. Open **Extension preferences** → enable **Use custom redirect URI** only if you need a different loopback URL; otherwise the default applies without typing it.
4. Click **Log in with Spotify** and finish the browser flow.
5. Open **Activities**, start typing:
  - `**$play …`** / `**$p**` — search tracks (and liked-first when logged in).  
  - `**$queue …**` / `**$q**` — add to queue (Premium + device; see troubleshooting).  
  - `**$artist**`, `**$album**`, `**$playlist**` — other search types.  
   Use `**&**` instead of `**$**` if you prefer.

Optional: **Notify on play and queue** in preferences for success toasts (errors always notify).

## Requirements


| Requirement          | Notes                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GNOME Shell**      | **49 only** in `[metadata.json](metadata.json)`. Older versions are unsupported until tested.                                                                                 |
| **libsoup 3**        | `gi://Soup?version=3.0` — ensure **libsoup3** / typelibs are installed.                                                                                                       |
| **Spotify client**   | Snap, Flatpak, or distro package for local playback; Web API can drive an active device.                                                                                      |
| **OAuth redirect**   | Default `**http://127.0.0.1:8080`**. The local callback server listens on **IPv4**; use `**127.0.0.1`** in the dashboard unless you enable a custom URI that matches exactly. |
| **Build (from git)** | **Node.js + npm**, `**glib-compile-schemas`** (e.g. **glib2** package).                                                                                                       |


**Spotify Premium** is typically needed for **Web API playback** and **queue**; search may work with client credentials without login (advanced).

## Install

### Generic (any distro)

```bash
git clone https://github.com/emanuel/spotify-search-extension.git
cd spotify-search-extension
npm install
npm run install-ext
gnome-extensions enable spotify-search@emanuel.github.io
```

Then **log out and back in** (Wayland) or restart GNOME Shell, add the redirect URI in the Spotify app, open **Extensions → Spotify Search → preferences** → **Log in**.

### Fedora (example)

```bash
sudo dnf install nodejs npm glib2 gnome-extensions-app
```

Then the same `git clone` / `npm install` / `npm run install-ext` / `gnome-extensions enable …` steps as above.

### Built artifacts in git

This repository **includes** committed `[extension.js](extension.js)` and `[prefs.js](prefs.js)` so a raw clone can be copied into `~/.local/share/gnome-shell/extensions/<uuid>/` without Node. **If you change `src/`, run `npm run build` (and `npm run typecheck` before pushing)** so the bundles stay in sync.

### extensions.gnome.orgdaft

```bash
npm run pack
```

Produces a `.shell-extension.zip` with `gschemas.compiled`, `data/`, and bundled JS. Verify `uuid` matches `[metadata.json](metadata.json)`.

## Clean reinstall

Use when upgrading from git or if prefs/tokens behave oddly.

1. `gnome-extensions disable spotify-search@emanuel.github.io`
2. `rm -rf ~/.local/share/gnome-shell/extensions/spotify-search@emanuel.github.io` or `**npm run uninstall-ext**`
3. Optional: `gsettings reset-recursively org.gnome.shell.extensions.spotify-search`
4. `**npm run install-ext**`, then `gnome-extensions enable spotify-search@emanuel.github.io`
5. Log out/in or restart Shell on Wayland

**One-shot:** `npm run reinstall-ext` (optional logout prompt).

## Commands


| Command                                                 | Action                                        |
| ------------------------------------------------------- | --------------------------------------------- |
| `$play …`, `$p`, `$track`, `$t` (or `**&`**)            | Tracks; art; liked matches first if logged in |
| `$queue …`, `$q`                                        | Add track to queue (Premium + device)         |
| `$artist` / `$a`, `$album` / `$al`, `$playlist` / `$pl` | Other types                                   |


## Auth

### Default (PKCE)

**Log in** in preferences. Scopes: `**user-modify-playback-state`**, `**user-library-read**`.

**Redirect URI mismatch:** the Spotify app must list the same URI the extension uses (default `**http://127.0.0.1:8080`**, or your **custom** value when that switch is on).

### Client credentials (optional)

Set `**client-id`** and `**client-secret**` via `gsettings` for [client-credentials](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow) **search without login**. `**$queue`** and liked-first still need **Log in**.

## Search result layout & provider icon

Shell uses **list** results when `appInfo` is set. This extension supplies `**GioUnix.DesktopAppInfo`** with an absolute `**Icon=**` path to `[data/spotify-search-sidebar.svg](data/spotify-search-sidebar.svg)`, with fallback `[data/spotify-search.extension.desktop](data/spotify-search.extension.desktop)`.

**Do not set `NoDisplay=true` on the stub desktop:** it makes `should_show()` false and the provider may not register (`[search.js](https://gitlab.gnome.org/GNOME/gnome-shell)` / parental controls).

## Playback order

**MPRIS `OpenUri`** → **Web API** play → `**spotify --uri=…`** → `**xdg-open**`.

If `**gdbus … OpenUri**` returns `**ServiceUnknown**`, Spotify was not on the session bus. Logs: `journalctl /usr/bin/gnome-shell -f | rg spotify-search`.

## Troubleshooting

- **Queue:** Premium usually required; active device helps; extension can transfer playback after 404.
- **Settings / login:** run `**npm run install-ext`** so `gschemas.compiled` is installed. Revoke app access under **Spotify → Account → Apps** if tokens misbehave.
- **Preferences:** loaded from `**prefs.js`** in the extension directory; rebuild after `src/prefs.ts` changes.

## Liked songs first

Up to **100** saved tracks per page are scanned (see `[src/search-constants.ts](src/search-constants.ts)`); matches prepend catalog results.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Source layout highlights: `[src/extension.ts](src/extension.ts)` (enable hook), `[src/spotify-search-provider.ts](src/spotify-search-provider.ts)` (search + playback), `[src/spotify-web.ts](src/spotify-web.ts)` (API client), `[src/prefs-oauth.ts](src/prefs-oauth.ts)` (browser login + local callback server).

```bash
npm install
npm run typecheck   # TypeScript (no emit)
npm run build
npm run compile-schemas
```

## Possible future features

- More search types (shows, episodes) where the API allows  
- Configurable liked-scan / search limits (gsettings)  
- gettext / i18n for notifications and prefs  
- GNOME Shell **48** (or broader) support after import testing  
- Optional shortcut or panel entry to open overview search with a `$play`  prefix  
- Art cache size / TTL limits

## Credits

Inspired by [spotify-search-provider](https://github.com/arrufat/spotify-search-provider).