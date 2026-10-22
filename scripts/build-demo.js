// Собирает статическую демо-версию для GitHub Pages в папку docs/.
//   node scripts/build-demo.js /имя-репозитория
// Сервера в демо нет: меню берётся из настоящего приложения, а заказы имитирует js/demo.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || '').replace(/\/+$/, '');
const out = path.join(root, 'docs');

// 1. Данные из настоящего приложения на временной папке
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dacha-demo-'));
const app = createApp({ dataDir: tmp, env: { ADMIN_PASSWORD: 'demo-only' }, log: { log() {}, warn() {}, error() {} } });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const get = (p) => fetch(url + p).then((r) => r.json());
const config = await get('/api/config');
const menu = await get('/api/menu?mode=table');
const tableInfo = await get(`/api/table/${app.db.config.tables[0].code}`);
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });

// В демо один раздел «закончился», чтобы был виден стоп-лист
for (const c of menu.categories) for (const i of c.items) if (i.name === 'Мясная тарелка') i.stop = true;
config.promo = true;
delete config.open;

// 2. Копия public без админки
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, {
  recursive: true,
  filter: (src) => !/admin/.test(path.relative(path.join(root, 'public'), src)) || src === path.join(root, 'public'),
});
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, 'data', 'demo.json'), JSON.stringify({ config, menu, callReasons: tableInfo.callReasons }));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// 3. Пути: на Pages сайт живёт не в корне, а в /имя-репозитория/
const bar = '<div style="background:#14213d;color:#fff;text-align:center;font:600 13px/1.3 system-ui,sans-serif;padding:7px 12px">Демо-версия: заказы, вызовы и оплата имитируются и никуда не отправляются</div>';
function rewrite(file) {
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(/(["'(`])\/(css|js|fonts|img)\//g, `$1${base}/$2/`);
  s = s.replace(/href="\/"/g, `href="${base}/"`).replace(/href="\/privacy"/g, `href="${base}/privacy.html"`);
  if (file.endsWith('.html')) {
    s = s.replace('<head>', '<head>\n    <meta name="dacha-demo" content="1" />').replace(/<body([^>]*)>/, `<body$1>\n    ${bar}`);
  }
  fs.writeFileSync(file, s);
}
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(html|css|js)$/.test(f.name) && !p.includes('vendor')) rewrite(p);
  }
})(out);

// страница политики берёт текст через api.js-совместимый путь
const priv = path.join(out, 'js', 'privacy.js');
fs.writeFileSync(priv, fs.readFileSync(priv, 'utf8').replace("fetch('/api/privacy').then((x) => x.json())", `fetch('${base}/data/privacy.json').then((x) => x.json())`));
fs.writeFileSync(path.join(out, 'data', 'privacy.json'), JSON.stringify({ text: '', brand: config.brand, contacts: config.contacts }));

console.log(`Демо собрано в docs/ (база: "${base || '/'}")`);
