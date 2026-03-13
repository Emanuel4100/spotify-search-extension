// src/extension.ts
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Soup from "gi://Soup?version=3.0";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
var SpotifySearchProvider = class {
  id = "spotify-search-provider";
  appInfo = null;
  canModifyContentList = false;
  soupSession = null;
  accessToken = null;
  trackCache = /* @__PURE__ */ new Map();
  _settings;
  // GNOME SHADOW QUEUE ENGINE
  myQueue = [];
  isHijacking = false;
  dbusListenerId = null;
  constructor(settings) {
    this._settings = settings;
    try {
      this.appInfo = Gio.DesktopAppInfo.new("com.spotify.Client.desktop") || Gio.DesktopAppInfo.new("spotify.desktop") || Gio.DesktopAppInfo.new("spotify-client.desktop");
      this.soupSession = new Soup.Session();
      this.dbusListenerId = Gio.DBus.session.signal_subscribe(
        "org.mpris.MediaPlayer2.spotify",
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        "/org/mpris/MediaPlayer2",
        null,
        Gio.DBusSignalFlags.NONE,
        (conn, sender, path, iface, signal, parameters) => {
          const unpacked = parameters.deep_unpack();
          const changedProps = unpacked[1];
          if (changedProps && changedProps["Metadata"]) {
            if (this.myQueue.length > 0 && !this.isHijacking) {
              this.isHijacking = true;
              const nextUri = this.myQueue.shift();
              Gio.DBus.session.call(
                "org.mpris.MediaPlayer2.spotify",
                "/org/mpris/MediaPlayer2",
                "org.mpris.MediaPlayer2.Player",
                "OpenUri",
                new GLib.Variant("(s)", [nextUri]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
              );
              Main.notify("\u{1F3B5} Spotify Queue", "Playing next shadow track");
              GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2e3, () => {
                this.isHijacking = false;
                return GLib.SOURCE_REMOVE;
              });
            }
          }
        }
      );
    } catch (e) {
    }
  }
  destroy() {
    if (this.dbusListenerId) {
      Gio.DBus.session.signal_unsubscribe(this.dbusListenerId);
    }
  }
  get clientId() {
    return this._settings.get_string("client-id");
  }
  get clientSecret() {
    return this._settings.get_string("client-secret");
  }
  async getAccessToken() {
    if (!this.clientId || !this.clientSecret || !this.soupSession) return false;
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
        }
        resolve(false);
      });
    });
  }
  async searchSpotify(query, type = "track") {
    if (!this.soupSession) return null;
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
      let isQueueCommand = false;
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
          if (cmd === "q" || cmd === "queue") {
            resolve([]);
            return;
          }
        }
        if (cmd === "p" || cmd === "play" || cmd === "t" || cmd === "track") {
          searchQuery = arg;
          searchType = "track";
        } else if (cmd === "q" || cmd === "queue") {
          searchQuery = arg;
          searchType = "track";
          isQueueCommand = true;
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
        ids.push(isQueueCommand ? `spotify:queue:${item.uri}` : item.uri);
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
          if (cmd === "next") iconName = "media-skip-forward-symbolic";
          if (cmd === "previous") iconName = "media-skip-backward-symbolic";
          return {
            id,
            name: cmd.toUpperCase(),
            description: "Spotify Command",
            createIcon: (size) => new St.Icon({ icon_name: iconName, icon_size: size })
          };
        }
        let isQueue = false;
        let actualId = id;
        if (id.startsWith("spotify:queue:")) {
          isQueue = true;
          actualId = id.substring(14);
        }
        const item = this.trackCache.get(actualId);
        let desc = item?._searchType?.toUpperCase() || "TRACK";
        if (item?.artists && item.artists.length > 0) {
          desc += " \u2022 " + item.artists.map((a) => a.name).join(", ");
        }
        if (isQueue) desc = "\u2795 Add to Shadow Queue \u2022 " + desc;
        return {
          id,
          name: item?.name || "Unknown",
          description: desc,
          createIcon: (size) => {
            let gicon = this.appInfo ? this.appInfo.get_icon() : null;
            if (gicon) return new St.Icon({ gicon, icon_size: size });
            return new St.Icon({ icon_name: "audio-x-generic", icon_size: size });
          }
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
    if (id.startsWith("spotify:queue:")) {
      const uri = id.substring(14);
      const item = this.trackCache.get(uri);
      this.myQueue.push(uri);
      Main.notify("Added to Shadow Queue", item?.name || "Track will play next");
      return;
    }
    if (id.startsWith("spotify:command:")) {
      const cmd = id.split(":")[2];
      if (cmd === "next" && this.myQueue.length > 0) {
        this.isHijacking = true;
        const nextUri = this.myQueue.shift();
        bus.call("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "OpenUri", new GLib.Variant("(s)", [nextUri]), null, Gio.DBusCallFlags.NONE, -1, null, null);
        Main.notify("\u{1F3B5} Spotify Queue", "Skipped to shadow track");
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2e3, () => {
          this.isHijacking = false;
          return GLib.SOURCE_REMOVE;
        });
        return;
      }
      const method = cmd === "play" ? "Play" : cmd === "pause" ? "Pause" : cmd === "next" ? "Next" : "Previous";
      bus.call("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", method, null, null, Gio.DBusCallFlags.NONE, -1, null, null);
      return;
    }
    this.myQueue = [];
    bus.call("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "OpenUri", new GLib.Variant("(s)", [id]), null, Gio.DBusCallFlags.NONE, -1, null, null);
  }
};
var SpotifySearchExtension = class extends Extension {
  provider = null;
  enable() {
    try {
      this.provider = new SpotifySearchProvider(this.getSettings());
      Main.overview.searchController.addProvider(this.provider);
    } catch (e) {
    }
  }
  disable() {
    if (this.provider) {
      Main.overview.searchController.removeProvider(this.provider);
      this.provider.destroy();
      this.provider = null;
    }
  }
};
export {
  SpotifySearchExtension as default
};
