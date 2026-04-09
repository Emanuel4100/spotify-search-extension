#!/usr/bin/env node
import { readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const zipName = `${meta.uuid}.shell-extension.zip`;
const zipPath = join(root, zipName);

if (existsSync(zipPath)) unlinkSync(zipPath);

const schemaXml = readdirSync(join(root, 'schemas')).filter((f) => f.endsWith('.gschema.xml'));
const files = [
    'metadata.json',
    'extension.js',
    'prefs.js',
    join('schemas', 'gschemas.compiled'),
    ...schemaXml.map((f) => join('schemas', f)),
];

const r = spawnSync('zip', ['-r', zipName, ...files], {
    cwd: root,
    stdio: 'inherit',
});
process.exit(r.status ?? 1);
