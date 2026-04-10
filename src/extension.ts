// @ts-ignore
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
// @ts-ignore
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { logExtensionError } from './log';
import { SpotifySearchProvider } from './spotify-search-provider';

export default class SpotifySearchExtension extends Extension {
    private provider: SpotifySearchProvider | null = null;

    enable() {
        try {
            this.provider = new SpotifySearchProvider(this, this.getSettings());
            Main.overview.searchController.addProvider(this.provider);
        } catch (e) {
            logExtensionError(e, 'SpotifySearchExtension enable');
        }
    }

    disable() {
        if (this.provider) {
            Main.overview.searchController.removeProvider(this.provider);
            this.provider = null;
        }
    }
}
