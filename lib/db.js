// Хранилище на JSON-файлах: config.json (меню, столы, настройки) и runtime.json (заказы, сессии столов).
// Запись атомарная (tmp + rename) и отложенная, чтобы не писать диск на каждый клик.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildSeedMenu, defaultSettings, defaultPromos } from './seed.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // Битый файл не затираем молча: оставляем копию рядом и стартуем с чистого листа
    fs.copyFileSync(file, file + '.broken-' + Date.now());
    console.error(`[db] ${path.basename(file)} повреждён, копия сохранена. Причина: ${e.message}`);
    return null;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Дополняет объект значениями по умолчанию (для новых настроек после обновления) */
export function deepDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) target[k] = clone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) {
      deepDefaults(target[k], v);
    }
  }
  return target;
}

export class Db {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    this.configFile = path.join(dir, 'config.json');
    this.runtimeFile = path.join(dir, 'runtime.json');
    this.timers = {};
    this.config = readJson(this.configFile);
    this.firstRun = !this.config;
    if (!this.config) {
      this.config = { ...buildSeedMenu(), settings: clone(defaultSettings), promos: clone(defaultPromos), auth: {} };
      this.saveConfig(true);
    } else {
      deepDefaults(this.config.settings, defaultSettings);
      this.config.promos ||= clone(defaultPromos);
      this.config.auth ||= {};
    }
    this.runtime = readJson(this.runtimeFile) || {};
    this.runtime.orders ||= [];
    this.runtime.sessions ||= {};
    this.runtime.seq ||= { order: 1000, call: 0, pay: 0 };
    this.runtime.stats ||= {};
    this.index = new Map(this.runtime.orders.map((o) => [o.id, o]));
  }

  get settings() {
    return this.config.settings;
  }

  /** Заказы, заявки на бронь, вызовы официанта и запросы оплаты хранятся в одном списке */
  addEntry(entry) {
    this.runtime.orders.push(entry);
    this.index.set(entry.id, entry);
    this.saveRuntime();
    return entry;
  }

  getEntry(id) {
    return this.index.get(id) || null;
  }

  schedule(name, file, getter, now = false) {
    const flush = () => {
      clearTimeout(this.timers[name]);
      delete this.timers[name];
      try {
        writeAtomic(file, getter());
      } catch (e) {
        console.error(`[db] не удалось записать ${path.basename(file)}: ${e.message}`);
      }
    };
    if (now) return flush();
    if (this.timers[name]) return;
    this.timers[name] = setTimeout(flush, 250);
  }

  saveConfig(now = false) {
    this.schedule('config', this.configFile, () => this.config, now);
  }

  saveRuntime(now = false) {
    this.schedule('runtime', this.runtimeFile, () => this.runtime, now);
  }

  flush() {
    for (const name of Object.keys(this.timers)) {
      clearTimeout(this.timers[name]);
      delete this.timers[name];
    }
    writeAtomic(this.configFile, this.config);
    writeAtomic(this.runtimeFile, this.runtime);
  }

  nextOrderNum() {
    return ++this.runtime.seq.order;
  }

  newId(prefix = '') {
    return prefix + randomBytes(5).toString('hex');
  }

  /** Старые заказы уходят из рабочего файла, чтобы он не раздувался */
  prune(maxOrders = 3000) {
    const o = this.runtime.orders;
    if (o.length > maxOrders) {
      o.splice(0, o.length - maxOrders);
      this.index = new Map(o.map((x) => [x.id, x]));
    }
    const cutoff = Date.now() - 36 * 3600 * 1000;
    for (const [id, s] of Object.entries(this.runtime.sessions)) {
      if ((s.closedAt || s.updatedAt) < cutoff) delete this.runtime.sessions[id];
    }
  }
}
