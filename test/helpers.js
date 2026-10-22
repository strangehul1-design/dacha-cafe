// Тестовое окружение: приложение на случайном порту с пустой папкой данных и поддельным Telegram.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';

const quiet = { log() {}, warn() {}, error() {} };

/** Поддельный сервер Bot API: запоминает отправленное и отдаёт обновления через getUpdates */
export async function startFakeTelegram() {
  const state = { sent: [], edits: [], answers: [], updates: [], offset: 0, waiting: [], failNext: 0 };
  let nextMessageId = 100;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const method = req.url.split('/').pop();
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'sendMessage') {
      if (state.failNext > 0) {
        state.failNext--;
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }));
      }
      const message_id = nextMessageId++;
      state.sent.push({ ...body, message_id });
      return reply({ message_id });
    }
    if (method === 'editMessageText') {
      state.edits.push(body);
      return reply(true);
    }
    if (method === 'answerCallbackQuery') {
      state.answers.push(body);
      return reply(true);
    }
    if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'dacha_test_bot' });
    if (method === 'getUpdates') {
      const take = () => {
        const out = state.updates.filter((u) => u.update_id >= (body.offset || 0));
        return out;
      };
      const out = take();
      if (out.length) return reply(out);
      const timer = setTimeout(() => {
        state.waiting = state.waiting.filter((w) => w !== done);
        reply([]);
      }, 300);
      const done = () => {
        clearTimeout(timer);
        state.waiting = state.waiting.filter((w) => w !== done);
        reply(take());
      };
      state.waiting.push(done);
      return;
    }
    reply(true);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    pushUpdate(update) {
      update.update_id = ++state.offset;
      state.updates.push(update);
      for (const w of [...state.waiting]) w();
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

export async function startTestApp({ telegram = true, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dacha-test-'));
  const fake = telegram ? await startFakeTelegram() : null;
  const app = createApp({
    dataDir,
    apiBase: fake?.url,
    log: quiet,
    env: {
      ADMIN_PASSWORD: 'test-admin-pass',
      KITCHEN_PASSWORD: 'test-kitchen',
      ...(telegram ? { TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenFakeTokenFakeTokenFakeToken12', TELEGRAM_CHAT_ID: '-1001' } : {}),
      ...env,
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  let cookie = '';
  async function api(method, url, body, { headers = {}, raw = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    app,
    fake,
    base,
    api,
    get: (u) => api('GET', u),
    post: (u, b) => api('POST', u, b ?? {}),
    put: (u, b) => api('PUT', u, b ?? {}),
    del: (u) => api('DELETE', u),
    clearCookie: () => (cookie = ''),
    async login(password = 'test-admin-pass') {
      return api('POST', '/api/admin/login', { password });
    },
    async stop() {
      if (app.tg) app.tg.stop();
      await app.close();
      await fake?.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
