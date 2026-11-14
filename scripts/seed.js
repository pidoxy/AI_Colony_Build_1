// Seed 300 rooms, buildings, amenities, purposes, policy defaults and the bootstrap super admin.
import pg from 'pg';
import { config } from '../src/config.js';
import { seedCatalog } from '../src/seed.js';

const rooms = Number(process.argv.find((a) => a.startsWith('--rooms='))?.split('=')[1] || 300);
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
try {
  const { rows } = await client.query('select count(*)::int as n from room');
  if (rows[0].n > 0) {
    console.log('rooms already seeded; run `npm run migrate -- --reset` first to start over');
  } else {
    await client.query('begin');
    await seedCatalog(client, { rooms });
    await client.query('commit');
    console.log(`seeded ${rooms} rooms. Super admin: ${config.bootstrapSuperAdmin} (default temporary password, change at first login)`);
  }
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
