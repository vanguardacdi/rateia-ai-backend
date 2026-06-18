const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[Rateia.AI] Atenção: variável DATABASE_URL não encontrada. Copie .env.example para .env e preencha.');
}

// Bancos hospedados (Supabase, Render, Railway etc.) normalmente exigem SSL.
// Em localhost isso geralmente não é necessário.
const needsSSL = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false
});

module.exports = pool;
