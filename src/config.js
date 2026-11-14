const prod = process.env.NODE_ENV === 'production';
const onVercel = !!process.env.VERCEL;
// DEMO_MODE=1 turns on the mock sign-in even in production (public demos only).
const demo = process.env.DEMO_MODE === '1';

export const config = {
  production: prod,
  demo,
  onVercel,
  // serverless instances should hold few connections; use a pooled connection string
  poolMax: Number(process.env.PG_POOL_MAX || (onVercel ? 3 : 20)),
  cronSecret: process.env.CRON_SECRET || null,
  // no always-on worker on serverless: run the sweeps opportunistically during requests
  sweepOnRequest: process.env.SWEEP_ON_REQUEST === '1' || onVercel,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://campus@127.0.0.1:5440/campus_rooms',
  // Optional read replica. Falls back to the primary when unset.
  replicaUrl: process.env.REPLICA_DATABASE_URL || null,
  tz: process.env.CAMPUS_TZ || 'Africa/Lagos',
  tzLabel: process.env.CAMPUS_TZ_LABEL || 'WAT',
  sso: {
    // Production: verify university SSO tokens against its published keys.
    jwksUrl: process.env.SSO_JWKS_URL || null,
    issuer: process.env.SSO_ISSUER || undefined,
    audience: process.env.SSO_AUDIENCE || undefined,
    // Development only: a mock SSO signs tokens with this shared secret.
    devSecret: process.env.SSO_JWKS_URL ? null : (process.env.DEV_SSO_SECRET || (prod ? null : 'dev-sso-secret')),
  },
  adminSecret: process.env.ADMIN_SESSION_SECRET || (prod ? null : 'dev-admin-secret-change-me'),
  // The default temporary password handed to newly created admins. It is only ever
  // stored hashed, and must be changed at first login.
  adminDefaultTempPassword: process.env.ADMIN_DEFAULT_TEMP_PASSWORD || 'admin',
  retentionSalt: process.env.RETENTION_HASH_SALT || (prod ? null : 'dev-retention-salt'),
  bootstrapSuperAdmin: process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL || 'superadmin@university.test',
};

if (prod) {
  if (!config.sso.jwksUrl && !demo) throw new Error('SSO_JWKS_URL is required in production (or set DEMO_MODE=1 for a demo)');
  if (demo && !config.sso.jwksUrl && !config.sso.devSecret) throw new Error('DEV_SSO_SECRET is required when DEMO_MODE=1');
  if (!config.retentionSalt) throw new Error('RETENTION_HASH_SALT is required in production');
  if (!config.adminSecret) throw new Error('ADMIN_SESSION_SECRET is required in production');
}
