// Shared Postgres (Tiger Data) helper for P1 and P3.
// One pool per Functions worker; keep it small because serverless instances multiply.
// Point TIGER_DATABASE_URL at Tiger Data's connection pooler if your service has one.
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.TIGER_DATABASE_URL) throw new Error('TIGER_DATABASE_URL is not set');
    pool = new Pool({
      connectionString: process.env.TIGER_DATABASE_URL,
      ssl: { rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== '1' },
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => console.error('pg pool error', err));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, getPool };
