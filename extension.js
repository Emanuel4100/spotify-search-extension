// src/extension.ts
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Soup from "gi://Soup?version=3.0";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
var SpotifySearchProvider = class {
  id = "spotify-search-provider";
  appInfo;
  canModifyContentList = false;
  soupSession;
  accessToken = null;
  trackCache = /* @__PURE__ */ new Map();
  _settings;
  constructor(settings) {
    this._settings = settings;
    this.appInfo = Gio.DesktopAppInfo.new("com.spotify.Client.desktop") || Gio.DesktopAppInfo.new("spotify.desktop") || Gio.DesktopAppInfo.new("spotify-client.desktop") || Gio.DesktopAppInfo.new("org.gnome.Settings.desktop");
    this.soupSession = new Soup.Session();
  }
  get clientId() {
    return this._settings.get_string("client-id");
  }
  get clientSecret() {
    return this._settings.get_string("client-secret");
  }
  async getAccessToken() {
    if (!this.clientId || !this.clientSecret) return false;
    return new Promise((resolve) => {
      const authStr = `${this.clientId}:${this.clientSecret}`;
      const authBytes = new TextEncoder().encode(authStr);
      const auth = GLib.base64_encode(authBytes);
      const bodyStr = "grant_type=client_credentials";
      const bodyBytes = new TextEncoder().encode(bodyStr);
      const tokenUrl = "https://accounts.spotify.com/api/token";
      const msg = Soup.Message.new("POST", tokenUrl);
      msg.request_headers.append("Authorization", `Basic ${auth}`);
      msg.request_headers.append("Content-Type", "application/x-www-form-urlencoded");
      msg.set_request_body_from_bytes("application/x-www-form-urlencoded", GLib.Bytes.new(bodyBytes));
      this.soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
        try {
          const bytes = session.send_and_read_finish(res);
          const dataArray = bytes.get_data();
          if (!dataArray) {
            resolve(false);
            return;
          }
          const text = new TextDecoder("utf-8").decode(dataArray);
          const data = JSON.parse(text);
          if (data.access_token) {
            this.accessToken = data.access_token;
            resolve(true);
            return;
          }
        } catch (e) {
          console.error("Spotify Auth Error:", e);
        }
        resolve(false);
      });
    });
  }
  async searchSpotify(query, type = "track") {
    if (!this.accessToken) {
      const success = await this.getAccessToken();
      if (!success) return null;
    }
    return new Promise((resolve) => {
      const baseUrl = "https://api.spotify.com/v1/search?q=";
      const url = `${baseUrl}${encodeURIComponent(query)}&type=${type}&limit=5`;
      const msg = Soup.Message.new("GET", url);
      msg.request_headers.append("Authorization", `Bearer ${this.accessToken}`);
      this.soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
        try {
          const bytes = session.send_and_read_finish(res);
          const dataArray = bytes.get_data();
          if (!dataArray) {
            resolve(null);
            return;
          }
          const text = new TextDecoder("utf-8").decode(dataArray);
          const json = JSON.parse(text);
          if (json.error && json.error.status === 401) {
            this.accessToken = null;
            resolve(null);
            return;
          }
          resolve(json);
        } catch (e) {
          resolve(null);
        }
      });
    });
  }
  getInitialResultSet(terms, cancellable) {
    return new Promise(async (resolve) => {
      const query = terms.join(" ").trim().toLowerCase();
      if (!query) {
        resolve([]);
        return;
      }
      let searchQuery = query;
      let searchType = "track";
      if (query.startsWith("$")) {
        const parts = query.substring(1).trim().split(" ");
        const cmd = parts[0];
        const arg = parts.slice(1).join(" ").trim();
        if (!arg) {
          if (cmd === "p" || cmd === "play") {
            resolve(["spotify:command:play"]);
            return;
          }
          if (cmd === "pause") {
            resolve(["spotify:command:pause"]);
            return;
          }
          if (cmd === "n" || cmd === "next") {
            resolve(["spotify:command:next"]);
            return;
          }
          if (cmd === "prev" || cmd === "previous") {
            resolve(["spotify:command:previous"]);
            return;
          }
        }
        if (cmd === "p" || cmd === "play" || cmd === "t" || cmd === "track") {
          searchQuery = arg;
          searchType = "track";
        } else if (cmd === "a" || cmd === "artist") {
          searchQuery = arg;
          searchType = "artist";
        } else if (cmd === "al" || cmd === "album") {
          searchQuery = arg;
          searchType = "album";
        } else if (cmd === "pl" || cmd === "playlist") {
          searchQuery = arg;
          searchType = "playlist";
        } else {
          resolve([]);
          return;
        }
      }
      const json = await this.searchSpotify(searchQuery, searchType);
      if (!json) {
        resolve([]);
        return;
      }
      const ids = [];
      const items = json[`${searchType}s`]?.items || [];
      for (const item of items) {
        if (!item) continue;
        item._searchType = searchType;
        this.trackCache.set(item.uri, item);
        ids.push(item.uri);
      }
      resolve(ids);
    });
  }
  getSubsearchResultSet(previousResults, terms, cancellable) {
    return this.getInitialResultSet(terms, cancellable);
  }
  getResultMetas(resultIds, cancellable) {
    return new Promise((resolve) => {
      const metas = resultIds.map((id) => {
        if (id.startsWith("spotify:command:")) {
          const cmd = id.split(":")[2];
          let iconName = "media-playback-start-symbolic";
          if (cmd === "pause") iconName = "media-playback-pause-symbolic";
          return {
            id,
            name: cmd.toUpperCase(),
            description: "Spotify Command",
            createIcon: (size) => new St.Icon({ icon_name: iconName, icon_size: size })
          };
        }
        const item = this.trackCache.get(id);
        return {
          id,
          name: item?.name || "Unknown",
          description: item?._searchType || "Track",
          createIcon: (size) => this.appInfo?.create_icon_texture(size)
        };
      });
      resolve(metas);
    });
  }
  filterResults(results, max) {
    return results.slice(0, max);
  }
  activateResult(id, terms) {
    const bus = Gio.DBus.session;
    if (id.startsWith("spotify:command:")) {
      const cmd = id.split(":")[2];
      const method = cmd === "play" ? "Play" : cmd === "pause" ? "Pause" : cmd === "next" ? "Next" : "Previous";
      bus.call("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", method, null, null, Gio.DBusCallFlags.NONE, -1, null, null);
      return;
    }
    bus.call("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "OpenUri", new GLib.Variant("(s)", [id]), null, Gio.DBusCallFlags.NONE, -1, null, null);
  }
};
var SpotifySearchExtension = class extends Extension {
  provider = null;
  enable() {
    this.provider = new SpotifySearchProvider(this.getSettings());
    Main.overview.searchController.addProvider(this.provider);
  }
  disable() {
    if (this.provider) Main.overview.searchController.removeProvider(this.provider);
    this.provider = null;
  }
};
export {
  SpotifySearchExtension as default
};
