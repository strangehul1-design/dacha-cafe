// Забыли пароль администратора? Остановите сервер и выполните:
//   node scripts/reset-password.js НовыйПароль
// Для пароля повара:  node scripts/reset-password.js НовыйПароль kitchen
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'), 'config.json');
const [password, role = 'admin'] = process.argv.slice(2);

if (!password || password.length < 6) {
  console.error('Укажите новый пароль (минимум 6 символов): node scripts/reset-password.js НовыйПароль [kitchen]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`Не найден ${file}. Запустите сервер хотя бы один раз или задайте DATA_DIR.`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.auth ||= {};
cfg.auth[role === 'kitchen' ? 'kitchenHash' : 'adminHash'] = hashPassword(password);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`Пароль ${role === 'kitchen' ? 'повара' : 'администратора'} изменён. Запустите сервер.`);
