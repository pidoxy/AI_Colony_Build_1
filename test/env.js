// Must be imported first: points the app at the test database before config loads.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://campus@127.0.0.1:5440/campus_rooms_test';
delete process.env.REPLICA_DATABASE_URL;
delete process.env.SSO_JWKS_URL;
process.env.DEV_SSO_SECRET = 'test-sso-secret';
process.env.ADMIN_SESSION_SECRET = 'test-admin-secret';
process.env.ADMIN_DEFAULT_TEMP_PASSWORD = 'admin';
