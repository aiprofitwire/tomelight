import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
const watch = process.argv.includes('--watch');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

const common = { bundle: true, minify: !watch, sourcemap: false, logLevel: 'info', target: 'chrome130' };
await esbuild.build({ ...common, entryPoints: ['src/renderer/app.js'], outfile: `${out}/renderer.js`, format: 'iife' });
await esbuild.build({
  ...common,
  entryPoints: ['src/renderer/styles.css'],
  outfile: `${out}/renderer.css`,
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
});
fs.copyFileSync('src/renderer/index.html', `${out}/index.html`);
fs.copyFileSync('node_modules/mermaid/dist/mermaid.min.js', `${out}/vendor/mermaid.min.js`);
console.log('✦ built');
