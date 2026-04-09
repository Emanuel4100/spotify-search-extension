// src/prefs.ts
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk?version=4.0";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
var REDIRECT_URI = "http://localhost:8080";
var SpotifyPrefs = class extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage();
    const credsGroup = new Adw.PreferencesGroup({
      title: "Spotify API app",
      description: "Create an app at developer.spotify.com and add Redirect URI: http://localhost:8080. Client ID and Secret are enough to search and play via MPRIS."
    });
    page.add(credsGroup);
    window.add(page);
    const settings = this.getSettings();
    const idRow = new Adw.EntryRow({ title: "Client ID" });
    settings.bind("client-id", idRow, "text", Gio.SettingsBindFlags.DEFAULT);
    credsGroup.add(idRow);
    const secretRow = new Adw.PasswordEntryRow({ title: "Client Secret" });
    settings.bind("client-secret", secretRow, "text", Gio.SettingsBindFlags.DEFAULT);
    credsGroup.add(secretRow);
    const authGroup = new Adw.PreferencesGroup({
      title: "Spotify account (queue only)",
      description: "Browser login is only required for $queue / $q. Search and play ($play, etc.) use Client ID + Secret only."
    });
    page.add(authGroup);
    const authRow = new Adw.ActionRow({
      title: "Log in with Spotify",
      subtitle: "Grants permission to add tracks to your playback queue."
    });
    const btn = new Gtk.Button({
      label: "Log In",
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"]
    });
    authRow.add_suffix(btn);
    authGroup.add(authRow);
    btn.connect("clicked", () => {
      const clientId = settings.get_string("client-id");
      const clientSecret = settings.get_string("client-secret");
      if (!clientId || !clientSecret) {
        btn.set_label("Add Client ID and Secret first");
        return;
      }
      btn.set_label("Waiting for browser\u2026");
      const server = new Soup.Server({});
      server.add_handler("/", (srv, msg, _path, _query) => {
        const uri = msg.get_uri();
        const queryStr = uri.get_query();
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
          const authBytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
          const authB64 = GLib.base64_encode(authBytes);
          reqMsg.request_headers.append("Authorization", `Basic ${authB64}`);
          reqMsg.request_headers.append("Content-Type", "application/x-www-form-urlencoded");
          const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
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
                btn.set_label("Saved. You can use $queue.");
                return;
              }
              btn.set_label("No refresh token (try revoking app access and log in again)");
            } catch (e) {
              btn.set_label("Error exchanging code");
            }
          });
        }
        msg.get_response_headers().set_content_type("text/html", null);
        const html = '<div style="font-family: sans-serif; text-align: center; padding-top: 100px;"><h1 style="color: #1DB954;">Authorized</h1><p>You can close this tab and return to extension settings.</p></div>';
        msg.get_response_body().append(html);
        msg.set_status(200, null);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2e3, () => {
          server.disconnect();
          return GLib.SOURCE_REMOVE;
        });
      });
      try {
        server.listen_local(8080, Soup.ServerListenOptions.IPV4_ONLY);
      } catch {
        btn.set_label("Port 8080 busy \u2014 close other apps using it");
        return;
      }
      const scope = encodeURIComponent("user-modify-playback-state");
      const authUrl = `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}`;
      Gio.AppInfo.launch_default_for_uri(authUrl, null);
    });
  }
};
export {
  SpotifyPrefs as default
};
