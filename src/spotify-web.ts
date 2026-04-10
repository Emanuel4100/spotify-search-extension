import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { BUNDLED_SPOTIFY_CLIENT_ID } from './spotify-config';
import { logExtensionError } from './log';
import { savedTrackMatchesQuery } from './track-meta';
import { SAVED_LIMIT, SAVED_PAGES } from './search-constants';

export type SoupJsonResult = { status: number; json: any | null; bodyText: string };

function soupMessageBytesToResult(msg: Soup.Message, bytes: GLib.Bytes): SoupJsonResult {
    const bodyArr = bytes.get_data();
    const bodyText = bodyArr
        ? // @ts-ignore
          new TextDecoder('utf-8').decode(bodyArr)
        : '';
    const status = msg.get_status();
    let json: any = null;
    try {
        if (bodyText) json = JSON.parse(bodyText);
    } catch {
        /* */
    }
    return { status, json, bodyText };
}

export function spotifyApiErrorMessage(status: number, json: any | null, fallback: string): string {
    const msg = json?.error?.message || json?.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    return `${fallback} (HTTP ${status})`;
}

/**
 * Spotify Web API often returns 204 No Content; some paths or HTTP stacks surface 200 with an empty body instead.
 * A 200 with a parsed `error` object is still a failure.
 */
export function spotifyEmptySuccess(status: number, json: any | null = null): boolean {
    if (status === 204) return true;
    if (status === 200) return json?.error == null;
    return false;
}

export class SpotifyWebClient {
    private _settings: Gio.Settings;
    private _session: Soup.Session;
    userAccessToken: string | null = null;
    private ccAccessToken: string | null = null;
    private ccExpiresAt = 0;

    constructor(settings: Gio.Settings) {
        this._settings = settings;
        this._session = new Soup.Session();
    }

    get session(): Soup.Session {
        return this._session;
    }

    private get clientId(): string {
        const fromSettings = this._settings.get_string('client-id').trim();
        return fromSettings || BUNDLED_SPOTIFY_CLIENT_ID;
    }

    private get clientSecret(): string {
        return this._settings.get_string('client-secret');
    }

    get refreshToken(): string {
        return this._settings.get_string('refresh-token');
    }

    private hasClientSecret(): boolean {
        return Boolean(this.clientSecret?.trim());
    }

    clearAuthTokens(): void {
        this.ccAccessToken = null;
        this.ccExpiresAt = 0;
        this.userAccessToken = null;
    }

    private _basicAuthHeader(): string | null {
        if (!this.clientId || !this.clientSecret) return null;
        // @ts-ignore
        const authBytes = new TextEncoder().encode(`${this.clientId}:${this.clientSecret}`);
        return GLib.base64_encode(authBytes);
    }

    getUserAccessToken(cancellable: Gio.Cancellable | null): Promise<boolean> {
        if (!this.clientId || !this.refreshToken) return Promise.resolve(false);

        return new Promise((resolve, reject) => {
            if (cancellable?.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }

            const msg = Soup.Message.new('POST', 'https://accounts.spotify.com/api/token');
            msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');

            let bodyStr: string;
            const auth = this._basicAuthHeader();
            if (auth) {
                msg.request_headers.append('Authorization', `Basic ${auth}`);
                bodyStr = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`;
            } else {
                bodyStr =
                    `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}` +
                    `&client_id=${encodeURIComponent(this.clientId)}`;
            }

            // @ts-ignore
            const bodyBytes = new TextEncoder().encode(bodyStr);
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', GLib.Bytes.new(bodyBytes));

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
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
                    logExtensionError(e, 'Spotify getUserAccessToken');
                }
                resolve(false);
            });
        });
    }

    getClientCredentialsToken(cancellable: Gio.Cancellable | null): Promise<boolean> {
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

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
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
                    logExtensionError(e, 'Spotify getClientCredentialsToken');
                }
                resolve(false);
            });
        });
    }

    async ensureSearchBearer(cancellable: Gio.Cancellable): Promise<string | null> {
        if (this.hasClientSecret()) {
            const ok = await this.getClientCredentialsToken(cancellable);
            return ok && this.ccAccessToken ? this.ccAccessToken : null;
        }
        const ok = await this.getUserAccessToken(cancellable);
        return ok && this.userAccessToken ? this.userAccessToken : null;
    }

    soupGet(
        url: string,
        bearer: string,
        cancellable: Gio.Cancellable | null,
    ): Promise<SoupJsonResult> {
        return new Promise((resolve, reject) => {
            if (cancellable?.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('Authorization', `Bearer ${bearer}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    if (cancellable?.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    resolve(soupMessageBytesToResult(msg, bytes));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    soupPutJson(
        url: string,
        bearer: string,
        jsonBody: string,
        cancellable: Gio.Cancellable | null,
    ): Promise<SoupJsonResult> {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('PUT', url);
            msg.request_headers.append('Authorization', `Bearer ${bearer}`);
            msg.request_headers.append('Content-Type', 'application/json');
            // @ts-ignore
            msg.set_request_body_from_bytes(
                'application/json',
                GLib.Bytes.new(new TextEncoder().encode(jsonBody)),
            );
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    resolve(soupMessageBytesToResult(msg, bytes));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** POST with no body (e.g. add-to-queue). Clears userAccessToken on 401 when clearTokenOn401 is true. */
    soupPostBearer(
        url: string,
        bearer: string,
        cancellable: Gio.Cancellable | null,
        clearTokenOn401: boolean,
    ): Promise<SoupJsonResult> {
        return new Promise((resolve) => {
            const msg = Soup.Message.new('POST', url);
            msg.request_headers.append('Authorization', `Bearer ${bearer}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const parsed = soupMessageBytesToResult(msg, bytes);
                    if (parsed.status === 401 && clearTokenOn401) this.userAccessToken = null;
                    resolve(parsed);
                } catch (e) {
                    logExtensionError(e, 'Spotify soupPostBearer');
                    resolve({ status: 0, json: null, bodyText: '' });
                }
            });
        });
    }

    searchSpotify(
        query: string,
        type: string,
        bearer: string,
        cancellable: Gio.Cancellable,
    ): Promise<any | null> {
        return new Promise((resolve, reject) => {
            if (cancellable.is_cancelled()) {
                reject(new Error('Search Cancelled'));
                return;
            }
            const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=5`;
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('Authorization', `Bearer ${bearer}`);

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    if (cancellable.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const dataArray = bytes.get_data();
                    if (!dataArray) {
                        resolve(null);
                        return;
                    }
                    // @ts-ignore
                    const text = new TextDecoder('utf-8').decode(dataArray);
                    const json = JSON.parse(text);
                    if (json.error && json.error.status === 401) {
                        this.clearAuthTokens();
                        resolve(null);
                        return;
                    }
                    resolve(json);
                } catch (e) {
                    if (cancellable.is_cancelled()) {
                        reject(new Error('Search Cancelled'));
                        return;
                    }
                    resolve(null);
                }
            });
        });
    }

    async fetchSavedTrackUris(
        query: string,
        userBearer: string,
        cancellable: Gio.Cancellable,
        cacheTrack: (uri: string, track: any) => void,
    ): Promise<string[]> {
        const uris: string[] = [];
        const seen = new Set<string>();
        for (let page = 0; page < SAVED_PAGES; page++) {
            const offset = page * SAVED_LIMIT;
            const url = `https://api.spotify.com/v1/me/tracks?limit=${SAVED_LIMIT}&offset=${offset}`;
            const { status, json } = await this.soupGet(url, userBearer, cancellable);
            if (status !== 200 || !json?.items) break;
            for (const row of json.items) {
                const track = row?.track;
                if (!track?.uri) continue;
                if (savedTrackMatchesQuery(track, query)) {
                    if (!seen.has(track.uri)) {
                        seen.add(track.uri);
                        uris.push(track.uri);
                        track._searchType = 'track';
                        cacheTrack(track.uri, track);
                    }
                }
            }
            if (!json.next) break;
        }
        return uris;
    }

    playRequestBodyForSpotifyUri(uri: string): string {
        if (uri.includes(':track:')) return JSON.stringify({ uris: [uri] });
        return JSON.stringify({ context_uri: uri });
    }

    async tryActivateDevice(bearer: string): Promise<boolean> {
        const { status, json } = await this.soupGet(
            'https://api.spotify.com/v1/me/player/devices',
            bearer,
            null,
        );
        if (status !== 200 || !json?.devices?.length) return false;
        const dev = json.devices.find((d: any) => d.is_active) || json.devices[0];
        if (!dev?.id) return false;
        const body = JSON.stringify({ device_ids: [dev.id], play: false });
        const r = await this.soupPutJson('https://api.spotify.com/v1/me/player', bearer, body, null);
        return spotifyEmptySuccess(r.status, r.json);
    }

    async playUriViaWebApi(uri: string): Promise<boolean> {
        const tokenOk = await this.getUserAccessToken(null);
        if (!tokenOk || !this.userAccessToken) return false;

        const body = this.playRequestBodyForSpotifyUri(uri);
        const play = async (): Promise<boolean> => {
            const r = await this.soupPutJson(
                'https://api.spotify.com/v1/me/player/play',
                this.userAccessToken!,
                body,
                null,
            );
            return spotifyEmptySuccess(r.status, r.json);
        };

        if (await play()) return true;
        if (this.userAccessToken) {
            const transferred = await this.tryActivateDevice(this.userAccessToken);
            if (transferred) return play();
        }
        return false;
    }
}
