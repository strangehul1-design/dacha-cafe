// Тонкий клиент API. Ошибки приходят с понятным русским текстом из поля error.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// В демо-сборке для GitHub Pages (есть метка dacha-demo) сервера нет: отвечает js/demo.js
const DEMO = typeof document !== 'undefined' && !!document.querySelector('meta[name="dacha-demo"]');

async function request(method, url, body, opts = {}) {
  if (DEMO) {
    const { handle } = await import('../demo.js');
    try {
      return await handle(method, url, body);
    } catch (e) {
      throw new ApiError(e.message, e.status || 500, e.data);
    }
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !opts.raw ? { 'content-type': 'application/json' } : opts.headers,
      body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз', 0);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}. Попробуйте ещё раз`, res.status, data);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, blob) => request('POST', url, blob, { raw: true, headers: { 'content-type': 'application/octet-stream' } }),
};
