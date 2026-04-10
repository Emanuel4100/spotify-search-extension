import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';
// @ts-ignore
import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
// @ts-ignore
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { parseSpotifyCommand } from './command';
import { logExtensionError } from './log';
import { ART_PREFETCH_CONCURRENCY, MAX_RESULTS } from './search-constants';
import { createListDesktopAppInfo } from './list-app-info';
import {
    itemNotificationLabel,
    pickSpotifyImageUrl,
    resultDisplayName,
    trackTitleWithArtists,
} from './track-meta';
import { openSpotifyUriViaMpris, spotifyMprisBusCandidatesSync } from './mpris';
import { launchSpotifyAppWithUri } from './spotify-launch';
import { SpotifyWebClient, spotifyApiErrorMessage, spotifyEmptySuccess } from './spotify-web';

export class SpotifySearchProvider {
    private _extension: Extension;
    /** Bundled .desktop so `appInfo` is always set → Shell uses ListSearchResults (provider column + list). */
    private _listAppInfo: GioUnix.DesktopAppInfo | null = null;
    private _spotifyAppInfo: GioUnix.DesktopAppInfo | null = null;
    private _api: SpotifyWebClient;
    private _settings: Gio.Settings;
    private resultCache = new Map<string, any>();
    private _artCacheDir: string | null = null;

    constructor(extension: Extension, settings: Gio.Settings) {
        this._extension = extension;
        this._settings = settings;
        this._api = new SpotifyWebClient(settings);
        try {
            // @ts-ignore Extension.dir is Gio.File
            const dir = extension.dir as Gio.File;
            const base = dir.get_path();
            if (base) {
                this._listAppInfo = createListDesktopAppInfo(base);
                if (!this._listAppInfo) {
                    const stub = GLib.build_filenamev([base, 'data', 'spotify-search.extension.desktop']);
                    if (GLib.file_test(stub, GLib.FileTest.EXISTS))
                        this._listAppInfo = GioUnix.DesktopAppInfo.new_from_filename(stub);
                }
                const cacheDir = GLib.build_filenamev([base, '.spotify-art-cache']);
                GLib.mkdir_with_parents(cacheDir, 0o755);
                this._artCacheDir = cacheDir;
            }
            this._spotifyAppInfo =
                GioUnix.DesktopAppInfo.new('com.spotify.Client.desktop') ||
                GioUnix.DesktopAppInfo.new('spotify.desktop') ||
                GioUnix.DesktopAppInfo.new('spotify-client.desktop');
        } catch (e) {
            logExtensionError(e, 'SpotifySearchProvider constructor');
        }
    }

    public get id(): string {
        return this._extension.uuid;
    }

    public get appInfo(): Gio.AppInfo | null {
        return this._listAppInfo || this._spotifyAppInfo;
    }

    public get canLaunchSearch(): boolean {
        return false;
    }

    launchSearch(_terms: string[]): void {}

    createResultObject(_meta: any): null {
        return null;
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

            void (async () => {
                try {
                    const searchBearer = await this._api.ensureSearchBearer(cancellable);
                    if (cancellable.is_cancelled()) throw new Error('Search Cancelled');
                    if (!searchBearer) {
                        cleanup();
                        resolve([]);
                        return;
                    }

                    let likedUris: string[] = [];
                    if (parsed.searchType === 'track' && this._api.refreshToken) {
                        const userOk = await this._api.getUserAccessToken(cancellable);
                        if (userOk && this._api.userAccessToken) {
                            try {
                                likedUris = await this._api.fetchSavedTrackUris(
                                    parsed.searchQuery,
                                    this._api.userAccessToken,
                                    cancellable,
                                    (uri, track) => this.resultCache.set(uri, track),
                                );
                            } catch {
                                /* */
                            }
                        }
                    }

                    const json = await this._api.searchSpotify(
                        parsed.searchQuery,
                        parsed.searchType,
                        searchBearer,
                        cancellable,
                    );
                    cleanup();
                    if (cancellable.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    if (!json) {
                        resolve([]);
                        return;
                    }

                    const ids: string[] = [...likedUris];
                    const seen = new Set(ids);
                    const items = json[`${parsed.searchType}s`]?.items || [];
                    for (const item of items) {
                        if (!item?.uri) continue;
                        if (seen.has(item.uri)) continue;
                        seen.add(item.uri);
                        item._searchType = parsed.searchType;
                        this.resultCache.set(item.uri, item);
                        ids.push(item.uri);
                        if (ids.length >= MAX_RESULTS) break;
                    }
                    resolve(ids.slice(0, MAX_RESULTS));
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            })();
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

    private _localArtPathForUrl(url: string): string | null {
        if (!this._artCacheDir) return null;
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        return GLib.build_filenamev([this._artCacheDir, `${hash}.jpg`]);
    }

    private _downloadArt(url: string, destPath: string, cancellable: Gio.Cancellable | null): Promise<boolean> {
        return new Promise((resolve) => {
            if (GLib.file_test(destPath, GLib.FileTest.EXISTS)) {
                resolve(true);
                return;
            }
            const msg = Soup.Message.new('GET', url);
            this._api.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session: any, res: any) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (msg.get_status() !== 200) {
                        resolve(false);
                        return;
                    }
                    const data = bytes.get_data();
                    if (!data || data.length === 0) {
                        resolve(false);
                        return;
                    }
                    const f = Gio.File.new_for_path(destPath);
                    f.replace_contents(
                        data,
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null,
                    );
                    resolve(true);
                } catch {
                    resolve(false);
                }
            });
        });
    }

    private async _ensureLocalArt(item: any, cancellable: Gio.Cancellable): Promise<void> {
        if (item._localArtPath && GLib.file_test(item._localArtPath, GLib.FileTest.EXISTS)) return;
        const url = pickSpotifyImageUrl(item);
        if (!url || !this._artCacheDir) return;
        const path = this._localArtPathForUrl(url);
        if (!path) return;
        const ok = await this._downloadArt(url, path, cancellable);
        if (ok) item._localArtPath = path;
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

            void (async () => {
                try {
                    for (let i = 0; i < resultIds.length; i += ART_PREFETCH_CONCURRENCY) {
                        const slice = resultIds.slice(i, i + ART_PREFETCH_CONCURRENCY);
                        await Promise.all(
                            slice.map(async (id) => {
                                const item = this.resultCache.get(id);
                                if (item && pickSpotifyImageUrl(item))
                                    await this._ensureLocalArt(item, cancellable);
                                if (cancellable.is_cancelled()) throw new Error('Search Cancelled');
                            }),
                        );
                    }

                    try {
                        cancellable.disconnect(cancelId);
                    } catch {
                        /* */
                    }
                    if (cancellable.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }

                    const metas = resultIds.map((id) => {
                        const item = this.resultCache.get(id);
                        const kind = item?._searchType || 'track';
                        const name =
                            kind === 'track' ? trackTitleWithArtists(item) : resultDisplayName(item);

                        let desc = String(kind).toUpperCase();
                        if (kind === 'track') {
                            desc = 'Track';
                        } else if (item?.artists?.length > 0) {
                            desc += ' • ' + item.artists.map((a: any) => a.name).join(', ');
                        } else if (kind === 'playlist' && item?.owner?.display_name) {
                            desc += ' • ' + item.owner.display_name;
                        }

                        return {
                            id,
                            name,
                            description: desc,
                            createIcon: (size: number) => {
                                const px = Math.round(size * scale);
                                if (item?._localArtPath && GLib.file_test(item._localArtPath, GLib.FileTest.EXISTS)) {
                                    const f = Gio.File.new_for_path(item._localArtPath);
                                    return new St.Icon({
                                        gicon: new Gio.FileIcon({ file: f }),
                                        icon_size: px,
                                    });
                                }
                                const remote = pickSpotifyImageUrl(item);
                                if (remote) {
                                    try {
                                        const f = Gio.File.new_for_uri(remote);
                                        return new St.Icon({
                                            gicon: new Gio.FileIcon({ file: f }),
                                            icon_size: px,
                                        });
                                    } catch {
                                        /* */
                                    }
                                }
                                const gicon = this._spotifyAppInfo ? this._spotifyAppInfo.get_icon() : null;
                                if (gicon) return new St.Icon({ gicon, icon_size: px });
                                return new St.Icon({ icon_name: 'audio-x-generic', icon_size: px });
                            },
                        };
                    });

                    resolve(metas);
                } catch (e) {
                    try {
                        cancellable.disconnect(cancelId);
                    } catch {
                        /* */
                    }
                    reject(e);
                }
            })();
        });
    }

    filterResults(results: string[], max: number): string[] {
        return results.slice(0, max);
    }

    activateResult(id: string, terms: string[]): void {
        const parsed = parseSpotifyCommand(terms.join(' ').trim());
        if (parsed?.activation === 'queue') {
            void this._activateQueue(id);
            return;
        }

        void this._activatePlay(id).catch((e) => logExtensionError(e, '_activatePlay'));
    }

    private _notifyPlaySuccess(uri: string): void {
        if (!this._settings.get_boolean('show-action-notifications')) return;
        const item = this.resultCache.get(uri);
        const label = item ? itemNotificationLabel(item) : uri;
        Main.notify('Spotify Search', `${label} is now playing`);
    }

    private _notifyQueueSuccess(item: any): void {
        if (!this._settings.get_boolean('show-action-notifications')) return;
        const label = item ? itemNotificationLabel(item) : 'Track';
        Main.notify('Spotify Search', `${label} added to queue`);
    }

    private async _activatePlay(uri: string): Promise<void> {
        if (!uri || !uri.startsWith('spotify:')) {
            logExtensionError(new Error(`bad activate id: ${uri}`), 'activatePlay');
            return;
        }

        const mprisCandidates = spotifyMprisBusCandidatesSync();
        // MPRIS first: a running Spotify often ignores a second `spotify --uri=…` (single-instance);
        // OpenUri talks to the active player and switches track reliably.
        if (openSpotifyUriViaMpris(uri, mprisCandidates)) {
            this._notifyPlaySuccess(uri);
            return;
        }
        // Web API before spawn: PUT /me/player/play updates the active device even when already playing.
        if (await this._api.playUriViaWebApi(uri)) {
            this._notifyPlaySuccess(uri);
            return;
        }
        if (launchSpotifyAppWithUri(uri)) {
            this._notifyPlaySuccess(uri);
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
            this._notifyPlaySuccess(uri);
        } catch (e) {
            logExtensionError(e, 'launch_default_for_uri spotify');
            Main.notify(
                'Spotify Search',
                'Could not start playback. See logs: journalctl /usr/bin/gnome-shell -f — try Log in for Web API (Premium) or reinstall from git with npm run install-ext.',
            );
        }
    }

    private async _activateQueue(id: string): Promise<void> {
        const item = this.resultCache.get(id);

        const postQueue = (after401Retry: boolean): Promise<{ status: number; json: any; bodyText: string }> => {
            if (!this._api.userAccessToken) {
                return Promise.resolve({ status: 0, json: null, bodyText: '' });
            }
            const url = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(id)}`;
            return this._api.soupPostBearer(url, this._api.userAccessToken, null, !after401Retry);
        };

        if (!this._api.userAccessToken) {
            const ok = await this._api.getUserAccessToken(null);
            if (!ok) {
                Main.notify('Spotify Search', 'Log in under extension settings to use Add to queue.');
                return;
            }
        }

        let r = await postQueue(false);
        if (spotifyEmptySuccess(r.status, r.json)) {
            this._notifyQueueSuccess(item);
            return;
        }

        if (!this._api.userAccessToken) {
            const refreshed = await this._api.getUserAccessToken(null);
            if (refreshed) r = await postQueue(true);
            if (spotifyEmptySuccess(r.status, r.json)) {
                this._notifyQueueSuccess(item);
                return;
            }
        }

        if (r.status === 404) {
            const transferred = await this._api.tryActivateDevice(this._api.userAccessToken!);
            if (transferred) {
                r = await postQueue(true);
                if (spotifyEmptySuccess(r.status, r.json)) {
                    this._notifyQueueSuccess(item);
                    return;
                }
            }
            Main.notify(
                'Spotify Search',
                'No active Spotify device. Open Spotify and start playback once, then try again.',
            );
            return;
        }

        if (r.status === 403) {
            Main.notify(
                'Spotify Search',
                spotifyApiErrorMessage(
                    r.status,
                    r.json,
                    'Queue may require Spotify Premium or additional permissions.',
                ),
            );
            return;
        }

        if (r.status === 401) {
            Main.notify('Spotify Search', 'Session expired. Log in again in extension settings.');
            return;
        }

        Main.notify(
            'Spotify Search',
            spotifyApiErrorMessage(r.status, r.json, 'Could not add to queue'),
        );
    }
}
