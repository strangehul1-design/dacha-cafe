// Пароли (scrypt) и подписанные cookie для админки. Две роли: admin и kitchen (только стоп-лист).
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(len = 10) {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Первый запуск: пароль администратора берётся из ADMIN_PASSWORD или генерируется.
 * Возвращает сгенерированный пароль (его нужно показать один раз), иначе null.
 */
export function initAuth(db, env = process.env) {
  const auth = db.config.auth;
  let generated = null;
  if (!auth.secret) {
    auth.secret = randomBytes(32).toString('hex');
    db.saveConfig();
  }
  if (!auth.adminHash) {
    const pw = env.ADMIN_PASSWORD || (generated = generatePassword());
    auth.adminHash = hashPassword(pw);
    db.saveConfig();
  }
  if (!auth.kitchenHash && env.KITCHEN_PASSWORD) {
    auth.kitchenHash = hashPassword(env.KITCHEN_PASSWORD);
    db.saveConfig();
  }
  return generated;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(db, role, ttlMs = 30 * 86400_000) {
  const body = `${role}.${Date.now() + ttlMs}`;
  const sig = b64(createHmac('sha256', db.config.auth.secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Возвращает роль или null */
export function readToken(db, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  const expected = b64(createHmac('sha256', db.config.auth.secret).update(`${role}.${exp}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return role === 'admin' || role === 'kitchen' ? role : null;
}

/** Пароль → роль или null */
export function checkLogin(db, password) {
  const auth = db.config.auth;
  if (verifyPassword(password, auth.adminHash)) return 'admin';
  if (auth.kitchenHash && verifyPassword(password, auth.kitchenHash)) return 'kitchen';
  return null;
}
