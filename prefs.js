// src/prefs.ts
import Adw from "gi://Adw";
import Gio2 from "gi://Gio";
import Gtk from "gi://Gtk?version=4.0";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// src/prefs-oauth.ts
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

// src/spotify-config.ts
var BUNDLED_SPOTIFY_CLIENT_ID = "b7c53c9dc6824f13b36049065ae2f12f";

// src/prefs-oauth.ts
var DEFAULT_REDIRECT_URI = "http://127.0.0.1:8080";
var SPOTIFY_SCOPES = "user-modify-playback-state user-library-read";
var activeOAuthServer = null;
function disconnectActiveOAuthServer() {
  if (activeOAuthServer) {
    try {
      activeOAuthServer.disconnect();
    } catch {
    }
    activeOAuthServer = null;
  }
}
function registerOAuthServer(server) {
  disconnectActiveOAuthServer();
  activeOAuthServer = server;
}
function clearOAuthServerIfCurrent(server) {
  if (activeOAuthServer === server) activeOAuthServer = null;
}
function getOAuthRedirectUri(settings) {
  if (!settings.get_boolean("oauth-use-custom-redirect")) return DEFAULT_REDIRECT_URI;
  const s = settings.get_string("oauth-redirect-uri").trim();
  return s || DEFAULT_REDIRECT_URI;
}
function migrateOAuthRedirectIfNeeded(settings) {
  const u = settings.get_string("oauth-redirect-uri").trim();
  if (!u || u === DEFAULT_REDIRECT_URI) return;
  if (!settings.get_boolean("oauth-use-custom-redirect"))
    settings.set_boolean("oauth-use-custom-redirect", true);
}
function getOAuthRedirectPort(redirectUri) {
  try {
    const u = GLib.Uri.parse(redirectUri, GLib.UriFlags.NONE);
    const p = u.get_port();
    if (p > 0) return p;
    return 8080;
  } catch {
    return 8080;
  }
}
function randomPkceVerifier(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let s = "";
  for (let i = 0; i < length; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}
function effectiveClientId(settings) {
  const s = settings.get_string("client-id").trim();
  return s || BUNDLED_SPOTIFY_CLIENT_ID;
}
function connectSpotifyOAuthButton({ settings, button: btn }) {
  btn.connect("clicked", () => {
    disconnectActiveOAuthServer();
    const clientId = effectiveClientId(settings);
    const clientSecret = settings.get_string("client-secret").trim();
    const redirectUri = getOAuthRedirectUri(settings);
    const port = getOAuthRedirectPort(redirectUri);
    const lower = redirectUri.toLowerCase();
    if (lower.startsWith("https:")) {
      btn.set_label("Redirect URI cannot be https (local server is HTTP only)");
      return;
    }
    if (!lower.startsWith("http:")) {
      btn.set_label("Redirect URI must start with http://");
      return;
    }
    const usePkce = !clientSecret;
    const pkceVerifier = usePkce ? randomPkceVerifier(64) : "";
    btn.set_label("Waiting for browser\u2026");
    const server = new Soup.Server({});
    server.add_handler("/", (_srv, msg, _path, _query) => {
      const uri = msg.get_uri();
      const queryStr = uri.get_query();
      if (queryStr && queryStr.includes("error=")) {
        const errMatch = queryStr.match(/error=([^&]*)/);
        const descMatch = queryStr.match(/error_description=([^&]*)/);
        const errCode = errMatch ? decodeURIComponent(errMatch[1].replace(/\+/g, " ")) : "error";
        const errDesc = descMatch ? decodeURIComponent(descMatch[1].replace(/\+/g, " ")) : errCode;
        btn.set_label(`Spotify: ${errDesc.substring(0, 80)}`);
      }
      if (queryStr && queryStr.includes("code=")) {
        const raw = queryStr.split("code=")[1]?.split("&")[0] ?? "";
        let code;
        try {
          code = decodeURIComponent(raw.replace(/\+/g, "%20"));
        } catch {
          code = raw;
        }
        btn.set_label("Exchanging code\u2026");
        const reqMsg = Soup.Message.new("POST", "https://accounts.spotify.com/api/token");
        reqMsg.request_headers.append("Content-Type", "application/x-www-form-urlencoded");
        let body;
        if (usePkce) {
          body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}&code_verifier=${encodeURIComponent(pkceVerifier)}`;
        } else {
          const authBytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
          const authB64 = GLib.base64_encode(authBytes);
          reqMsg.request_headers.append("Authorization", `Basic ${authB64}`);
          body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
        }
        reqMsg.set_request_body_from_bytes(
          "application/x-www-form-urlencoded",
          // @ts-ignore
          GLib.Bytes.new(new TextEncoder().encode(body))
        );
        const session = new Soup.Session();
        session.send_and_read_async(reqMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
          try {
            const bytes = s.send_and_read_finish(res);
            const dataArray = bytes.get_data();
            if (!dataArray) {
              btn.set_label("Empty token response");
              return;
            }
            const text = new TextDecoder("utf-8").decode(dataArray);
            const data = JSON.parse(text);
            if (data.error) {
              const detail = data.error_description || data.error;
              btn.set_label(`Spotify: ${detail.substring(0, 80)}`);
              return;
            }
            if (data.refresh_token) {
              settings.set_string("refresh-token", data.refresh_token);
            }
            if (settings.get_string("refresh-token")) {
              settings.apply();
              btn.set_label("Saved. $queue and liked-first search work.");
              return;
            }
            btn.set_label(
              "No refresh token \u2014 in Spotify account remove app access once, then log in again"
            );
          } catch {
            btn.set_label("Error exchanging code");
          }
        });
      }
      msg.get_response_headers().set_content_type("text/html", null);
      const html = '<div style="font-family: sans-serif; text-align: center; padding-top: 100px;"><h1 style="color: #1DB954;">Authorized</h1><p>You can close this tab and return to extension settings.</p></div>';
      msg.get_response_body().append(html);
      msg.set_status(200, null);
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2e3, () => {
        try {
          server.disconnect();
        } catch {
        }
        clearOAuthServerIfCurrent(server);
        return GLib.SOURCE_REMOVE;
      });
    });
    try {
      server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
      registerOAuthServer(server);
    } catch {
      btn.set_label(`Port ${port} busy \u2014 change Redirect URI port or free it`);
      return;
    }
    const scope = encodeURIComponent(SPOTIFY_SCOPES);
    let authUrl = `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&prompt=consent`;
    if (usePkce) {
      authUrl += `&code_challenge_method=plain&code_challenge=${encodeURIComponent(pkceVerifier)}`;
    }
    Gio.AppInfo.launch_default_for_uri(authUrl, null);
  });
}

// src/prefs.ts
var SpotifyPrefs = class extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage();
    const credsGroup = new Adw.PreferencesGroup({
      title: "Spotify connection",
      description: "Uses a bundled Spotify app (PKCE). In the Developer Dashboard, add redirect URI http://127.0.0.1:8080 unless you use a custom address below. HTTP loopback only\u2014not https."
    });
    page.add(credsGroup);
    window.add(page);
    const settings = this.getSettings();
    migrateOAuthRedirectIfNeeded(settings);
    for (const key of [
      "oauth-use-custom-redirect",
      "oauth-redirect-uri",
      "refresh-token",
      "client-id",
      "client-secret"
    ]) {
      if (!settings.is_writable(key)) {
        console.error(`[spotify-search prefs] gsettings key not writable: ${key}`);
      }
    }
    const defaultRedirectRow = new Adw.ActionRow({
      title: "Redirect URI",
      subtitle: `Default ${DEFAULT_REDIRECT_URI} \u2014 add this exact URI in your Spotify app.`
    });
    credsGroup.add(defaultRedirectRow);
    const customRedirectRow = new Adw.ActionRow({
      title: "Use custom redirect URI",
      subtitle: "Only if you need another host or port. Must match the Spotify app and this machine."
    });
    const customRedirectSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(
      "oauth-use-custom-redirect",
      customRedirectSwitch,
      "active",
      Gio2.SettingsBindFlags.DEFAULT
    );
    customRedirectRow.add_suffix(customRedirectSwitch);
    customRedirectRow.activatable_widget = customRedirectSwitch;
    credsGroup.add(customRedirectRow);
    const customUriRow = new Adw.ActionRow({ title: "Custom redirect URI" });
    const redirectEntry = new Gtk.Entry({
      valign: Gtk.Align.CENTER,
      width_request: 260,
      hexpand: true,
      placeholder_text: DEFAULT_REDIRECT_URI
    });
    settings.bind("oauth-redirect-uri", redirectEntry, "text", Gio2.SettingsBindFlags.DEFAULT);
    customUriRow.add_suffix(redirectEntry);
    credsGroup.add(customUriRow);
    const syncCustomUriVisibility = () => {
      const custom = settings.get_boolean("oauth-use-custom-redirect");
      customUriRow.set_visible(custom);
      if (custom && !settings.get_string("oauth-redirect-uri").trim()) {
        settings.set_string("oauth-redirect-uri", DEFAULT_REDIRECT_URI);
      }
    };
    settings.connect("changed::oauth-use-custom-redirect", syncCustomUriVisibility);
    customRedirectSwitch.connect("notify::active", syncCustomUriVisibility);
    syncCustomUriVisibility();
    window.connect("close-request", () => {
      disconnectActiveOAuthServer();
      settings.apply();
      return false;
    });
    const behaviorGroup = new Adw.PreferencesGroup({
      title: "Search actions",
      description: "Optional feedback when you use overview search to play or queue. Errors (login, no device, etc.) always show a notification."
    });
    page.add(behaviorGroup);
    const notifRow = new Adw.ActionRow({
      title: "Notify on play and queue",
      subtitle: "Show a system notification with title and artist after playback starts or a track is queued."
    });
    const notifSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(
      "show-action-notifications",
      notifSwitch,
      "active",
      Gio2.SettingsBindFlags.DEFAULT
    );
    notifRow.add_suffix(notifSwitch);
    notifRow.activatable_widget = notifSwitch;
    behaviorGroup.add(notifRow);
    const authGroup = new Adw.PreferencesGroup({
      title: "Spotify account",
      description: "Log in for $queue and liked songs first on $play. Re-login after upgrading (new permissions). The browser opens Spotify; the callback uses the redirect URI shown above."
    });
    page.add(authGroup);
    const authRow = new Adw.ActionRow({ title: "Log in with Spotify" });
    const btn = new Gtk.Button({
      label: "Log In",
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"]
    });
    authRow.add_suffix(btn);
    authGroup.add(authRow);
    connectSpotifyOAuthButton({ settings, button: btn });
  }
};
export {
  SpotifyPrefs as default
};
