import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

// @ts-ignore
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
// @ts-ignore
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
// @ts-ignore
import { logError } from 'resource:///org/gnome/shell/misc/util.js';

type ParsedCommand = { searchQuery: string; searchType: string };

function parseSpotifyCommand(query: string): ParsedCommand | null {
    const q = query.trim().toLowerCase();
    if (!q.startsWith('$')) return null;

    const parts = q.substring(1).trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const arg = parts.slice(1).join(' ').trim();
    if (!arg) return null;

    if (cmd === 'p' || cmd === 'play' || cmd === 't' || cmd === 'track')
        return { searchQuery: arg, searchType: 'track' };
    if (cmd === 'q' || cmd === 'queue')
        return { searchQuery: arg, searchType: 'track' };
    if (cmd === 'a' || cmd === 'artist')
        return { searchQuery: arg, searchType: 'artist' };
    if (cmd === 'al' || cmd === 'album')
        return { searchQuery: arg, searchType: 'album' };
    if (cmd === 'pl' || cmd === 'playlist')
        return { searchQuery: arg, searchType: 'playlist' };
    return null;
}

class SpotifySearchProvider {
    private _extension: Extension;

    public get id(): string {
        return this._extension.uuid;
    }

    public get appInfo(): Gio.DesktopAppInfo | null {
        return this._spotifyAppInfo;
    }

    public get canLaunchSearch(): boolean {
        return false;
    }

    private _spotifyAppInfo: Gio.DesktopAppInfo | null = null;
    private soupSession: Soup.Session | null = null;
    /** User OAuth access token (queue API only). */
    private userAccessToken: string | null = null;
    /** Client-credentials access token (search API). */
    private ccAccessToken: string | null = null;
    private ccExpiresAt = 0;
    private trackCache = new Map<string, any>();
    private _settings: Gio.Settings;

    constructor(extension: Extension, settings: Gio.Settings) {
        this._extension = extension;
        this._settings = settings;
        try {
            this._spotifyAppInfo =
                Gio.DesktopAppInfo.new('com.spotify.Client.desktop') ||
                Gio.DesktopAppInfo.new('spotify.desktop') ||
                Gio.DesktopAppInfo.new('spotify-client.desktop');
            this.soupSession = new Soup.Session();
        } catch (e) {
            logError(e as Error, 'SpotifySearchProvider constructor');
        }
    }

    private get clientId() {
        return this._settings.get_string('client-id');
    }
    private get clientSecret() {
        return this._settings.get_string('client-secret');
    }
    private get refreshToken() {
        return this._settings.get_string('refresh-token');
    }

    launchSearch(_terms: string[]): void {}

    createResultObject(_meta: any): null {
        return null;
    }

    private _basicAuthHeader(): string | null {
        if (!this.clientId || !this.clientSecret) return null;
        // @ts-ignore
        const authBytes = new TextEncoder().encode(`${this.clientId}:${this.clientSecret}`);
        return GLib.base64_encode(authBytes);
    }

    /** Refresh user access token (for queue). */
    private getUserAccessToken(cancellable: Gio.Cancellable | null): Promise<boolean> {
        if (!this.soupSession) return Promise.resolve(false);
        const auth = this._basicAuthHeader();
        if (!auth) return Promise.resolve(false);
        if (!this.refreshToken) return Promise.resolve(false);

        return new Promise((resolve, reject) => {
            if (cancellable?.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const bodyStr = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`;
            // @ts-ignore
            const bodyBytes = new TextEncoder().encode(bodyStr);
            const msg = Soup.Message.new('POST', 'https://accounts.spotify.com/api/token');
            msg.request_headers.append('Authorization', `Basic ${auth}`);
            msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', GLib.Bytes.new(bodyBytes));

            this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    if (cancellable?.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const dataArray = bytes.get_data();
                    if (!dataArray) {
                        resolve(false);
                        return;
                    }
                    // @ts-ignore
                    const text = new TextDecoder('utf-8').decode(dataArray);
                    const data = JSON.parse(text);
                    if (data.access_token) {
                        this.userAccessToken = data.access_token;
                        resolve(true);
                        return;
                    }
                } catch (e) {
                    logError(e as Error, 'Spotify getUserAccessToken');
                }
                resolve(false);
            });
        });
    }

    /** Client-credentials token for catalog search (no user login). */
    private getClientCredentialsToken(cancellable: Gio.Cancellable | null): Promise<boolean> {
        if (!this.soupSession) return Promise.resolve(false);
        const auth = this._basicAuthHeader();
        if (!auth) return Promise.resolve(false);

        const now = Date.now();
        if (this.ccAccessToken && now < this.ccExpiresAt - 60_000) return Promise.resolve(true);

        return new Promise((resolve, reject) => {
            if (cancellable?.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const bodyStr = 'grant_type=client_credentials';
            // @ts-ignore
            const bodyBytes = new TextEncoder().encode(bodyStr);
            const msg = Soup.Message.new('POST', 'https://accounts.spotify.com/api/token');
            msg.request_headers.append('Authorization', `Basic ${auth}`);
            msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', GLib.Bytes.new(bodyBytes));

            this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    if (cancellable?.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const dataArray = bytes.get_data();
                    if (!dataArray) {
                        resolve(false);
                        return;
                    }
                    // @ts-ignore
                    const text = new TextDecoder('utf-8').decode(dataArray);
                    const data = JSON.parse(text);
                    if (data.access_token) {
                        this.ccAccessToken = data.access_token;
                        const sec = Number(data.expires_in) || 3600;
                        this.ccExpiresAt = Date.now() + sec * 1000;
                        resolve(true);
                        return;
                    }
                } catch (e) {
                    logError(e as Error, 'Spotify getClientCredentialsToken');
                }
                resolve(false);
            });
        });
    }

    private searchSpotify(
        query: string,
        type: string,
        cancellable: Gio.Cancellable,
    ): Promise<any | null> {
        if (!this.soupSession) return Promise.resolve(null);

        return new Promise((resolve, reject) => {
            if (cancellable.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const finish = (fn: () => void) => {
                fn();
            };

            this.getClientCredentialsToken(cancellable)
                .then((ok) => {
                    if (cancellable.is_cancelled()) {
                        finish(() => reject(new Error('Search Cancelled')));
                        return;
                    }
                    if (!ok || !this.ccAccessToken) {
                        finish(() => resolve(null));
                        return;
                    }

                    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=5`;
                    const msg = Soup.Message.new('GET', url);
                    msg.request_headers.append('Authorization', `Bearer ${this.ccAccessToken}`);

                    this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                        try {
                            if (cancellable.is_cancelled()) {
                                finish(() => reject(new Error('Search Cancelled')));
                                return;
                            }
                            const bytes = session.send_and_read_finish(res);
                            const dataArray = bytes.get_data();
                            if (!dataArray) {
                                finish(() => resolve(null));
                                return;
                            }
                            // @ts-ignore
                            const text = new TextDecoder('utf-8').decode(dataArray);
                            const json = JSON.parse(text);
                            if (json.error && json.error.status === 401) {
                                this.ccAccessToken = null;
                                this.ccExpiresAt = 0;
                                finish(() => resolve(null));
                                return;
                            }
                            finish(() => resolve(json));
                        } catch (e) {
                            if (cancellable.is_cancelled()) {
                                finish(() => reject(new Error('Search Cancelled')));
                                return;
                            }
                            finish(() => resolve(null));
                        }
                    });
                })
                .catch((e) => {
                    finish(() => reject(e));
                });
        });
    }

    getInitialResultSet(terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
        return new Promise((resolve, reject) => {
            if (cancellable.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const query = terms.join(' ').trim();
            if (!query) {
                resolve([]);
                return;
            }

            const parsed = parseSpotifyCommand(query);
            if (!parsed) {
                resolve([]);
                return;
            }

            const cancelId = cancellable.connect(() => reject(new Error('Search Cancelled')));
            const cleanup = () => {
                try {
                    cancellable.disconnect(cancelId);
                } catch {
                    /* */
                }
            };

            this.searchSpotify(parsed.searchQuery, parsed.searchType, cancellable)
                .then((json) => {
                    cleanup();
                    if (cancellable.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    if (!json) {
                        resolve([]);
                        return;
                    }
                    const ids: string[] = [];
                    const items = json[`${parsed.searchType}s`]?.items || [];
                    for (const item of items) {
                        if (!item) continue;
                        item._searchType = parsed.searchType;
                        this.trackCache.set(item.uri, item);
                        ids.push(item.uri);
                    }
                    resolve(ids);
                })
                .catch((e) => {
                    cleanup();
                    reject(e);
                });
        });
    }

    getSubsearchResultSet(
        _previousResults: string[],
        terms: string[],
        cancellable: Gio.Cancellable,
    ): Promise<string[]> {
        if (cancellable.is_cancelled()) return Promise.reject(new Error('Search Cancelled'));
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(resultIds: string[], cancellable: Gio.Cancellable): Promise<any[]> {
        return new Promise((resolve, reject) => {
            if (cancellable.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const cancelId = cancellable.connect(() => reject(new Error('Search Cancelled')));

            // @ts-ignore
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

            const metas = resultIds.map((id) => {
                const item = this.trackCache.get(id);
                let desc = item?._searchType?.toUpperCase() || 'TRACK';
                if (item?.artists && item.artists.length > 0) {
                    desc += ' • ' + item.artists.map((a: any) => a.name).join(', ');
                }

                return {
                    id,
                    name: item?.name || 'Unknown',
                    description: desc,
                    createIcon: (size: number) => {
                        const px = Math.round(size * scale);
                        const gicon = this._spotifyAppInfo ? this._spotifyAppInfo.get_icon() : null;
                        if (gicon) return new St.Icon({ gicon, icon_size: px });
                        return new St.Icon({ icon_name: 'audio-x-generic', icon_size: px });
                    },
                };
            });

            try {
                cancellable.disconnect(cancelId);
            } catch {
                /* */
            }
            if (cancellable.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }
            resolve(metas);
        });
    }

    filterResults(results: string[], max: number): string[] {
        return results.slice(0, max);
    }

    activateResult(id: string, terms: string[]): void {
        const queryText = terms.join(' ').trim().toLowerCase();

        if (queryText.startsWith('$q') || queryText.startsWith('$queue')) {
            void this._activateQueue(id);
            return;
        }

        const bus = Gio.DBus.session;
        const openUriVariant = new GLib.Variant('(s)', [id]);
        bus.call(
            'org.mpris.MediaPlayer2.spotify',
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            'OpenUri',
            openUriVariant,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null,
        );
    }

    private async _activateQueue(id: string): Promise<void> {
        const item = this.trackCache.get(id);
        const trackName = item?.name || 'Track';

        if (!this.soupSession) return;

        const runQueue = async () => {
            if (!this.userAccessToken) {
                const ok = await this.getUserAccessToken(null);
                if (!ok) {
                    Main.notify('Spotify Search', 'Log in under extension settings to use Add to queue.');
                    return;
                }
            }

            const msg = Soup.Message.new(
                'POST',
                `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(id)}`,
            );
            msg.request_headers.append('Authorization', `Bearer ${this.userAccessToken}`);

            this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    s.send_and_read_finish(res);
                    const status = msg.get_status();
                    if (status === 204) {
                        Main.notify('Added to Spotify Queue', trackName);
                        return;
                    }
                    if (status === 401) {
                        this.userAccessToken = null;
                    }
                    Main.notify('Spotify Search', `Could not add to queue (HTTP ${status}). Is Spotify active?`);
                } catch (e) {
                    logError(e as Error, 'Spotify queue');
                    Main.notify('Spotify Search', 'Could not add to queue.');
                }
            });
        };

        await runQueue();
    }
}

export default class SpotifySearchExtension extends Extension {
    private provider: SpotifySearchProvider | null = null;

    enable() {
        try {
            this.provider = new SpotifySearchProvider(this, this.getSettings());
            Main.overview.searchController.addProvider(this.provider);
        } catch (e) {
            logError(e as Error, 'SpotifySearchExtension enable');
        }
    }

    disable() {
        if (this.provider) {
            Main.overview.searchController.removeProvider(this.provider);
            this.provider = null;
        }
    }
}
