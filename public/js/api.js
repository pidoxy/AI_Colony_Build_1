// Thin client for the Reservation API. The app never talks to the database.
const KEYS = { student: 'cr_student_token', admin: 'cr_admin_token' };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.data = body?.error || {};
  }
}

export const tokens = {
  get: (who) => { try { return sessionStorage.getItem(KEYS[who]) || localStorage.getItem(KEYS[who]); } catch { return null; } },
  set: (who, t, remember = who === 'student') => {
    try { (remember ? localStorage : sessionStorage).setItem(KEYS[who], t); } catch { /* storage blocked */ }
  },
  clear: (who) => { try { sessionStorage.removeItem(KEYS[who]); localStorage.removeItem(KEYS[who]); } catch { /* ignore */ } },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

export async function call(who, method, url, { body, headers = {}, query } = {}) {
  const t = tokens.get(who);
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (t) h.authorization = `Bearer ${t}`;
  let qs = '';
  if (query) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : v);
    qs = `?${p}`;
  }
  let res;
  try {
    res = await fetch(url + qs, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'No connection. Check your network and try again.' } });
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const student = {
  get: (u, query) => call('student', 'GET', u, { query }),
  post: (u, body, headers) => call('student', 'POST', u, { body: body ?? {}, headers }),
  put: (u, body) => call('student', 'PUT', u, { body }),
};
export const admin = {
  get: (u, query) => call('admin', 'GET', u, { query }),
  post: (u, body) => call('admin', 'POST', u, { body: body ?? {} }),
  put: (u, body) => call('admin', 'PUT', u, { body }),
  patch: (u, body) => call('admin', 'PATCH', u, { body }),
  del: (u) => call('admin', 'DELETE', u),
};
export const pub = { get: (u) => call(null, 'GET', u) };
