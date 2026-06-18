const crypto = require('crypto');
const pool = require('./db');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L (evita confusão ao ditar em voz alta)
const FREE_MAX_MEMBERS = 5;

function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function generateJoinCode() {
  return randomCode(6);
}

// Código pessoal de conta: maior que o código de grupo, formatado em blocos
// pra ficar mais fácil de copiar/digitar (ex: AB12-CD34-EF56).
function generateAccountCode() {
  return randomCode(4) + '-' + randomCode(4) + '-' + randomCode(4);
}

function normalizeCode(code) {
  return (code || '').trim().toUpperCase();
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Acha a conta pelo código pessoal (ou null se não existir). Nunca expõe o código de volta. */
async function findUserByCode(code) {
  if (!code) return null;
  const r = await pool.query('SELECT id, plan FROM users WHERE code_hash = $1', [hashCode(code)]);
  return r.rows[0] || null;
}

/** Monta o "retrato" completo de um grupo (dados + membros + despesas) pra devolver ao app. */
async function getGroupSnapshot(groupId) {
  const groupRes = await pool.query(
    `SELECT g.*, u.plan AS creator_plan
       FROM groups g
       LEFT JOIN users u ON u.id = g.created_by_user_id
      WHERE g.id = $1`,
    [groupId]
  );
  if (!groupRes.rows.length) return null;
  const g = groupRes.rows[0];
  const creatorPlan = g.creator_plan || 'free'; // sem conta vinculada = trata como grátis

  const membersRes = await pool.query(
    'SELECT id, name, user_id FROM members WHERE group_id = $1 ORDER BY created_at ASC',
    [groupId]
  );

  const expensesRes = await pool.query(
    'SELECT id, title, amount, paid_by, created_at FROM expenses WHERE group_id = $1 ORDER BY created_at ASC',
    [groupId]
  );

  const expenseIds = expensesRes.rows.map((e) => e.id);
  const splitsRes = expenseIds.length
    ? await pool.query('SELECT expense_id, member_name FROM expense_splits WHERE expense_id = ANY($1::text[])', [expenseIds])
    : { rows: [] };

  const splitsByExpense = {};
  splitsRes.rows.forEach((r) => {
    (splitsByExpense[r.expense_id] = splitsByExpense[r.expense_id] || []).push(r.member_name);
  });

  return {
    id: g.id,
    name: g.name,
    description: g.description,
    joinCode: g.join_code,
    plan: creatorPlan, // "plano do grupo" = plano de quem criou (ou grátis, se ninguém vinculado)
    memberLimit: creatorPlan === 'plus' ? null : FREE_MAX_MEMBERS,
    serviceCharge: g.service_charge,
    members: membersRes.rows.map((m) => ({ id: m.id, name: m.name, hasAccount: !!m.user_id })),
    expenses: expensesRes.rows.map((e) => ({
      id: e.id,
      title: e.title,
      amount: Number(e.amount),
      paidBy: e.paid_by,
      splitAmong: splitsByExpense[e.id] || []
    }))
  };
}

async function memberCount(groupId) {
  const r = await pool.query('SELECT count(*)::int AS c FROM members WHERE group_id = $1', [groupId]);
  return r.rows[0].c;
}

/**
 * Se o usuário tem conta Grátis vinculada, ele só pode estar ativo em UM
 * grupo ao mesmo tempo. Isso checa se ele já está em outro grupo (que não
 * seja o próprio "excludeGroupId", pra não bloquear reentrar no mesmo).
 */
async function assertCanJoinAnotherGroup(userId, plan, excludeGroupId) {
  if (!userId || plan === 'plus') return; // sem conta, ou conta Plus: sem essa restrição
  const r = await pool.query(
    'SELECT 1 FROM members WHERE user_id = $1 AND group_id != $2 LIMIT 1',
    [userId, excludeGroupId || '']
  );
  if (r.rows.length) {
    throw httpError(403, 'Seu plano Grátis só permite participar de 1 grupo por vez. Saia do outro grupo primeiro, ou assine o Plus.');
  }
}

/**
 * Adiciona uma pessoa ao grupo — ou, se já existe alguém com esse nome
 * (sem diferenciar maiúsculas/minúsculas), trata como "voltar a entrar"
 * em vez de duplicar.
 */
async function addOrRejoinMember(groupId, rawName, userId) {
  const name = (rawName || '').trim();
  if (!name) throw httpError(400, 'Informe um nome.');

  const groupRes = await pool.query(
    `SELECT g.id, u.plan AS creator_plan
       FROM groups g LEFT JOIN users u ON u.id = g.created_by_user_id
      WHERE g.id = $1`,
    [groupId]
  );
  if (!groupRes.rows.length) throw httpError(404, 'Grupo não encontrado.');
  const creatorPlan = groupRes.rows[0].creator_plan || 'free';

  const existing = await pool.query(
    'SELECT id, user_id FROM members WHERE group_id = $1 AND lower(name) = lower($2)',
    [groupId, name]
  );
  if (existing.rows.length) {
    // Reentrando — se agora ela informou um código e antes não tinha vínculo, conecta.
    if (userId && !existing.rows[0].user_id) {
      await pool.query('UPDATE members SET user_id = $1 WHERE id = $2', [userId, existing.rows[0].id]);
    }
    return { memberId: existing.rows[0].id, isNew: false };
  }

  if (userId) {
    const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
    const myPlan = userRes.rows[0] ? userRes.rows[0].plan : 'free';
    await assertCanJoinAnotherGroup(userId, myPlan, groupId);
  }

  if (creatorPlan !== 'plus') {
    const count = await memberCount(groupId);
    if (count >= FREE_MAX_MEMBERS) {
      throw httpError(403, 'Esse grupo está no limite do plano Grátis (' + FREE_MAX_MEMBERS + ' membros). Quem criou o grupo precisa assinar o Plus pra liberar mais vagas.');
    }
  }

  const memberId = crypto.randomUUID();
  await pool.query('INSERT INTO members(id, group_id, name, user_id) VALUES ($1, $2, $3, $4)', [memberId, groupId, name, userId || null]);
  return { memberId, isNew: true };
}

async function memberInUse(groupId, name) {
  const r = await pool.query(
    `SELECT 1 FROM expenses WHERE group_id = $1 AND paid_by = $2
     UNION
     SELECT 1 FROM expense_splits es JOIN expenses e ON es.expense_id = e.id
       WHERE e.group_id = $1 AND es.member_name = $2
     LIMIT 1`,
    [groupId, name]
  );
  return r.rows.length > 0;
}

module.exports = {
  generateJoinCode,
  generateAccountCode,
  hashCode,
  normalizeCode,
  findUserByCode,
  getGroupSnapshot,
  memberCount,
  assertCanJoinAnotherGroup,
  addOrRejoinMember,
  memberInUse,
  httpError,
  FREE_MAX_MEMBERS
};
