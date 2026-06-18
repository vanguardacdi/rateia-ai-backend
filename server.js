/**
 * Rateia.AI — backend
 * --------------------
 * Duas responsabilidades neste servidor:
 *
 *  1) GRUPOS (novo): cria, busca, atualiza grupos/membros/despesas num banco
 *     Postgres real, pra várias pessoas acessarem o MESMO grupo a partir de
 *     celulares diferentes, usando um código de convite.
 *
 *  2) PAGAMENTOS: cria cobranças Pix via Mercado Pago (já existia).
 *
 * Veja o README.md desta pasta para o passo a passo completo de configuração
 * (banco de dados + Mercado Pago) antes de publicar.
 */

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const pool = require('./db');
const {
  generateJoinCode,
  generateAccountCode,
  hashCode,
  findUserByCode,
  getGroupSnapshot,
  memberCount,
  assertCanJoinAnotherGroup,
  addOrRejoinMember,
  memberInUse,
  httpError
} = require('./groups');

const app = express();
app.use(cors()); // em produção, troque por: cors({ origin: 'https://seu-dominio.com' })
app.use(express.json());

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });
const mpPayment = new Payment(mpClient);

// Pequeno helper pra rotas async não precisarem repetir try/catch toda hora.
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || 'Erro interno.' });
    }
  };
}

app.get('/', (req, res) => {
  res.send('Rateia.AI — backend rodando.');
});

/* =====================================================================
   CONTA PESSOAL (código sem senha — é assim que o plano "segue" a pessoa)
   ===================================================================== */

// Cria uma conta nova. O código só é devolvido UMA VEZ — o app não tem
// como recuperá-lo depois, por isso o aviso na interface pra guardar.
app.post('/api/account', wrap(async (req, res) => {
  const userId = crypto.randomUUID();
  const code = generateAccountCode();
  await pool.query('INSERT INTO users(id, code_hash, plan) VALUES ($1, $2, $3)', [userId, hashCode(code), 'free']);
  res.json({ personalCode: code, plan: 'free' });
}));

// "Login": confirma que o código existe e devolve o plano atual.
app.post('/api/account/login', wrap(async (req, res) => {
  const { code } = req.body || {};
  const user = await findUserByCode(code);
  if (!user) throw httpError(404, 'Código não encontrado.');
  res.json({ plan: user.plan });
}));

// Simula assinar/cancelar o Plus pra essa conta.
app.patch('/api/account', wrap(async (req, res) => {
  const { code, plan } = req.body || {};
  if (plan !== 'free' && plan !== 'plus') throw httpError(400, 'Plano inválido.');
  const user = await findUserByCode(code);
  if (!user) throw httpError(404, 'Código não encontrado.');
  await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, user.id]);
  res.json({ plan });
}));

/* =====================================================================
   GRUPOS
   ===================================================================== */

// Criar um grupo novo. Quem cria já entra como o primeiro membro.
app.post('/api/groups', wrap(async (req, res) => {
  const { name, description, yourName, creatorCode } = req.body || {};
  if (!name || !name.trim()) throw httpError(400, 'Informe o nome do grupo.');
  if (!yourName || !yourName.trim()) throw httpError(400, 'Informe o seu nome.');

  let creator = null;
  if (creatorCode) {
    creator = await findUserByCode(creatorCode);
    if (!creator) throw httpError(400, 'Código de conta não encontrado.');
    await assertCanJoinAnotherGroup(creator.id, creator.plan, null);
  }

  const groupId = crypto.randomUUID();
  const memberId = crypto.randomUUID();

  let joinCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    joinCode = generateJoinCode();
    try {
      await pool.query(
        'INSERT INTO groups(id, name, description, join_code, created_by_user_id) VALUES ($1, $2, $3, $4, $5)',
        [groupId, name.trim(), (description || '').trim(), joinCode, creator ? creator.id : null]
      );
      break; // sucesso
    } catch (err) {
      if (err.code === '23505' && attempt < 4) continue; // código colidiu, tenta outro
      throw err;
    }
  }

  await pool.query(
    'INSERT INTO members(id, group_id, name, user_id) VALUES ($1, $2, $3, $4)',
    [memberId, groupId, yourName.trim(), creator ? creator.id : null]
  );

  const snapshot = await getGroupSnapshot(groupId);
  res.json({ ...snapshot, myMemberId: memberId });
}));

// Entrar num grupo existente usando o código de convite.
app.post('/api/groups/join', wrap(async (req, res) => {
  const { code, yourName, yourCode } = req.body || {};
  if (!code || !code.trim()) throw httpError(400, 'Informe o código do grupo.');
  if (!yourName || !yourName.trim()) throw httpError(400, 'Informe o seu nome.');

  let me = null;
  if (yourCode) {
    me = await findUserByCode(yourCode);
    if (!me) throw httpError(400, 'Código de conta não encontrado.');
  }

  const groupRes = await pool.query('SELECT id FROM groups WHERE join_code = $1', [code.trim().toUpperCase()]);
  if (!groupRes.rows.length) throw httpError(404, 'Não achamos nenhum grupo com esse código.');

  const groupId = groupRes.rows[0].id;
  const { memberId } = await addOrRejoinMember(groupId, yourName, me ? me.id : null);

  const snapshot = await getGroupSnapshot(groupId);
  res.json({ ...snapshot, myMemberId: memberId });
}));

// Buscar o estado atual de um grupo (usado pra sincronizar entre celulares).
app.get('/api/groups/:id', wrap(async (req, res) => {
  const snapshot = await getGroupSnapshot(req.params.id);
  if (!snapshot) throw httpError(404, 'Grupo não encontrado.');
  res.json(snapshot);
}));

// Atualizar configs do grupo (10% do garçom, nome, descrição). O plano não
// é mais configurável aqui — ele segue a conta de quem criou o grupo
// (veja PATCH /api/account).
app.patch('/api/groups/:id', wrap(async (req, res) => {
  const { serviceCharge, name, description } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;

  if (typeof serviceCharge === 'boolean') { fields.push('service_charge = $' + (i++)); values.push(serviceCharge); }
  if (typeof name === 'string' && name.trim()) { fields.push('name = $' + (i++)); values.push(name.trim()); }
  if (typeof description === 'string') { fields.push('description = $' + (i++)); values.push(description.trim()); }

  if (fields.length) {
    values.push(req.params.id);
    await pool.query(`UPDATE groups SET ${fields.join(', ')} WHERE id = $${i}`, values);
  }

  const snapshot = await getGroupSnapshot(req.params.id);
  if (!snapshot) throw httpError(404, 'Grupo não encontrado.');
  res.json(snapshot);
}));

// Apagar o grupo inteiro (e tudo dentro dele).
app.delete('/api/groups/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Adicionar membro manualmente (quando a pessoa não tem celular pra entrar com o código).
app.post('/api/groups/:id/members', wrap(async (req, res) => {
  const { name } = req.body || {};
  const { memberId } = await addOrRejoinMember(req.params.id, name);
  const snapshot = await getGroupSnapshot(req.params.id);
  res.json({ ...snapshot, myMemberId: memberId });
}));

// Remover um membro — usado tanto pra "remover alguém" quanto pra "sair do grupo".
app.delete('/api/groups/:id/members/:memberId', wrap(async (req, res) => {
  const groupId = req.params.id;
  const memberRes = await pool.query('SELECT name FROM members WHERE id = $1 AND group_id = $2', [req.params.memberId, groupId]);
  if (!memberRes.rows.length) throw httpError(404, 'Membro não encontrado.');
  const name = memberRes.rows[0].name;

  if (await memberInUse(groupId, name)) {
    throw httpError(409, 'Esse membro está em despesas lançadas, não dá pra remover.');
  }
  const total = await memberCount(groupId);
  if (total <= 1) throw httpError(400, 'O grupo precisa de pelo menos 1 membro.');

  await pool.query('DELETE FROM members WHERE id = $1', [req.params.memberId]);
  const snapshot = await getGroupSnapshot(groupId);
  res.json(snapshot);
}));

// Lançar uma despesa nova.
app.post('/api/groups/:id/expenses', wrap(async (req, res) => {
  const { title, amount, paidBy, splitAmong } = req.body || {};
  const value = Number(amount);

  if (!title || !title.trim()) throw httpError(400, 'Diz o que foi a despesa.');
  if (!value || value <= 0) throw httpError(400, 'Valor inválido.');
  if (!paidBy) throw httpError(400, 'Informe quem pediu.');
  if (!Array.isArray(splitAmong) || !splitAmong.length) throw httpError(400, 'Marca pelo menos uma pessoa pra dividir.');

  const expenseId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO expenses(id, group_id, title, amount, paid_by) VALUES ($1, $2, $3, $4, $5)',
    [expenseId, req.params.id, title.trim(), value, paidBy]
  );

  for (const person of splitAmong) {
    await pool.query(
      'INSERT INTO expense_splits(expense_id, member_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [expenseId, person]
    );
  }

  const snapshot = await getGroupSnapshot(req.params.id);
  res.json(snapshot);
}));

// Excluir uma despesa.
app.delete('/api/groups/:id/expenses/:expenseId', wrap(async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id = $1 AND group_id = $2', [req.params.expenseId, req.params.id]);
  const snapshot = await getGroupSnapshot(req.params.id);
  res.json(snapshot);
}));

/* =====================================================================
   PAGAMENTOS (Pix via Mercado Pago)
   ===================================================================== */

app.post('/api/pix/charge', wrap(async (req, res) => {
  const { amount, description, payerEmail } = req.body || {};
  const value = Number(amount);
  if (!value || value <= 0) throw httpError(400, 'Informe um "amount" válido (em reais, ex: 17.50).');

  const result = await mpPayment.create({
    body: {
      transaction_amount: value,
      description: description || 'Rateia.AI - acerto de contas',
      payment_method_id: 'pix',
      payer: { email: payerEmail || 'pagador@rateia.ai' }
    }
  });

  const txData = result.point_of_interaction && result.point_of_interaction.transaction_data;
  res.json({
    id: result.id,
    status: result.status,
    qr_code: txData ? txData.qr_code : null,
    qr_code_base64: txData ? txData.qr_code_base64 : null,
    ticket_url: txData ? txData.ticket_url : null
  });
}));

app.post('/api/pix/webhook', wrap(async (req, res) => {
  console.log('Webhook Mercado Pago recebido:', JSON.stringify(req.body));
  const paymentId = req.body && req.body.data && req.body.data.id;
  if (paymentId) {
    const info = await mpPayment.get({ id: paymentId });
    console.log('Status atualizado do pagamento', paymentId, '->', info.status);
    // TODO: marcar no banco que aquela pessoa já pagou.
  }
  res.sendStatus(200);
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Rateia.AI backend rodando na porta ' + PORT);
});
