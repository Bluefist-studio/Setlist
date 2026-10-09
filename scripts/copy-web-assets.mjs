import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDirectory = resolve(root, 'www');
const assets = [
  'index.html',
  'styles.css',
  'app.js',
  'firebase-sync.js',
  'xp-system.js',
  'exercises.json',
  'favicon.svg'
];

await mkdir(webDirectory, { recursive: true });
await Promise.all(assets.map(asset => copyFile(resolve(root, asset), resolve(webDirectory, asset))));