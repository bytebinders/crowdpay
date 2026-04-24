const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

module.exports = pool;
