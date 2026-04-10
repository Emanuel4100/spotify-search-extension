#!/usr/bin/env node
import { readFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { uuid } = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const dest = join(homedir(), '.local/share/gnome-shell/extensions', uuid);
const destSchemas = join(dest, 'schemas');

mkdirSync(destSchemas, { recursive: true });

for (const f of ['extension.js', 'prefs.js', 'metadata.json']) {
    copyFileSync(join(root, f), join(dest, f));
}
for (const xml of readdirSync(join(root, 'schemas')).filter((x) => x.endsWith('.xml'))) {
    copyFileSync(join(root, 'schemas', xml), join(destSchemas, xml));
}
const compile = spawnSync('glib-compile-schemas', [destSchemas], { encoding: 'utf8' });
if (compile.status !== 0) {
    console.error(compile.stderr || compile.stdout || 'glib-compile-schemas failed');
    process.exit(compile.status ?? 1);
}

const dataSrc = join(root, 'data');
if (existsSync(dataSrc)) {
    const dataDest = join(dest, 'data');
    mkdirSync(dataDest, { recursive: true });
    for (const f of readdirSync(dataSrc)) {
        copyFileSync(join(dataSrc, f), join(dataDest, f));
    }
}

console.log(`Installed to ${dest}`);
