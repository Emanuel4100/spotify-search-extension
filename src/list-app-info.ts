import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import { logExtensionError } from './log';

const DESKTOP_GROUP = 'Desktop Entry';

/**
 * DesktopAppInfo for the search sidebar: list layout + visible should_show().
 * Uses an absolute path to a bundled SVG so the icon works without a host `spotify` theme icon.
 */
export function createListDesktopAppInfo(extensionBasePath: string): GioUnix.DesktopAppInfo | null {
    try {
        const kf = new GLib.KeyFile();
        kf.set_string(DESKTOP_GROUP, 'Type', 'Application');
        kf.set_string(DESKTOP_GROUP, 'Name', 'Spotify');
        kf.set_string(DESKTOP_GROUP, 'Exec', '/usr/bin/true');
        kf.set_boolean(DESKTOP_GROUP, 'Terminal', false);

        const svgPath = GLib.build_filenamev([extensionBasePath, 'data', 'spotify-search-sidebar.svg']);
        const icon = GLib.file_test(svgPath, GLib.FileTest.EXISTS) ? svgPath : 'audio-x-generic';
        kf.set_string(DESKTOP_GROUP, 'Icon', icon);

        // GDesktopAppInfo lives in GioUnix, not Gio.
        return GioUnix.DesktopAppInfo.new_from_keyfile(kf);
    } catch (e) {
        logExtensionError(e, 'createListDesktopAppInfo');
        return null;
    }
}
