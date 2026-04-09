#!/usr/bin/env node
import { readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { uuid } = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const dest = join(homedir(), '.local/share/gnome-shell/extensions', uuid);
const destSchemas = join(dest, 'schemas');

mkdirSync(destSchemas, { recursive: true });

for (const f of ['extension.js', 'prefs.js', 'metadata.json']) {
    copyFileSync(join(root, f), join(dest, f));
}
copyFileSync(join(root, 'schemas/gschemas.compiled'), join(destSchemas, 'gschemas.compiled'));
for (const xml of readdirSync(join(root, 'schemas')).filter((x) => x.endsWith('.xml'))) {
    copyFileSync(join(root, 'schemas', xml), join(destSchemas, xml));
}

console.log(`Installed to ${dest}`);
