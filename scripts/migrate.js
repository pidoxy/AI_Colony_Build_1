// Apply db/schema.sql to a fresh database. Usage: node scripts/migrate.js [--reset]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');
const reset = process.argv.includes('--reset');

const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
try {
  if (reset) {
    await client.query('drop schema public cascade; create schema public;');
    console.log('schema reset');
  }
  const { rows } = await client.query(`select to_regclass('public.booking') as t`);
  if (rows[0].t) {
    console.log('schema already applied (use --reset to rebuild)');
  } else {
    await client.query(sql);
    console.log('schema applied');
  }
} finally {
  await client.end();
}
