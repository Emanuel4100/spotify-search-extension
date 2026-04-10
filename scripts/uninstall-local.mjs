#!/usr/bin/env node
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { uuid } = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const dest = join(homedir(), '.local/share/gnome-shell/extensions', uuid);

if (!existsSync(dest)) {
    console.log(`Nothing to remove (${dest} missing).`);
    process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
console.log(`Removed ${dest}`);
console.log('If enabled, run: gnome-extensions disable ' + uuid);
