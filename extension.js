// src/extension.ts
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main2 from "resource:///org/gnome/shell/ui/main.js";

// src/log.ts
function logExtensionError(err, context) {
  console.error(`[spotify-search] ${context}:`, err);
}

// src/spotify-search-provider.ts
import Gio3 from "gi://Gio";
import GioUnix2 from "gi://GioUnix";
import GLib5 from "gi://GLib";
import St from "gi://St";
import Soup2 from "gi://Soup?version=3.0";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// src/command.ts
function parseSpotifyCommand(query) {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("$") && !q.startsWith("&")) return null;
  const parts = q.substring(1).trim().split(/\s+/);
  const cmd = parts[0] ?? "";
  const arg = parts.slice(1).join(" ").trim();
  if (!arg) return null;
  if (cmd === "p" || cmd === "play" || cmd === "t" || cmd === "track")
    return { searchQuery: arg, searchType: "track", activation: "play" };
  if (cmd === "q" || cmd === "queue")
    return { searchQuery: arg, searchType: "track", activation: "queue" };
  if (cmd === "a" || cmd === "artist")
    return { searchQuery: arg, searchType: "artist", activation: "play" };
  if (cmd === "al" || cmd === "album")
    return { searchQuery: arg, searchType: "album", activation: "play" };
  if (cmd === "pl" || cmd === "playlist")
    return { searchQuery: arg, searchType: "playlist", activation: "play" };
  return null;
}

// src/search-constants.ts
var MAX_RESULTS = 10;
var SAVED_PAGES = 2;
var SAVED_LIMIT = 50;
var ART_PREFETCH_CONCURRENCY = 4;

// src/list-app-info.ts
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";
var DESKTOP_GROUP = "Desktop Entry";
function createListDesktopAppInfo(extensionBasePath) {
  try {
    const kf = new GLib.KeyFile();
    kf.set_string(DESKTOP_GROUP, "Type", "Application");
    kf.set_string(DESKTOP_GROUP, "Name", "Spotify");
    kf.set_string(DESKTOP_GROUP, "Exec", "/usr/bin/true");
    kf.set_boolean(DESKTOP_GROUP, "Terminal", false);
    const svgPath = GLib.build_filenamev([extensionBasePath, "data", "spotify-search-sidebar.svg"]);
    const icon = GLib.file_test(svgPath, GLib.FileTest.EXISTS) ? svgPath : "audio-x-generic";
    kf.set_string(DESKTOP_GROUP, "Icon", icon);
    return GioUnix.DesktopAppInfo.new_from_keyfile(kf);
  } catch (e) {
    logExtensionError(e, "createListDesktopAppInfo");
    return null;
  }
}

// src/track-meta.ts
function truncateLabel(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}
function pickSpotifyImageUrl(item) {
  const images = item?.album?.images || item?.images;
  if (!images?.length) return null;
  const last = images[images.length - 1];
  return last?.url || images[0]?.url || null;
}
function savedTrackMatchesQuery(track, q) {
  if (!track || !q) return false;
  const needle = q.trim().toLowerCase();
  if (track.name?.toLowerCase().includes(needle)) return true;
  for (const a of track.artists || []) {
    if (a?.name?.toLowerCase().includes(needle)) return true;
  }
  return false;
}
function resultDisplayName(item) {
  const raw = item?.name || "Unknown";
  return truncateLabel(String(raw), 120);
}
function trackTitleWithArtists(item) {
  const title = item?.name || "Unknown";
  const artists = item?.artists?.map((a) => a.name).filter(Boolean).join(", ");
  if (artists) return truncateLabel(`${title} \u2014 ${artists}`, 140);
  return truncateLabel(String(title), 140);
}
function itemNotificationLabel(item) {
  const kind = item?._searchType || "track";
  if (kind === "track") {
    const title = item?.name || "Track";
    const artists = item?.artists?.map((a) => a.name).filter(Boolean).join(", ");
    if (artists) return truncateLabel(`${title} \u2014 ${artists}`, 200);
    return truncateLabel(String(title), 200);
  }
  return truncateLabel(item?.name || "Spotify", 200);
}

// src/mpris.ts
import Gio from "gi://Gio";
import GLib2 from "gi://GLib";
function dbusCallSync(busName, objectPath, interfaceName, methodName, parameters, replyType) {
  return Gio.DBus.session.call_sync(
    busName,
    objectPath,
    interfaceName,
    methodName,
    parameters,
    replyType,
    Gio.DBusCallFlags.NONE,
    -1,
    null
  );
}
function listMprisPlayerBusNamesSync() {
  try {
    const reply = dbusCallSync(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      new GLib2.VariantType("(as)")
    );
    if (!reply) return [];
    const unpacked = reply.deepUnpack();
    const names = unpacked[0] ?? [];
    return names.filter((n) => n.startsWith("org.mpris.MediaPlayer2."));
  } catch (e) {
    logExtensionError(e, "DBus ListNames sync");
    return [];
  }
}
function mprisIdentitySync(busName) {
  try {
    const reply = dbusCallSync(
      busName,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib2.Variant("(ss)", ["org.mpris.MediaPlayer2", "Identity"]),
      new GLib2.VariantType("(v)")
    );
    if (!reply) return "";
    const [boxed] = reply.deepUnpack();
    const inner = boxed.deepUnpack();
    return typeof inner === "string" ? inner : "";
  } catch {
    return "";
  }
}
function spotifyMprisBusCandidatesSync() {
  const all = listMprisPlayerBusNamesSync();
  const preferred = "org.mpris.MediaPlayer2.spotify";
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  if (all.includes(preferred)) push(preferred);
  for (const n of all) {
    if (/spotify/i.test(n)) push(n);
  }
  for (const n of all) {
    if (seen.has(n)) continue;
    const identity = mprisIdentitySync(n);
    if (/spotify/i.test(identity)) push(n);
  }
  return out;
}
function openSpotifyUriViaMpris(uri, candidates) {
  const voidReply = new GLib2.VariantType("()");
  for (const busName of candidates) {
    try {
      dbusCallSync(
        busName,
        "/org/mpris/MediaPlayer2",
        "org.mpris.MediaPlayer2.Player",
        "OpenUri",
        new GLib2.Variant("(s)", [uri]),
        voidReply
      );
      return true;
    } catch (e) {
      logExtensionError(e, `MPRIS OpenUri ${busName}`);
    }
  }
  return false;
}

// src/spotify-launch.ts
import Gio2 from "gi://Gio";
import GLib3 from "gi://GLib";
function launchSpotifyAppWithUri(uri) {
  const uriArg = `--uri=${uri}`;
  const homeFlatpak = GLib3.build_filenamev([
    GLib3.get_home_dir(),
    ".local/share/flatpak/exports/bin/com.spotify.Client"
  ]);
  const candidates = [
    "/snap/bin/spotify",
    "/var/lib/flatpak/exports/bin/com.spotify.Client",
    homeFlatpak
  ];
  for (const bin of candidates) {
    if (!GLib3.file_test(bin, GLib3.FileTest.IS_EXECUTABLE)) continue;
    try {
      Gio2.Subprocess.new([bin, uriArg], Gio2.SubprocessFlags.NONE);
      return true;
    } catch (e) {
      logExtensionError(e, `spawn ${bin} --uri`);
    }
  }
  try {
    Gio2.Subprocess.new(["spotify", uriArg], Gio2.SubprocessFlags.NONE);
    return true;
  } catch (e) {
    logExtensionError(e, "spawn spotify --uri (PATH)");
  }
  return false;
}

// src/spotify-web.ts
import GLib4 from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

// src/spotify-config.ts
var BUNDLED_SPOTIFY_CLIENT_ID = "b7c53c9dc6824f13b36049065ae2f12f";

// src/spotify-web.ts
function soupMessageBytesToResult(msg, bytes) {
  const bodyArr = bytes.get_data();
  const bodyText = bodyArr ? (
    // @ts-ignore
    new TextDecoder("utf-8").decode(bodyArr)
  ) : "";
  const status = msg.get_status();
  let json = null;
  try {
    if (bodyText) json = JSON.parse(bodyText);
  } catch {
  }
  return { status, json, bodyText };
}
function spotifyApiErrorMessage(status, json, fallback) {
  const msg = json?.error?.message || json?.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return `${fallback} (HTTP ${status})`;
}
function spotifyEmptySuccess(status, json = null) {
  if (status === 204) return true;
  if (status === 200) return json?.error == null;
  return false;
}
var SpotifyWebClient = class {
  _settings;
  _session;
  userAccessToken = null;
  ccAccessToken = null;
  ccExpiresAt = 0;
  constructor(settings) {
    this._settings = settings;
    this._session = new Soup.Session();
  }
  get session() {
    return this._session;
  }
  get clientId() {
    const fromSettings = this._settings.get_string("client-id").trim();
    return fromSettings || BUNDLED_SPOTIFY_CLIENT_ID;
  }
  get clientSecret() {
    return this._settings.get_string("client-secret");
  }
  get refreshToken() {
    return this._settings.get_string("refresh-token");
  }
  hasClientSecret() {
    return Boolean(this.clientSecret?.trim());
  }
  clearAuthTokens() {
    this.ccAccessToken = null;
    this.ccExpiresAt = 0;
    this.userAccessToken = null;
  }
  _basicAuthHeader() {
    if (!this.clientId || !this.clientSecret) return null;
    const authBytes = new TextEncoder().encode(`${this.clientId}:${this.clientSecret}`);
    return GLib4.base64_encode(authBytes);
  }
  getUserAccessToken(cancellable) {
    if (!this.clientId || !this.refreshToken) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      if (cancellable?.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const msg = Soup.Message.new("POST", "https://accounts.spotify.com/api/token");
      msg.request_headers.append("Content-Type", "application/x-www-form-urlencoded");
      let bodyStr;
      const auth = this._basicAuthHeader();
      if (auth) {
        msg.request_headers.append("Authorization", `Basic ${auth}`);
        bodyStr = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`;
      } else {
        bodyStr = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}&client_id=${encodeURIComponent(this.clientId)}`;
      }
      const bodyBytes = new TextEncoder().encode(bodyStr);
      msg.set_request_body_from_bytes("application/x-www-form-urlencoded", GLib4.Bytes.new(bodyBytes));
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          if (cancellable?.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          const bytes = session.send_and_read_finish(res);
          const dataArray = bytes.get_data();
          if (!dataArray) {
            resolve(false);
            return;
          }
          const text = new TextDecoder("utf-8").decode(dataArray);
          const data = JSON.parse(text);
          if (data.access_token) {
            this.userAccessToken = data.access_token;
            resolve(true);
            return;
          }
        } catch (e) {
          logExtensionError(e, "Spotify getUserAccessToken");
        }
        resolve(false);
      });
    });
  }
  getClientCredentialsToken(cancellable) {
    const auth = this._basicAuthHeader();
    if (!auth) return Promise.resolve(false);
    const now = Date.now();
    if (this.ccAccessToken && now < this.ccExpiresAt - 6e4) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      if (cancellable?.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const bodyStr = "grant_type=client_credentials";
      const bodyBytes = new TextEncoder().encode(bodyStr);
      const msg = Soup.Message.new("POST", "https://accounts.spotify.com/api/token");
      msg.request_headers.append("Authorization", `Basic ${auth}`);
      msg.request_headers.append("Content-Type", "application/x-www-form-urlencoded");
      msg.set_request_body_from_bytes("application/x-www-form-urlencoded", GLib4.Bytes.new(bodyBytes));
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          if (cancellable?.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          const bytes = session.send_and_read_finish(res);
          const dataArray = bytes.get_data();
          if (!dataArray) {
            resolve(false);
            return;
          }
          const text = new TextDecoder("utf-8").decode(dataArray);
          const data = JSON.parse(text);
          if (data.access_token) {
            this.ccAccessToken = data.access_token;
            const sec = Number(data.expires_in) || 3600;
            this.ccExpiresAt = Date.now() + sec * 1e3;
            resolve(true);
            return;
          }
        } catch (e) {
          logExtensionError(e, "Spotify getClientCredentialsToken");
        }
        resolve(false);
      });
    });
  }
  async ensureSearchBearer(cancellable) {
    if (this.hasClientSecret()) {
      const ok2 = await this.getClientCredentialsToken(cancellable);
      return ok2 && this.ccAccessToken ? this.ccAccessToken : null;
    }
    const ok = await this.getUserAccessToken(cancellable);
    return ok && this.userAccessToken ? this.userAccessToken : null;
  }
  soupGet(url, bearer, cancellable) {
    return new Promise((resolve, reject) => {
      if (cancellable?.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const msg = Soup.Message.new("GET", url);
      msg.request_headers.append("Authorization", `Bearer ${bearer}`);
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          if (cancellable?.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          const bytes = session.send_and_read_finish(res);
          resolve(soupMessageBytesToResult(msg, bytes));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  soupPutJson(url, bearer, jsonBody, cancellable) {
    return new Promise((resolve, reject) => {
      const msg = Soup.Message.new("PUT", url);
      msg.request_headers.append("Authorization", `Bearer ${bearer}`);
      msg.request_headers.append("Content-Type", "application/json");
      msg.set_request_body_from_bytes(
        "application/json",
        GLib4.Bytes.new(new TextEncoder().encode(jsonBody))
      );
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          const bytes = session.send_and_read_finish(res);
          resolve(soupMessageBytesToResult(msg, bytes));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  /** POST with no body (e.g. add-to-queue). Clears userAccessToken on 401 when clearTokenOn401 is true. */
  soupPostBearer(url, bearer, cancellable, clearTokenOn401) {
    return new Promise((resolve) => {
      const msg = Soup.Message.new("POST", url);
      msg.request_headers.append("Authorization", `Bearer ${bearer}`);
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (s, res) => {
        try {
          const bytes = s.send_and_read_finish(res);
          const parsed = soupMessageBytesToResult(msg, bytes);
          if (parsed.status === 401 && clearTokenOn401) this.userAccessToken = null;
          resolve(parsed);
        } catch (e) {
          logExtensionError(e, "Spotify soupPostBearer");
          resolve({ status: 0, json: null, bodyText: "" });
        }
      });
    });
  }
  searchSpotify(query, type, bearer, cancellable) {
    return new Promise((resolve, reject) => {
      if (cancellable.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=5`;
      const msg = Soup.Message.new("GET", url);
      msg.request_headers.append("Authorization", `Bearer ${bearer}`);
      this._session.send_and_read_async(msg, GLib4.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          if (cancellable.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          const bytes = session.send_and_read_finish(res);
          const dataArray = bytes.get_data();
          if (!dataArray) {
            resolve(null);
            return;
          }
          const text = new TextDecoder("utf-8").decode(dataArray);
          const json = JSON.parse(text);
          if (json.error && json.error.status === 401) {
            this.clearAuthTokens();
            resolve(null);
            return;
          }
          resolve(json);
        } catch (e) {
          if (cancellable.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          resolve(null);
        }
      });
    });
  }
  async fetchSavedTrackUris(query, userBearer, cancellable, cacheTrack) {
    const uris = [];
    const seen = /* @__PURE__ */ new Set();
    for (let page = 0; page < SAVED_PAGES; page++) {
      const offset = page * SAVED_LIMIT;
      const url = `https://api.spotify.com/v1/me/tracks?limit=${SAVED_LIMIT}&offset=${offset}`;
      const { status, json } = await this.soupGet(url, userBearer, cancellable);
      if (status !== 200 || !json?.items) break;
      for (const row of json.items) {
        const track = row?.track;
        if (!track?.uri) continue;
        if (savedTrackMatchesQuery(track, query)) {
          if (!seen.has(track.uri)) {
            seen.add(track.uri);
            uris.push(track.uri);
            track._searchType = "track";
            cacheTrack(track.uri, track);
          }
        }
      }
      if (!json.next) break;
    }
    return uris;
  }
  playRequestBodyForSpotifyUri(uri) {
    if (uri.includes(":track:")) return JSON.stringify({ uris: [uri] });
    return JSON.stringify({ context_uri: uri });
  }
  async tryActivateDevice(bearer) {
    const { status, json } = await this.soupGet(
      "https://api.spotify.com/v1/me/player/devices",
      bearer,
      null
    );
    if (status !== 200 || !json?.devices?.length) return false;
    const dev = json.devices.find((d) => d.is_active) || json.devices[0];
    if (!dev?.id) return false;
    const body = JSON.stringify({ device_ids: [dev.id], play: false });
    const r = await this.soupPutJson("https://api.spotify.com/v1/me/player", bearer, body, null);
    return spotifyEmptySuccess(r.status, r.json);
  }
  async playUriViaWebApi(uri) {
    const tokenOk = await this.getUserAccessToken(null);
    if (!tokenOk || !this.userAccessToken) return false;
    const body = this.playRequestBodyForSpotifyUri(uri);
    const play = async () => {
      const r = await this.soupPutJson(
        "https://api.spotify.com/v1/me/player/play",
        this.userAccessToken,
        body,
        null
      );
      return spotifyEmptySuccess(r.status, r.json);
    };
    if (await play()) return true;
    if (this.userAccessToken) {
      const transferred = await this.tryActivateDevice(this.userAccessToken);
      if (transferred) return play();
    }
    return false;
  }
};

// src/spotify-search-provider.ts
var SpotifySearchProvider = class {
  _extension;
  /** Bundled .desktop so `appInfo` is always set → Shell uses ListSearchResults (provider column + list). */
  _listAppInfo = null;
  _spotifyAppInfo = null;
  _api;
  _settings;
  resultCache = /* @__PURE__ */ new Map();
  _artCacheDir = null;
  constructor(extension, settings) {
    this._extension = extension;
    this._settings = settings;
    this._api = new SpotifyWebClient(settings);
    try {
      const dir = extension.dir;
      const base = dir.get_path();
      if (base) {
        this._listAppInfo = createListDesktopAppInfo(base);
        if (!this._listAppInfo) {
          const stub = GLib5.build_filenamev([base, "data", "spotify-search.extension.desktop"]);
          if (GLib5.file_test(stub, GLib5.FileTest.EXISTS))
            this._listAppInfo = GioUnix2.DesktopAppInfo.new_from_filename(stub);
        }
        const cacheDir = GLib5.build_filenamev([base, ".spotify-art-cache"]);
        GLib5.mkdir_with_parents(cacheDir, 493);
        this._artCacheDir = cacheDir;
      }
      this._spotifyAppInfo = GioUnix2.DesktopAppInfo.new("com.spotify.Client.desktop") || GioUnix2.DesktopAppInfo.new("spotify.desktop") || GioUnix2.DesktopAppInfo.new("spotify-client.desktop");
    } catch (e) {
      logExtensionError(e, "SpotifySearchProvider constructor");
    }
  }
  get id() {
    return this._extension.uuid;
  }
  get appInfo() {
    return this._listAppInfo || this._spotifyAppInfo;
  }
  get canLaunchSearch() {
    return false;
  }
  launchSearch(_terms) {
  }
  createResultObject(_meta) {
    return null;
  }
  getInitialResultSet(terms, cancellable) {
    return new Promise((resolve, reject) => {
      if (cancellable.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const query = terms.join(" ").trim();
      if (!query) {
        resolve([]);
        return;
      }
      const parsed = parseSpotifyCommand(query);
      if (!parsed) {
        resolve([]);
        return;
      }
      const cancelId = cancellable.connect(() => reject(new Error("Search Cancelled")));
      const cleanup = () => {
        try {
          cancellable.disconnect(cancelId);
        } catch {
        }
      };
      void (async () => {
        try {
          const searchBearer = await this._api.ensureSearchBearer(cancellable);
          if (cancellable.is_cancelled()) throw new Error("Search Cancelled");
          if (!searchBearer) {
            cleanup();
            resolve([]);
            return;
          }
          let likedUris = [];
          if (parsed.searchType === "track" && this._api.refreshToken) {
            const userOk = await this._api.getUserAccessToken(cancellable);
            if (userOk && this._api.userAccessToken) {
              try {
                likedUris = await this._api.fetchSavedTrackUris(
                  parsed.searchQuery,
                  this._api.userAccessToken,
                  cancellable,
                  (uri, track) => this.resultCache.set(uri, track)
                );
              } catch {
              }
            }
          }
          const json = await this._api.searchSpotify(
            parsed.searchQuery,
            parsed.searchType,
            searchBearer,
            cancellable
          );
          cleanup();
          if (cancellable.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          if (!json) {
            resolve([]);
            return;
          }
          const ids = [...likedUris];
          const seen = new Set(ids);
          const items = json[`${parsed.searchType}s`]?.items || [];
          for (const item of items) {
            if (!item?.uri) continue;
            if (seen.has(item.uri)) continue;
            seen.add(item.uri);
            item._searchType = parsed.searchType;
            this.resultCache.set(item.uri, item);
            ids.push(item.uri);
            if (ids.length >= MAX_RESULTS) break;
          }
          resolve(ids.slice(0, MAX_RESULTS));
        } catch (e) {
          cleanup();
          reject(e);
        }
      })();
    });
  }
  getSubsearchResultSet(_previousResults, terms, cancellable) {
    if (cancellable.is_cancelled()) return Promise.reject(new Error("Search Cancelled"));
    return this.getInitialResultSet(terms, cancellable);
  }
  _localArtPathForUrl(url) {
    if (!this._artCacheDir) return null;
    const hash = GLib5.compute_checksum_for_string(GLib5.ChecksumType.SHA256, url, -1);
    return GLib5.build_filenamev([this._artCacheDir, `${hash}.jpg`]);
  }
  _downloadArt(url, destPath, cancellable) {
    return new Promise((resolve) => {
      if (GLib5.file_test(destPath, GLib5.FileTest.EXISTS)) {
        resolve(true);
        return;
      }
      const msg = Soup2.Message.new("GET", url);
      this._api.session.send_and_read_async(msg, GLib5.PRIORITY_DEFAULT, cancellable, (session, res) => {
        try {
          const bytes = session.send_and_read_finish(res);
          if (msg.get_status() !== 200) {
            resolve(false);
            return;
          }
          const data = bytes.get_data();
          if (!data || data.length === 0) {
            resolve(false);
            return;
          }
          const f = Gio3.File.new_for_path(destPath);
          f.replace_contents(
            data,
            null,
            false,
            Gio3.FileCreateFlags.REPLACE_DESTINATION,
            null
          );
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
  }
  async _ensureLocalArt(item, cancellable) {
    if (item._localArtPath && GLib5.file_test(item._localArtPath, GLib5.FileTest.EXISTS)) return;
    const url = pickSpotifyImageUrl(item);
    if (!url || !this._artCacheDir) return;
    const path = this._localArtPathForUrl(url);
    if (!path) return;
    const ok = await this._downloadArt(url, path, cancellable);
    if (ok) item._localArtPath = path;
  }
  getResultMetas(resultIds, cancellable) {
    return new Promise((resolve, reject) => {
      if (cancellable.is_cancelled()) {
        reject(new Error("Search Cancelled"));
        return;
      }
      const cancelId = cancellable.connect(() => reject(new Error("Search Cancelled")));
      const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
      void (async () => {
        try {
          for (let i = 0; i < resultIds.length; i += ART_PREFETCH_CONCURRENCY) {
            const slice = resultIds.slice(i, i + ART_PREFETCH_CONCURRENCY);
            await Promise.all(
              slice.map(async (id) => {
                const item = this.resultCache.get(id);
                if (item && pickSpotifyImageUrl(item))
                  await this._ensureLocalArt(item, cancellable);
                if (cancellable.is_cancelled()) throw new Error("Search Cancelled");
              })
            );
          }
          try {
            cancellable.disconnect(cancelId);
          } catch {
          }
          if (cancellable.is_cancelled()) {
            reject(new Error("Search Cancelled"));
            return;
          }
          const metas = resultIds.map((id) => {
            const item = this.resultCache.get(id);
            const kind = item?._searchType || "track";
            const name = kind === "track" ? trackTitleWithArtists(item) : resultDisplayName(item);
            let desc = String(kind).toUpperCase();
            if (kind === "track") {
              desc = "Track";
            } else if (item?.artists?.length > 0) {
              desc += " \u2022 " + item.artists.map((a) => a.name).join(", ");
            } else if (kind === "playlist" && item?.owner?.display_name) {
              desc += " \u2022 " + item.owner.display_name;
            }
            return {
              id,
              name,
              description: desc,
              createIcon: (size) => {
                const px = Math.round(size * scale);
                if (item?._localArtPath && GLib5.file_test(item._localArtPath, GLib5.FileTest.EXISTS)) {
                  const f = Gio3.File.new_for_path(item._localArtPath);
                  return new St.Icon({
                    gicon: new Gio3.FileIcon({ file: f }),
                    icon_size: px
                  });
                }
                const remote = pickSpotifyImageUrl(item);
                if (remote) {
                  try {
                    const f = Gio3.File.new_for_uri(remote);
                    return new St.Icon({
                      gicon: new Gio3.FileIcon({ file: f }),
                      icon_size: px
                    });
                  } catch {
                  }
                }
                const gicon = this._spotifyAppInfo ? this._spotifyAppInfo.get_icon() : null;
                if (gicon) return new St.Icon({ gicon, icon_size: px });
                return new St.Icon({ icon_name: "audio-x-generic", icon_size: px });
              }
            };
          });
          resolve(metas);
        } catch (e) {
          try {
            cancellable.disconnect(cancelId);
          } catch {
          }
          reject(e);
        }
      })();
    });
  }
  filterResults(results, max) {
    return results.slice(0, max);
  }
  activateResult(id, terms) {
    const parsed = parseSpotifyCommand(terms.join(" ").trim());
    if (parsed?.activation === "queue") {
      void this._activateQueue(id);
      return;
    }
    void this._activatePlay(id).catch((e) => logExtensionError(e, "_activatePlay"));
  }
  _notifyPlaySuccess(uri) {
    if (!this._settings.get_boolean("show-action-notifications")) return;
    const item = this.resultCache.get(uri);
    const label = item ? itemNotificationLabel(item) : uri;
    Main.notify("Spotify Search", `${label} is now playing`);
  }
  _notifyQueueSuccess(item) {
    if (!this._settings.get_boolean("show-action-notifications")) return;
    const label = item ? itemNotificationLabel(item) : "Track";
    Main.notify("Spotify Search", `${label} added to queue`);
  }
  async _activatePlay(uri) {
    if (!uri || !uri.startsWith("spotify:")) {
      logExtensionError(new Error(`bad activate id: ${uri}`), "activatePlay");
      return;
    }
    const mprisCandidates = spotifyMprisBusCandidatesSync();
    if (openSpotifyUriViaMpris(uri, mprisCandidates)) {
      this._notifyPlaySuccess(uri);
      return;
    }
    if (await this._api.playUriViaWebApi(uri)) {
      this._notifyPlaySuccess(uri);
      return;
    }
    if (launchSpotifyAppWithUri(uri)) {
      this._notifyPlaySuccess(uri);
      return;
    }
    try {
      Gio3.AppInfo.launch_default_for_uri(uri, null);
      this._notifyPlaySuccess(uri);
    } catch (e) {
      logExtensionError(e, "launch_default_for_uri spotify");
      Main.notify(
        "Spotify Search",
        "Could not start playback. See logs: journalctl /usr/bin/gnome-shell -f \u2014 try Log in for Web API (Premium) or reinstall from git with npm run install-ext."
      );
    }
  }
  async _activateQueue(id) {
    const item = this.resultCache.get(id);
    const postQueue = (after401Retry) => {
      if (!this._api.userAccessToken) {
        return Promise.resolve({ status: 0, json: null, bodyText: "" });
      }
      const url = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(id)}`;
      return this._api.soupPostBearer(url, this._api.userAccessToken, null, !after401Retry);
    };
    if (!this._api.userAccessToken) {
      const ok = await this._api.getUserAccessToken(null);
      if (!ok) {
        Main.notify("Spotify Search", "Log in under extension settings to use Add to queue.");
        return;
      }
    }
    let r = await postQueue(false);
    if (spotifyEmptySuccess(r.status, r.json)) {
      this._notifyQueueSuccess(item);
      return;
    }
    if (!this._api.userAccessToken) {
      const refreshed = await this._api.getUserAccessToken(null);
      if (refreshed) r = await postQueue(true);
      if (spotifyEmptySuccess(r.status, r.json)) {
        this._notifyQueueSuccess(item);
        return;
      }
    }
    if (r.status === 404) {
      const transferred = await this._api.tryActivateDevice(this._api.userAccessToken);
      if (transferred) {
        r = await postQueue(true);
        if (spotifyEmptySuccess(r.status, r.json)) {
          this._notifyQueueSuccess(item);
          return;
        }
      }
      Main.notify(
        "Spotify Search",
        "No active Spotify device. Open Spotify and start playback once, then try again."
      );
      return;
    }
    if (r.status === 403) {
      Main.notify(
        "Spotify Search",
        spotifyApiErrorMessage(
          r.status,
          r.json,
          "Queue may require Spotify Premium or additional permissions."
        )
      );
      return;
    }
    if (r.status === 401) {
      Main.notify("Spotify Search", "Session expired. Log in again in extension settings.");
      return;
    }
    Main.notify(
      "Spotify Search",
      spotifyApiErrorMessage(r.status, r.json, "Could not add to queue")
    );
  }
};

// src/extension.ts
var SpotifySearchExtension = class extends Extension {
  provider = null;
  enable() {
    try {
      this.provider = new SpotifySearchProvider(this, this.getSettings());
      Main2.overview.searchController.addProvider(this.provider);
    } catch (e) {
      logExtensionError(e, "SpotifySearchExtension enable");
    }
  }
  disable() {
    if (this.provider) {
      Main2.overview.searchController.removeProvider(this.provider);
      this.provider = null;
    }
  }
};
export {
  SpotifySearchExtension as default
};
