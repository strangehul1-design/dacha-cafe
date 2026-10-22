// Telegram: отправка заказов персоналу, повтор при сбоях, кнопки статусов (long polling).
import { buildMessage, chatFor, esc } from './messages.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = [10_000, 30_000, 120_000, 600_000, 1_800_000];
const MAX_ATTEMPTS = 8;
const RETRY_WINDOW_MS = 6 * 3600 * 1000;

export class TgError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class Telegram {
  constructor(db, { apiBase = 'https://api.telegram.org', log = console, onAction = null } = {}) {
    this.db = db;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.log = log;
    this.onAction = onAction;
    this.offset = 0;
    this.running = false;
    this.sending = new Set();
    this.lastPollError = '';
    this.me = null;
  }

  get token() {
    return this.db.settings.telegram.token;
  }

  get configured() {
    const t = this.db.settings.telegram;
    return !!(t.token && t.chatId);
  }

  async call(method, payload = {}, { timeout = 15_000 } = {}) {
    if (!this.token) throw new TgError('Не указан токен бота', 'no_token');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new TgError(e.name === 'AbortError' ? 'Telegram не отвечает (таймаут)' : `Нет связи с Telegram: ${e.cause?.code || e.message}`, 'network');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* пустой ответ */
    }
    if (!data?.ok) throw new TgError(data?.description || `Telegram вернул ${res.status}`, data?.error_code || res.status);
    return data.result;
  }

  keyboard(buttons) {
    return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
  }

  /** Отправляет запись персоналу. Результат пишется в entry.tg, ничего не бросает. */
  async notify(entry) {
    if (this.sending.has(entry.id)) return entry.tg;
    this.sending.add(entry.id);
    const prev = entry.tg?.attempts || 0;
    try {
      const chat = chatFor(this.db, entry);
      if (!this.token || !chat) {
        entry.tg = { ok: false, error: 'not_configured', attempts: 0 };
        return entry.tg;
      }
      const { text, buttons } = buildMessage(this.db, entry);
      const res = await this.call('sendMessage', {
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buttons.length ? this.keyboard(buttons) : undefined,
      });
      entry.tg = { ok: true, chatId: chat, messageId: res.message_id, at: Date.now(), attempts: prev + 1 };
    } catch (e) {
      const attempts = prev + 1;
      entry.tg = { ok: false, error: e.message, attempts, nextAt: Date.now() + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] };
      this.log.warn?.(`[telegram] не удалось отправить ${entry.type} ${entry.id}: ${e.message}`);
    } finally {
      this.sending.delete(entry.id);
      this.db.saveRuntime();
    }
    return entry.tg;
  }

  /** Обновляет текст и кнопки уже отправленного сообщения */
  async refresh(entry) {
    if (!entry.tg?.ok) return false;
    const { text, buttons } = buildMessage(this.db, entry);
    try {
      await this.call('editMessageText', {
        chat_id: entry.tg.chatId,
        message_id: entry.tg.messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: this.keyboard(buttons),
      });
      return true;
    } catch (e) {
      if (!/not modified/i.test(e.message)) this.log.warn?.(`[telegram] не удалось обновить сообщение: ${e.message}`);
      return false;
    }
  }

  /** Повторяет неотправленные записи, пока не исчерпаны попытки */
  async retryPending() {
    if (!this.token) return;
    const now = Date.now();
    const list = this.db.runtime.orders.filter(
      (e) => e.tg && !e.tg.ok && e.tg.error !== 'not_configured' && e.tg.attempts < MAX_ATTEMPTS && now >= (e.tg.nextAt || 0) && now - e.createdAt < RETRY_WINDOW_MS,
    );
    for (const e of list) await this.notify(e);
  }

  /** Отправить заново всё, что не дошло (после настройки бота или по кнопке в админке) */
  async resendUnsent() {
    const list = this.db.runtime.orders.filter((e) => e.tg && !e.tg.ok && ['new', 'requested'].includes(e.status));
    let ok = 0;
    for (const e of list) {
      e.tg.attempts = 0;
      await this.notify(e);
      if (e.tg.ok) ok++;
    }
    return { total: list.length, ok };
  }

  /** Проверка настроек из админки: данные бота и тестовое сообщение */
  async test() {
    const me = await this.call('getMe');
    this.me = me;
    const t = this.db.settings.telegram;
    const sent = [];
    for (const chat of [...new Set([t.chatId, t.deliveryChatId].filter(Boolean))]) {
      await this.call('sendMessage', {
        chat_id: chat,
        text: `✅ <b>Бот на связи</b>\nЗаказы со столов, доставка и вызовы официанта будут приходить в этот чат.`,
        parse_mode: 'HTML',
      });
      sent.push(chat);
    }
    return { bot: me.username, sent };
  }

  /* ───────────── приём нажатий кнопок ───────────── */

  start() {
    if (this.running) return;
    this.running = true;
    this.pollLoop();
    this.retryTimer = setInterval(() => this.retryPending().catch(() => {}), 20_000);
    this.retryTimer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.retryTimer);
  }

  async pollLoop() {
    let fails = 0;
    while (this.running) {
      if (!this.token) {
        await sleep(5000);
        continue;
      }
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeout: 40_000 });
        fails = 0;
        this.lastPollError = '';
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            await this.handleUpdate(u);
          } catch (e) {
            this.log.error?.('[telegram] ошибка обработки:', e.message);
          }
        }
      } catch (e) {
        fails++;
        if (e.message !== this.lastPollError) this.log.warn?.(`[telegram] опрос не удался: ${e.message}`);
        this.lastPollError = e.message;
        await sleep(Math.min(60_000, 3000 * fails));
      }
    }
  }

  allowedChat(chatId) {
    const t = this.db.settings.telegram;
    return [t.chatId, t.deliveryChatId].filter(Boolean).map(String).includes(String(chatId));
  }

  async handleUpdate(u) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const m = u.message;
    if (m?.text && /^\/(id|start)(@\w+)?(\s|$)/i.test(m.text)) {
      await this.call('sendMessage', {
        chat_id: m.chat.id,
        text: `ID этого чата: <code>${esc(m.chat.id)}</code>\nВставьте его в админке: Настройки → Telegram.`,
        parse_mode: 'HTML',
      });
    }
  }

  async handleCallback(cq) {
    const answer = (text) => this.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }).catch(() => {});
    const chatId = cq.message?.chat?.id;
    if (!this.allowedChat(chatId)) return answer('Этот чат не подключён к заказам');
    const m = /^e:([a-z0-9]+):([a-z]+)$/.exec(cq.data || '');
    if (!m || !this.onAction) return answer('Кнопка устарела');
    const from = cq.from || {};
    const actor = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? '@' + from.username : 'сотрудник');
    const result = await this.onAction(m[1], m[2], actor);
    await answer(result.toast);
  }
}
