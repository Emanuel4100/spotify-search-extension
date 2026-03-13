import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

// @ts-ignore
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
// @ts-ignore
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

class SpotifySearchProvider {
    public id: string = 'spotify-search-provider';
    public appInfo: Gio.DesktopAppInfo | null = null;
    public canModifyContentList: boolean = false;
    
    private soupSession: Soup.Session | null = null;
    private accessToken: string | null = null;
    private trackCache = new Map<string, any>();
    private _settings: Gio.Settings;
    
    // GNOME SHADOW QUEUE ENGINE
    private myQueue: string[] = [];
    private isHijacking: boolean = false;
    private dbusListenerId: number | null = null;

    constructor(settings: Gio.Settings) {
        this._settings = settings;
        try {
            this.appInfo = Gio.DesktopAppInfo.new('com.spotify.Client.desktop') || 
                           Gio.DesktopAppInfo.new('spotify.desktop') || 
                           Gio.DesktopAppInfo.new('spotify-client.desktop');
            this.soupSession = new Soup.Session();

            // FIXED DBUS LISTENER: Explicitly target Spotify's exact well-known DBus name
            this.dbusListenerId = Gio.DBus.session.signal_subscribe(
                'org.mpris.MediaPlayer2.spotify', 
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                '/org/mpris/MediaPlayer2',
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, parameters) => {
                    const unpacked = parameters.deep_unpack();
                    const changedProps = unpacked[1];
                    
                    // If Spotify changes the song metadata (meaning a track ended or was skipped)
                    if (changedProps && changedProps['Metadata']) {
                        if (this.myQueue.length > 0 && !this.isHijacking) {
                            this.isHijacking = true;
                            const nextUri = this.myQueue.shift();
                            
                            Gio.DBus.session.call(
                                'org.mpris.MediaPlayer2.spotify', 
                                '/org/mpris/MediaPlayer2',
                                'org.mpris.MediaPlayer2.Player',
                                'OpenUri',
                                new GLib.Variant('(s)', [nextUri!]),
                                null,
                                Gio.DBusCallFlags.NONE,
                                -1, null, null
                            );
                            
                            Main.notify("🎵 Spotify Queue", "Playing next shadow track");
                            
                            // Give DBus 2 seconds to settle so it doesn't accidentally skip multiple tracks
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                                this.isHijacking = false;
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    }
                }
            );

        } catch (e) { }
    }

    public destroy() {
        if (this.dbusListenerId) {
            Gio.DBus.session.signal_unsubscribe(this.dbusListenerId);
        }
    }

    private get clientId() { return this._settings.get_string('client-id'); }
    private get clientSecret() { return this._settings.get_string('client-secret'); }

    private async getAccessToken(): Promise<boolean> {
        if (!this.clientId || !this.clientSecret || !this.soupSession) return false;
        
        return new Promise((resolve) => {
            const authStr = `${this.clientId}:${this.clientSecret}`;
            // @ts-ignore
            const authBytes = new TextEncoder().encode(authStr);
            const auth = GLib.base64_encode(authBytes);
            const bodyStr = "grant_type=client_credentials";
            // @ts-ignore
            const bodyBytes = new TextEncoder().encode(bodyStr);

            const tokenUrl = "\x68\x74\x74\x70\x73\x3a\x2f\x2f\x61\x63\x63\x6f\x75\x6e\x74\x73\x2e\x73\x70\x6f\x74\x69\x66\x79\x2e\x63\x6f\x6d\x2f\x61\x70\x69\x2f\x74\x6f\x6b\x65\x6e";
            const msg = Soup.Message.new('POST', tokenUrl);
            msg.request_headers.append('Authorization', `Basic ${auth}`);
            msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', GLib.Bytes.new(bodyBytes));

            this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const dataArray = bytes.get_data();
                    if (!dataArray) { resolve(false); return; }
                    // @ts-ignore
                    const text = new TextDecoder('utf-8').decode(dataArray);
                    const data = JSON.parse(text);
                    if (data.access_token) {
                        this.accessToken = data.access_token;
                        resolve(true); return;
                    }
                } catch (e) { }
                resolve(false);
            });
        });
    }

    private async searchSpotify(query: string, type: string = 'track'): Promise<any> {
        if (!this.soupSession) return null;
        if (!this.accessToken) {
            const success = await this.getAccessToken();
            if (!success) return null; 
        }
        
        return new Promise((resolve) => {
            const baseUrl = "\x68\x74\x74\x70\x73\x3a\x2f\x2f\x61\x70\x69\x2e\x73\x70\x6f\x74\x69\x66\x79\x2e\x63\x6f\x6d\x2f\x76\x31\x2f\x73\x65\x61\x72\x63\x68\x3f\x71\x3d";
            const url = `${baseUrl}${encodeURIComponent(query)}&type=${type}&limit=5`;
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('Authorization', `Bearer ${this.accessToken}`);

            this.soupSession!.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const dataArray = bytes.get_data();
                    if (!dataArray) { resolve(null); return; }
                    // @ts-ignore
                    const text = new TextDecoder('utf-8').decode(dataArray);
                    const json = JSON.parse(text);
                    if (json.error && json.error.status === 401) {
                        this.accessToken = null;
                        resolve(null); return;
                    }
                    resolve(json);
                } catch (e) { resolve(null); }
            });
        });
    }

    public getInitialResultSet(terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
        return new Promise(async (resolve) => {
            const query = terms.join(' ').trim().toLowerCase();
            if (!query) { resolve([]); return; }
            let searchQuery = query;
            let searchType = 'track';
            let isQueueCommand = false;

            if (query.startsWith('$')) {
                const parts = query.substring(1).trim().split(' ');
                const cmd = parts[0];
                const arg = parts.slice(1).join(' ').trim();
                
                if (!arg) {
                    if (cmd === 'p' || cmd === 'play') { resolve(['spotify:command:play']); return; }
                    if (cmd === 'pause') { resolve(['spotify:command:pause']); return; }
                    if (cmd === 'n' || cmd === 'next') { resolve(['spotify:command:next']); return; }
                    if (cmd === 'prev' || cmd === 'previous') { resolve(['spotify:command:previous']); return; }
                    if (cmd === 'q' || cmd === 'queue') { resolve([]); return; }
                }
                if (cmd === 'p' || cmd === 'play' || cmd === 't' || cmd === 'track') { searchQuery = arg; searchType = 'track'; }
                else if (cmd === 'q' || cmd === 'queue') {
                    searchQuery = arg; searchType = 'track'; isQueueCommand = true;
                }
                else if (cmd === 'a' || cmd === 'artist') { searchQuery = arg; searchType = 'artist'; }
                else if (cmd === 'al' || cmd === 'album') { searchQuery = arg; searchType = 'album'; }
                else if (cmd === 'pl' || cmd === 'playlist') { searchQuery = arg; searchType = 'playlist'; }
                else { resolve([]); return; }
            }

            const json = await this.searchSpotify(searchQuery, searchType);
            if (!json) { resolve([]); return; }
            const ids: string[] = [];
            const items = json[`${searchType}s`]?.items || [];
            for (const item of items) {
                if (!item) continue;
                item._searchType = searchType; 
                this.trackCache.set(item.uri, item);
                ids.push(isQueueCommand ? `spotify:queue:${item.uri}` : item.uri);
            }
            resolve(ids);
        });
    }

    public getSubsearchResultSet(previousResults: string[], terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
        return this.getInitialResultSet(terms, cancellable);
    }

    public getResultMetas(resultIds: string[], cancellable: Gio.Cancellable): Promise<any[]> {
        return new Promise((resolve) => {
            const metas = resultIds.map(id => {
                if (id.startsWith('spotify:command:')) {
                    const cmd = id.split(':')[2];
                    let iconName = 'media-playback-start-symbolic';
                    if (cmd === 'pause') iconName = 'media-playback-pause-symbolic';
                    if (cmd === 'next') iconName = 'media-skip-forward-symbolic';
                    if (cmd === 'previous') iconName = 'media-skip-backward-symbolic';
                    return {
                        id, name: cmd.toUpperCase(), description: "Spotify Command",
                        createIcon: (size: number) => new St.Icon({ icon_name: iconName, icon_size: size })
                    };
                }
                
                let isQueue = false;
                let actualId = id;
                if (id.startsWith('spotify:queue:')) {
                    isQueue = true;
                    actualId = id.substring(14);
                }

                const item = this.trackCache.get(actualId);
                let desc = item?._searchType?.toUpperCase() || "TRACK";
                if (item?.artists && item.artists.length > 0) {
                    desc += " • " + item.artists.map((a: any) => a.name).join(", ");
                }
                if (isQueue) desc = "➕ Add to Shadow Queue • " + desc;

                return {
                    id: id, name: item?.name || "Unknown", description: desc,
                    createIcon: (size: number) => {
                        let gicon = this.appInfo ? this.appInfo.get_icon() : null;
                        if (gicon) return new St.Icon({ gicon: gicon, icon_size: size });
                        return new St.Icon({ icon_name: 'audio-x-generic', icon_size: size });
                    }
                };
            });
            resolve(metas);
        });
    }

    public filterResults(results: string[], max: number): string[] { return results.slice(0, max); }

    public activateResult(id: string, terms: string[]): void {
        const bus = Gio.DBus.session;

        // ADD TO SHADOW QUEUE
        if (id.startsWith('spotify:queue:')) {
            const uri = id.substring(14);
            const item = this.trackCache.get(uri);
            this.myQueue.push(uri);
            Main.notify("Added to Shadow Queue", item?.name || "Track will play next");
            return;
        }

        // COMMANDS
        if (id.startsWith('spotify:command:')) {
            const cmd = id.split(':')[2];
            
            // CUSTOM LOGIC: If they hit $next and we have queued songs, pop our queue manually!
            if (cmd === 'next' && this.myQueue.length > 0) {
                this.isHijacking = true;
                const nextUri = this.myQueue.shift();
                bus.call('org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'OpenUri', new GLib.Variant('(s)', [nextUri!]), null, Gio.DBusCallFlags.NONE, -1, null, null);
                Main.notify("🎵 Spotify Queue", "Skipped to shadow track");
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { this.isHijacking = false; return GLib.SOURCE_REMOVE; });
                return;
            }

            const method = cmd === 'play' ? 'Play' : cmd === 'pause' ? 'Pause' : cmd === 'next' ? 'Next' : 'Previous';
            bus.call('org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method, null, null, Gio.DBusCallFlags.NONE, -1, null, null);
            return;
        }

        // DIRECT PLAY
        this.myQueue = []; // Clear queue so it doesn't interrupt this new manual song!
        bus.call('org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'OpenUri', new GLib.Variant('(s)', [id]), null, Gio.DBusCallFlags.NONE, -1, null, null);
    }
}

export default class SpotifySearchExtension extends Extension {
    private provider: SpotifySearchProvider | null = null;
    enable() {
        try {
            this.provider = new SpotifySearchProvider(this.getSettings());
            Main.overview.searchController.addProvider(this.provider);
        } catch (e) { }
    }
    disable() {
        if (this.provider) {
            Main.overview.searchController.removeProvider(this.provider);
            this.provider.destroy();
            this.provider = null;
        }
    }
}
