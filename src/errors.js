export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const bad = (code, message, extra) => new ApiError(400, code, message, extra);
export const unprocessable = (code, message, extra) => new ApiError(422, code, message, extra);
export const conflict = (code, message, extra) => new ApiError(409, code, message, extra);
export const notFound = (code = 'NOT_FOUND', message = 'Not found') => new ApiError(404, code, message);
export const forbidden = (code, message, extra) => new ApiError(403, code, message, extra);
export const unauthenticated = (message = 'Sign in required') => new ApiError(401, 'UNAUTHENTICATED', message);
export const unavailable = (message = 'Service unavailable. Try again in a few minutes.') =>
  new ApiError(503, 'SERVICE_UNAVAILABLE', message);

const CONN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006']);
export function isConnectionError(err) {
  return !!err && (CONN_CODES.has(err.code) || /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(err.message || ''));
}
