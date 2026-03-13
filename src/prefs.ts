import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
// @ts-ignore
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpotifyPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ 
            title: 'Spotify Credentials',
            description: 'Enter your Client ID and Secret. The Queue ($q) is handled locally by GNOME, so no browser login is required!'
        });
        page.add(group);
        window.add(page);

        const settings = this.getSettings();

        const idRow = new Adw.EntryRow({ title: 'Client ID' });
        settings.bind('client-id', idRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(idRow);

        const secretRow = new Adw.PasswordEntryRow({ title: 'Client Secret' });
        settings.bind('client-secret', secretRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(secretRow);
    }
}
