const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

module.exports = { pool };
