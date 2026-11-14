import crypto from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { config } from './config.js';
import { clock } from './clock.js';
import { unauthenticated, forbidden, ApiError } from './errors.js';
import { readQuery } from './db.js';

/* ------------------------------ students (SSO) ------------------------------ */

const enc = (s) => new TextEncoder().encode(s);
let jwks = null;

/**
 * Verify a university SSO token and return the student identity. The student id
 * comes only from the signed token (A1); nothing in a request body is trusted.
 */
export async function verifyStudentToken(token) {
  try {
    let payload;
    if (config.sso.jwksUrl) {
      jwks ??= createRemoteJWKSet(new URL(config.sso.jwksUrl), { cacheMaxAge: 10 * 60 * 1000 });
      ({ payload } = await jwtVerify(token, jwks, { issuer: config.sso.issuer, audience: config.sso.audience, currentDate: clock.now() }));
    } else if (config.sso.devSecret) {
      ({ payload } = await jwtVerify(token, enc(config.sso.devSecret), { algorithms: ['HS256'], currentDate: clock.now() }));
    } else {
      throw new Error('No SSO verification configured');
    }
    if (!payload.sub || typeof payload.email !== 'string') throw new Error('Token has no student id or email');
    return { studentId: String(payload.sub), email: payload.email.trim().toLowerCase(), name: String(payload.name || payload.email) };
  } catch {
    throw unauthenticated('Missing or expired token');
  }
}

/** Development mock of the university SSO. Disabled when a real JWKS is configured. */
export async function signDevStudentToken({ studentId, email, name }) {
  if (!config.sso.devSecret) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  return new SignJWT({ email, name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(studentId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(enc(config.sso.devSecret));
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function studentAuth(req, _res, next) {
  const t = bearer(req);
  if (!t) throw unauthenticated();
  req.student = await verifyStudentToken(t);
  next();
}

/* ------------------------------ admins (password) ------------------------------ */

const N = 16384;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32, { N: Number(n) });
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

export async function signAdminToken(op, scope = 'full') {
  return new SignJWT({ tv: op.token_version, scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(op.operator_id)
    .setIssuedAt()
    .setExpirationTime(scope === 'full' ? '8h' : '30m')
    .sign(enc(config.adminSecret));
}

async function loadAdmin(req, { allowChangeOnly = false } = {}) {
  const t = bearer(req);
  if (!t) throw unauthenticated();
  let payload;
  try {
    ({ payload } = await jwtVerify(t, enc(config.adminSecret), { algorithms: ['HS256'], currentDate: clock.now() }));
  } catch { throw unauthenticated('Missing or expired admin session'); }
  const { rows } = await readQuery('select * from operator where operator_id = $1', [payload.sub]);
  const op = rows[0];
  // Role and status are read from the database on every request, never from the token.
  if (!op || op.status === 'revoked' || op.token_version !== payload.tv) throw unauthenticated('Admin session ended');
  if (payload.scope !== 'full' && !allowChangeOnly) throw forbidden('PASSWORD_CHANGE_REQUIRED', 'Set a new password first');
  if (op.must_change_password && !allowChangeOnly) throw forbidden('PASSWORD_CHANGE_REQUIRED', 'Set a new password first');
  return op;
}

export async function adminAuth(req, _res, next) {
  req.admin = await loadAdmin(req);
  next();
}
export async function adminAuthChangeOnly(req, _res, next) {
  req.admin = await loadAdmin(req, { allowChangeOnly: true });
  next();
}
export function superAdminOnly(req, _res, next) {
  if (req.admin.role !== 'super_admin') throw forbidden('SUPER_ADMIN_ONLY', 'Only a super admin can do this');
  next();
}
