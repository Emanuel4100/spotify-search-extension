export function logExtensionError(err: unknown, context: string): void {
    console.error(`[spotify-search] ${context}:`, err);
}
