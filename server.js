// Точка входа: npm start
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Минимальный разбор .env: KEY=value, комментарии с #, без перезаписи уже заданных переменных */
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp({ dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data') });

app.server.listen(PORT, HOST, () => {
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('');
  console.log('  Кафе «Дача для друзей» запущено');
  console.log(`  Сайт:        ${base}/`);
  console.log(`  Админка:     ${base}/admin`);
  if (app.generatedPassword) {
    console.log('');
    console.log(`  Пароль администратора (показан один раз): ${app.generatedPassword}`);
    console.log('  Сохраните его. Сменить можно в админке: Настройки → Доступ.');
  }
  const t = app.db.settings.telegram;
  console.log('');
  console.log(t.token && t.chatId ? '  Telegram: подключён' : '  Telegram: не настроен (админка → Настройки → Telegram)');
  console.log('');
  app.tg.start();
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Останавливаюсь…');
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref();
  try {
    app.server.closeAllConnections?.();
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
