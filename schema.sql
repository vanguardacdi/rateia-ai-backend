-- Rateia.AI — esquema do banco de dados
-- Rode este arquivo no seu banco Postgres (SQL Editor do Supabase, por exemplo).
-- É seguro rodar de novo mesmo que você já tenha rodado uma versão anterior —
-- os comandos abaixo não duplicam nada que já existe.

-- Contas pessoais leves (sem senha/email — a pessoa só guarda um código).
-- É aqui que o PLANO (grátis/plus) realmente mora agora.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT UNIQUE NOT NULL, -- nunca guardamos o código em texto puro
  plan        TEXT NOT NULL DEFAULT 'free', -- 'free' | 'plus'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ID da assinatura no Mercado Pago (preapproval), pra cancelar depois e
-- pra cruzar com o webhook. Fica nulo pra quem nunca assinou (ou ganhou
-- o Plus via código de proprietário).
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT;

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  join_code           TEXT UNIQUE NOT NULL,
  service_charge      BOOLEAN NOT NULL DEFAULT false, -- os 10% do garçom
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- O limite de membros do grupo agora depende do plano de quem criou,
-- não de um campo fixo no grupo — por isso "groups" não tem mais coluna "plan".
ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE groups DROP COLUMN IF EXISTS plan;

CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE members ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  paid_by     TEXT NOT NULL, -- nome de quem pediu (não é FK pra simplificar)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id   TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_name  TEXT NOT NULL,
  PRIMARY KEY (expense_id, member_name)
);

CREATE INDEX IF NOT EXISTS idx_members_group     ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_members_user      ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_group    ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_splits_expense    ON expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_groups_code       ON groups(join_code);
CREATE INDEX IF NOT EXISTS idx_groups_creator    ON groups(created_by_user_id);
