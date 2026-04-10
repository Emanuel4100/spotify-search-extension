import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { logExtensionError } from './log';

export function dbusCallSync(
    busName: string,
    objectPath: string,
    interfaceName: string,
    methodName: string,
    parameters: GLib.Variant | null,
    replyType: GLib.VariantType | null,
): GLib.Variant | null {
    return Gio.DBus.session.call_sync(
        busName,
        objectPath,
        interfaceName,
        methodName,
        parameters,
        replyType,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
    );
}

export function listMprisPlayerBusNamesSync(): string[] {
    try {
        const reply = dbusCallSync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
        );
        if (!reply) return [];
        const unpacked = reply.deepUnpack() as [string[]];
        const names = unpacked[0] ?? [];
        return names.filter((n) => n.startsWith('org.mpris.MediaPlayer2.'));
    } catch (e) {
        logExtensionError(e, 'DBus ListNames sync');
        return [];
    }
}

export function mprisIdentitySync(busName: string): string {
    try {
        const reply = dbusCallSync(
            busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity']),
            new GLib.VariantType('(v)'),
        );
        if (!reply) return '';
        const [boxed] = reply.deepUnpack() as [GLib.Variant];
        const inner = boxed.deepUnpack();
        return typeof inner === 'string' ? inner : '';
    } catch {
        return '';
    }
}

/** Single ListNames + identity pass; reuse the returned array for OpenUri. */
export function spotifyMprisBusCandidatesSync(): string[] {
    const all = listMprisPlayerBusNamesSync();
    const preferred = 'org.mpris.MediaPlayer2.spotify';
    const out: string[] = [];
    const seen = new Set<string>();

    const push = (n: string) => {
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

/**
 * MPRIS OpenUri with explicit () reply type.
 * @param candidates from spotifyMprisBusCandidatesSync() (one call per activation).
 */
export function openSpotifyUriViaMpris(uri: string, candidates: string[]): boolean {
    const voidReply = new GLib.VariantType('()');
    for (const busName of candidates) {
        try {
            dbusCallSync(
                busName,
                '/org/mpris/MediaPlayer2',
                'org.mpris.MediaPlayer2.Player',
                'OpenUri',
                new GLib.Variant('(s)', [uri]),
                voidReply,
            );
            return true;
        } catch (e) {
            logExtensionError(e, `MPRIS OpenUri ${busName}`);
        }
    }
    return false;
}
