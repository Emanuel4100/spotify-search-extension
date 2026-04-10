import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { logExtensionError } from './log';

/** Snap/desktop Spotify: `--uri=` when MPRIS is absent or unreliable. */
export function launchSpotifyAppWithUri(uri: string): boolean {
    const uriArg = `--uri=${uri}`;
    const homeFlatpak = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.local/share/flatpak/exports/bin/com.spotify.Client',
    ]);
    const candidates = [
        '/snap/bin/spotify',
        '/var/lib/flatpak/exports/bin/com.spotify.Client',
        homeFlatpak,
    ];
    for (const bin of candidates) {
        if (!GLib.file_test(bin, GLib.FileTest.IS_EXECUTABLE)) continue;
        try {
            // @ts-ignore Gio.Subprocess.new exists in GJS
            Gio.Subprocess.new([bin, uriArg], Gio.SubprocessFlags.NONE);
            return true;
        } catch (e) {
            logExtensionError(e, `spawn ${bin} --uri`);
        }
    }
    try {
        // argv[0] resolved via execvp(3)
        // @ts-ignore
        Gio.Subprocess.new(['spotify', uriArg], Gio.SubprocessFlags.NONE);
        return true;
    } catch (e) {
        logExtensionError(e, 'spawn spotify --uri (PATH)');
    }
    return false;
}
