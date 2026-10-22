// Сборка меню для гостей: скрытые позиции убираются, списки бизнес-ланча подставляются,
// набор разделов зависит от QR-кода (menuId) и режима (стол / доставка).
import { createHash } from 'node:crypto';
import { categoryAvailable } from '../public/js/common/hours.js';

const shortHash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 6);

/** Варианты блюда. Группы с ref: 'lunch.soups' берут список из настроек «Дачные обеды». */
export function resolveOptions(dish, settings) {
  const groups = [];
  for (const g of dish.options || []) {
    let choices = g.choices || [];
    if (g.ref) {
      const key = String(g.ref).replace(/^lunch\./, '');
      const list = Array.isArray(settings.lunch?.[key]) ? settings.lunch[key] : [];
      choices = list.map((name) => ({ id: 'c' + shortHash(name), name, price: 0 }));
    }
    if (!choices.length) {
      if (g.required) return { groups, unavailable: true };
      continue;
    }
    groups.push({ id: g.id, name: g.name, required: !!g.required, choices });
  }
  return { groups, unavailable: false };
}

function modeAllows(dish, mode) {
  return mode === 'delivery' ? dish.forDelivery !== false : dish.forTable !== false;
}

export function findMenuSet(config, menuId) {
  return config.menus.find((m) => m.id === menuId) || config.menus[0] || { id: 'main', categoryIds: null };
}

/**
 * Меню для клиента.
 * mode: 'table' | 'delivery'; menuId — набор разделов для QR (null = все разделы).
 */
export function buildMenu(db, { mode = 'table', menuId = null, now = new Date() } = {}) {
  const { categories, dishes } = db.config;
  const tz = db.settings.timezone;
  const set = menuId ? findMenuSet(db.config, menuId) : null;
  const allowed = set?.categoryIds || null;

  const out = [];
  for (const cat of [...categories].sort((a, b) => a.order - b.order)) {
    if (cat.hidden) continue;
    if (allowed && !allowed.includes(cat.id)) continue;
    const items = [];
    for (const d of dishes.filter((x) => x.categoryId === cat.id).sort((a, b) => a.order - b.order)) {
      if (d.hidden || !modeAllows(d, mode)) continue;
      const { groups, unavailable } = resolveOptions(d, db.settings);
      items.push({
        id: d.id,
        name: d.name,
        desc: d.desc || '',
        price: d.price,
        weight: d.weight || '',
        image: d.image || '',
        tags: d.tags || [],
        hit: !!d.hit,
        stop: !!d.stop || unavailable,
        options: groups,
      });
    }
    if (!items.length) continue;
    out.push({
      id: cat.id,
      name: cat.name,
      note: cat.note || '',
      from: cat.from || '',
      to: cat.to || '',
      available: categoryAvailable(cat, tz, now),
      items,
    });
  }
  const rev = createHash('sha1').update(JSON.stringify(out)).digest('hex').slice(0, 10);
  return { categories: out, rev };
}

/** Категория блюда доступна по расписанию? */
export function dishCategoryAvailable(db, dish, now = new Date()) {
  const cat = db.config.categories.find((c) => c.id === dish.categoryId);
  if (!cat || cat.hidden) return false;
  return categoryAvailable(cat, db.settings.timezone, now);
}
