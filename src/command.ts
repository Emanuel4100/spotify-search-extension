export type ActivationMode = 'play' | 'queue';

export type ParsedCommand = {
    searchQuery: string;
    searchType: string;
    activation: ActivationMode;
};

export function parseSpotifyCommand(query: string): ParsedCommand | null {
    const q = query.trim().toLowerCase();
    if (!q.startsWith('$') && !q.startsWith('&')) return null;

    const parts = q.substring(1).trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const arg = parts.slice(1).join(' ').trim();
    if (!arg) return null;

    if (cmd === 'p' || cmd === 'play' || cmd === 't' || cmd === 'track')
        return { searchQuery: arg, searchType: 'track', activation: 'play' };
    if (cmd === 'q' || cmd === 'queue')
        return { searchQuery: arg, searchType: 'track', activation: 'queue' };
    if (cmd === 'a' || cmd === 'artist')
        return { searchQuery: arg, searchType: 'artist', activation: 'play' };
    if (cmd === 'al' || cmd === 'album')
        return { searchQuery: arg, searchType: 'album', activation: 'play' };
    if (cmd === 'pl' || cmd === 'playlist')
        return { searchQuery: arg, searchType: 'playlist', activation: 'play' };
    return null;
}
