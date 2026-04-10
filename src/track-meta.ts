export function truncateLabel(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

export function pickSpotifyImageUrl(item: any): string | null {
    const images = item?.album?.images || item?.images;
    if (!images?.length) return null;
    const last = images[images.length - 1];
    return last?.url || images[0]?.url || null;
}

export function savedTrackMatchesQuery(track: any, q: string): boolean {
    if (!track || !q) return false;
    const needle = q.trim().toLowerCase();
    if (track.name?.toLowerCase().includes(needle)) return true;
    for (const a of track.artists || []) {
        if (a?.name?.toLowerCase().includes(needle)) return true;
    }
    return false;
}

/** Non-track results: primary line is the item name. */
export function resultDisplayName(item: any): string {
    const raw = item?.name || 'Unknown';
    return truncateLabel(String(raw), 120);
}

/** Track rows: “Title — Artist1, Artist2”. */
export function trackTitleWithArtists(item: any): string {
    const title = item?.name || 'Unknown';
    const artists = item?.artists?.map((a: any) => a.name).filter(Boolean).join(', ');
    if (artists) return truncateLabel(`${title} — ${artists}`, 140);
    return truncateLabel(String(title), 140);
}

/** Summary line for notifications (tracks include artists). */
export function itemNotificationLabel(item: any): string {
    const kind = item?._searchType || 'track';
    if (kind === 'track') {
        const title = item?.name || 'Track';
        const artists = item?.artists?.map((a: any) => a.name).filter(Boolean).join(', ');
        if (artists) return truncateLabel(`${title} — ${artists}`, 200);
        return truncateLabel(String(title), 200);
    }
    return truncateLabel(item?.name || 'Spotify', 200);
}
