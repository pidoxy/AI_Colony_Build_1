import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './env.js';
process.env.CRON_SECRET = 'test-cron-secret';
const { resetDb, startServer, stopServer, api, token, book, at } = await import('./helpers.js');
const { primary } = await import('../src/db.js');
const { clock } = await import('../src/clock.js');

before(async () => { await startServer(); });
after(stopServer);
beforeEach(async () => { await resetDb(); });

test('cron endpoints refuse without the secret, and work with it', async () => {
  assert.equal((await api('GET', '/cron/tick')).status, 401);
  assert.equal((await api('GET', '/cron/tick', { headers: { authorization: 'Bearer nope' } })).status, 401);
  const ok = await api('GET', '/cron/tick', { headers: { authorization: 'Bearer test-cron-secret' } });
  assert.equal(ok.status, 200);
});

test('cron tick releases a no-show (what the worker does, for serverless)', async () => {
  const t1 = await token(1);
  await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('10:20')));
  const r = await api('GET', '/cron/tick', { headers: { authorization: 'Bearer test-cron-secret' } });
  assert.equal(r.body.noShows.no_shows, 1);
  assert.equal((await primary.query('select status from booking')).rows[0].status, 'NO_SHOW');
});

test('cron daily runs retention and reports a clean overlap check', async () => {
  const r = await api('GET', '/cron/daily', { headers: { authorization: 'Bearer test-cron-secret' } });
  assert.equal(r.status, 200); assert.equal(r.body.overlap_rows, 0);
});

test('public policy exposes the demo flag (off here)', async () => {
  const r = await api('GET', '/policy/public');
  assert.equal(r.body.demo, false);
});
