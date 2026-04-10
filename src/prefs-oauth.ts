import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import { BUNDLED_SPOTIFY_CLIENT_ID } from './spotify-config';

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8080';

/** Scopes for queue, library (liked-first), and search when using user token (no client secret). */
export const SPOTIFY_SCOPES = 'user-modify-playback-state user-library-read';

let activeOAuthServer: Soup.Server | null = null;

export function disconnectActiveOAuthServer(): void {
    if (activeOAuthServer) {
        try {
            activeOAuthServer.disconnect();
        } catch {
            /* */
        }
        activeOAuthServer = null;
    }
}

function registerOAuthServer(server: Soup.Server): void {
    disconnectActiveOAuthServer();
    activeOAuthServer = server;
}

function clearOAuthServerIfCurrent(server: Soup.Server): void {
    if (activeOAuthServer === server) activeOAuthServer = null;
}

export function getOAuthRedirectUri(settings: Gio.Settings): string {
    if (!settings.get_boolean('oauth-use-custom-redirect')) return DEFAULT_REDIRECT_URI;
    const s = settings.get_string('oauth-redirect-uri').trim();
    return s || DEFAULT_REDIRECT_URI;
}

/** If an older install saved a non-default URI, keep using it (custom mode). */
export function migrateOAuthRedirectIfNeeded(settings: Gio.Settings): void {
    const u = settings.get_string('oauth-redirect-uri').trim();
    if (!u || u === DEFAULT_REDIRECT_URI) return;
    if (!settings.get_boolean('oauth-use-custom-redirect'))
        settings.set_boolean('oauth-use-custom-redirect', true);
}

/** Port for Soup.Server. Default 8080 if URI omits port. */
export function getOAuthRedirectPort(redirectUri: string): number {
    try {
        const u = GLib.Uri.parse(redirectUri, GLib.UriFlags.NONE);
        const p = u.get_port();
        if (p > 0) return p;
        return 8080;
    } catch {
        return 8080;
    }
}

function randomPkceVerifier(length: number): string {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let s = '';
    for (let i = 0; i < length; i++) {
        s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
}

export function effectiveClientId(settings: Gio.Settings): string {
    const s = settings.get_string('client-id').trim();
    return s || BUNDLED_SPOTIFY_CLIENT_ID;
}

export type SpotifyOAuthConnectOptions = {
    settings: Gio.Settings;
    button: Gtk.Button;
};

/**
 * Starts browser OAuth + local callback server. Disconnects any previous server first.
 */
export function connectSpotifyOAuthButton({ settings, button: btn }: SpotifyOAuthConnectOptions): void {
    btn.connect('clicked', () => {
        disconnectActiveOAuthServer();

        const clientId = effectiveClientId(settings);
        const clientSecret = settings.get_string('client-secret').trim();
        const redirectUri = getOAuthRedirectUri(settings);
        const port = getOAuthRedirectPort(redirectUri);

        const lower = redirectUri.toLowerCase();
        if (lower.startsWith('https:')) {
            btn.set_label('Redirect URI cannot be https (local server is HTTP only)');
            return;
        }
        if (!lower.startsWith('http:')) {
            btn.set_label('Redirect URI must start with http://');
            return;
        }

        const usePkce = !clientSecret;
        const pkceVerifier = usePkce ? randomPkceVerifier(64) : '';

        btn.set_label('Waiting for browser…');

        const server = new Soup.Server({});
        server.add_handler('/', (_srv, msg, _path, _query) => {
            const uri = msg.get_uri();
            const queryStr = uri.get_query();

            if (queryStr && queryStr.includes('error=')) {
                const errMatch = queryStr.match(/error=([^&]*)/);
                const descMatch = queryStr.match(/error_description=([^&]*)/);
                const errCode = errMatch ? decodeURIComponent(errMatch[1].replace(/\+/g, ' ')) : 'error';
                const errDesc = descMatch
                    ? decodeURIComponent(descMatch[1].replace(/\+/g, ' '))
                    : errCode;
                btn.set_label(`Spotify: ${errDesc.substring(0, 80)}`);
            }

            if (queryStr && queryStr.includes('code=')) {
                const raw = queryStr.split('code=')[1]?.split('&')[0] ?? '';
                let code: string;
                try {
                    code = decodeURIComponent(raw.replace(/\+/g, '%20'));
                } catch {
                    code = raw;
                }

                btn.set_label('Exchanging code…');

                const reqMsg = Soup.Message.new('POST', 'https://accounts.spotify.com/api/token');
                reqMsg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');

                let body: string;
                if (usePkce) {
                    body =
                        `grant_type=authorization_code&code=${encodeURIComponent(code)}` +
                        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                        `&client_id=${encodeURIComponent(clientId)}` +
                        `&code_verifier=${encodeURIComponent(pkceVerifier)}`;
                } else {
                    // @ts-ignore
                    const authBytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
                    const authB64 = GLib.base64_encode(authBytes);
                    reqMsg.request_headers.append('Authorization', `Basic ${authB64}`);
                    body =
                        `grant_type=authorization_code&code=${encodeURIComponent(code)}` +
                        `&redirect_uri=${encodeURIComponent(redirectUri)}`;
                }

                reqMsg.set_request_body_from_bytes(
                    'application/x-www-form-urlencoded',
                    // @ts-ignore
                    GLib.Bytes.new(new TextEncoder().encode(body)),
                );

                const session = new Soup.Session();
                session.send_and_read_async(reqMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try {
                        const bytes = s.send_and_read_finish(res);
                        const dataArray = bytes.get_data();
                        if (!dataArray) {
                            btn.set_label('Empty token response');
                            return;
                        }
                        // @ts-ignore
                        const text = new TextDecoder('utf-8').decode(dataArray);
                        const data = JSON.parse(text) as {
                            refresh_token?: string;
                            error?: string;
                            error_description?: string;
                        };

                        if (data.error) {
                            const detail = data.error_description || data.error;
                            btn.set_label(`Spotify: ${detail.substring(0, 80)}`);
                            return;
                        }

                        if (data.refresh_token) {
                            settings.set_string('refresh-token', data.refresh_token);
                        }

                        if (settings.get_string('refresh-token')) {
                            settings.apply();
                            btn.set_label('Saved. $queue and liked-first search work.');
                            return;
                        }

                        btn.set_label(
                            'No refresh token — in Spotify account remove app access once, then log in again',
                        );
                    } catch {
                        btn.set_label('Error exchanging code');
                    }
                });
            }

            msg.get_response_headers().set_content_type('text/html', null);
            const html =
                '<div style="font-family: sans-serif; text-align: center; padding-top: 100px;">' +
                '<h1 style="color: #1DB954;">Authorized</h1>' +
                '<p>You can close this tab and return to extension settings.</p></div>';
            msg.get_response_body().append(html);
            msg.set_status(200, null);

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                try {
                    server.disconnect();
                } catch {
                    /* */
                }
                clearOAuthServerIfCurrent(server);
                return GLib.SOURCE_REMOVE;
            });
        });

        try {
            server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
            registerOAuthServer(server);
        } catch {
            btn.set_label(`Port ${port} busy — change Redirect URI port or free it`);
            return;
        }

        const scope = encodeURIComponent(SPOTIFY_SCOPES);
        let authUrl =
            `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(clientId)}` +
            '&response_type=code' +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=${scope}` +
            '&prompt=consent';
        if (usePkce) {
            authUrl +=
                '&code_challenge_method=plain' +
                `&code_challenge=${encodeURIComponent(pkceVerifier)}`;
        }

        Gio.AppInfo.launch_default_for_uri(authUrl, null);
    });
}
