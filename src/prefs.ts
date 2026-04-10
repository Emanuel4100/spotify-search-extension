import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

// @ts-ignore
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    DEFAULT_REDIRECT_URI,
    connectSpotifyOAuthButton,
    disconnectActiveOAuthServer,
    migrateOAuthRedirectIfNeeded,
} from './prefs-oauth';

export default class SpotifyPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const page = new Adw.PreferencesPage();
        const credsGroup = new Adw.PreferencesGroup({
            title: 'Spotify connection',
            description:
                'Uses a bundled Spotify app (PKCE). In the Developer Dashboard, add redirect URI http://127.0.0.1:8080 unless you use a custom address below. HTTP loopback only—not https.',
        });
        page.add(credsGroup);
        window.add(page);

        const settings = this.getSettings();
        migrateOAuthRedirectIfNeeded(settings);

        for (const key of [
            'oauth-use-custom-redirect',
            'oauth-redirect-uri',
            'refresh-token',
            'client-id',
            'client-secret',
        ]) {
            if (!settings.is_writable(key)) {
                console.error(`[spotify-search prefs] gsettings key not writable: ${key}`);
            }
        }

        const defaultRedirectRow = new Adw.ActionRow({
            title: 'Redirect URI',
            subtitle: `Default ${DEFAULT_REDIRECT_URI} — add this exact URI in your Spotify app.`,
        });
        credsGroup.add(defaultRedirectRow);

        const customRedirectRow = new Adw.ActionRow({
            title: 'Use custom redirect URI',
            subtitle: 'Only if you need another host or port. Must match the Spotify app and this machine.',
        });
        const customRedirectSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind(
            'oauth-use-custom-redirect',
            customRedirectSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
        customRedirectRow.add_suffix(customRedirectSwitch);
        customRedirectRow.activatable_widget = customRedirectSwitch;
        credsGroup.add(customRedirectRow);

        const customUriRow = new Adw.ActionRow({ title: 'Custom redirect URI' });
        const redirectEntry = new Gtk.Entry({
            valign: Gtk.Align.CENTER,
            width_request: 260,
            hexpand: true,
            placeholder_text: DEFAULT_REDIRECT_URI,
        });
        settings.bind('oauth-redirect-uri', redirectEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        customUriRow.add_suffix(redirectEntry);
        credsGroup.add(customUriRow);

        const syncCustomUriVisibility = (): void => {
            const custom = settings.get_boolean('oauth-use-custom-redirect');
            customUriRow.set_visible(custom);
            if (custom && !settings.get_string('oauth-redirect-uri').trim()) {
                settings.set_string('oauth-redirect-uri', DEFAULT_REDIRECT_URI);
            }
        };
        settings.connect('changed::oauth-use-custom-redirect', syncCustomUriVisibility);
        customRedirectSwitch.connect('notify::active', syncCustomUriVisibility);
        syncCustomUriVisibility();

        window.connect('close-request', () => {
            disconnectActiveOAuthServer();
            settings.apply();
            return false;
        });

        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Search actions',
            description:
                'Optional feedback when you use overview search to play or queue. Errors (login, no device, etc.) always show a notification.',
        });
        page.add(behaviorGroup);

        const notifRow = new Adw.ActionRow({
            title: 'Notify on play and queue',
            subtitle:
                'Show a system notification with title and artist after playback starts or a track is queued.',
        });
        const notifSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind(
            'show-action-notifications',
            notifSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
        notifRow.add_suffix(notifSwitch);
        notifRow.activatable_widget = notifSwitch;
        behaviorGroup.add(notifRow);

        const authGroup = new Adw.PreferencesGroup({
            title: 'Spotify account',
            description:
                'Log in for $queue and liked songs first on $play. Re-login after upgrading (new permissions). The browser opens Spotify; the callback uses the redirect URI shown above.',
        });
        page.add(authGroup);

        const authRow = new Adw.ActionRow({ title: 'Log in with Spotify' });
        const btn = new Gtk.Button({
            label: 'Log In',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        authRow.add_suffix(btn);
        authGroup.add(authRow);

        connectSpotifyOAuthButton({ settings, button: btn });
    }
}
