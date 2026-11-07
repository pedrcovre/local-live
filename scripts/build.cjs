const esbuild = require('esbuild');
const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
esbuild.buildSync({ entryPoints: ['src/renderer.js'], bundle: true, outfile: 'dist/app.js', platform: 'browser', format: 'esm', target: 'chrome130', sourcemap: false });
for (const file of ['index.html', 'style.css', 'pcm-worklet.js', 'video-worker.js']) {
  let content = fs.readFileSync(`src/${file}`, 'utf8');
  if (!process.env.ENTRETELAS_TEST) content = content.replace(' http://127.0.0.1:19091 ws://127.0.0.1:19091', '');
  fs.writeFileSync(`dist/${file}`, content);
}
