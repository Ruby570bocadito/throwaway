// Copies MediaPipe's WebAssembly (the on-device face detector of the photo lab) from node_modules into public/, under a
// path with the package version in it, so the site serves it itself (no CDN: a privacy tool tells no third party who
// opened it) and a cached old version can never meet new JavaScript. Runs before `dev` and `build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const target = join(root, 'public', 'mediapipe', `wasm-${version}`);

// Older copies go: only the installed version is published.
const parent = join(root, 'public', 'mediapipe');
for (const name of existsSync(parent) ? readdirSync(parent) : []) {
  if (name.startsWith('wasm-') && name !== `wasm-${version}`) rmSync(join(parent, name), { recursive: true, force: true });
}
mkdirSync(target, { recursive: true });
for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) copyFileSync(join(pkg, 'wasm', file), join(target, file));
console.log(`MediaPipe ${version}: WebAssembly copied to public/mediapipe/wasm-${version}/`);
