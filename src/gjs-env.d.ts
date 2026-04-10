/** GJS / Shell imports and globals not fully covered by @girs for `tsc --noEmit`. */

declare module 'gi://Soup?version=3.0' {
    const Soup: typeof import('@girs/soup-3.0').default;
    export default Soup;
}

declare const console: {
    error(message?: unknown, ...optionalParams: unknown[]): void;
    log(message?: unknown, ...optionalParams: unknown[]): void;
};

declare const TextEncoder: {
    new (): {
        encode(input: string): Uint8Array;
    };
};

declare module 'resource:///org/gnome/shell/extensions/extension.js' {
    import type Gio from 'gi://Gio';
    export class Extension {
        uuid: string;
        enable(): void;
        disable(): void;
        getSettings(): Gio.Settings;
    }
}

declare module 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js' {
    import type Adw from 'gi://Adw';
    import type Gio from 'gi://Gio';
    export class ExtensionPreferences {
        fillPreferencesWindow(window: Adw.PreferencesWindow): void;
        getSettings(): Gio.Settings;
    }
}

declare const global: { stage: unknown };
