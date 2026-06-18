# Rateia.AI — Backend

Servidor que dá vida real a duas coisas do app:

1. **Grupos compartilhados** — várias pessoas, em celulares diferentes,
   acessando e editando o mesmo grupo a partir de um código de convite.
2. **Pagamento Pix** — cobrança via Mercado Pago.

## Parte 1 — Banco de dados (grupos compartilhados)

### 1. Crie um banco Postgres gratuito
A opção mais simples é o Supabase (supabase.com): crie uma conta, crie um
"New Project" e espere o banco provisionar (1–2 minutos).

### 2. Rode o schema
No painel do Supabase, abra **SQL Editor** → **New query**, cole todo o
conteúdo do arquivo `schema.sql` desta pasta, e clique em "Run". Isso cria
as tabelas `groups`, `members`, `expenses` e `expense_splits`.

### 3. Pegue a connection string
Em **Project Settings** → **Database** → **Connection string**, copie a
URI (use a versão "Connection pooling" se for publicar em Render/Railway/
Fly.io — ela lida melhor com várias conexões simultâneas).

### 4. Configure localmente
```bash
cd backend
npm install
cp .env.example .env
```
Cole a connection string em `DATABASE_URL` no `.env`.

### 5. Rode e teste
```bash
npm start
```
Teste a criação de um grupo:
```bash
curl -X POST http://localhost:3001/api/groups \
  -H "Content-Type: application/json" \
  -d '{"name":"Bar Sinuca Lagoa","yourName":"Rafael"}'
```
Você deve receber de volta um `joinCode` de 6 letras/números — é esse
código que outra pessoa vai usar pra entrar no mesmo grupo, de outro
celular, chamando `POST /api/groups/join` com `{"code":"...", "yourName":"..."}`.

### 6. Conectar ao app
No arquivo `index.html`, troque a constante:
```js
const API_BASE_URL = 'https://SEU-BACKEND-AQUI.exemplo.com';
```
pela URL do backend publicado (próximo passo).

## Como funciona a conta pessoal (plano por pessoa, não por grupo)

Não tem login com email/senha — é mais simples que isso. A pessoa clica em
"Criar conta" e recebe um código (ex: `AB12-CD34-EF56`). Esse código **só
aparece uma vez** — o banco guarda apenas o hash dele (SHA-256), nunca o
texto puro, então nem o backend consegue "mostrar de novo" se a pessoa
perder. É a chave que ela vai usar pra:
- assinar/cancelar o Plus (`PATCH /api/account`);
- provar quem ela é ao criar ou entrar num grupo, noutro grupo ou noutro
  aparelho (`creatorCode` em `POST /api/groups`, `yourCode` em
  `POST /api/groups/join`).

Regras aplicadas automaticamente:
- Grupo criado por alguém com conta **Plus** → sem limite de membros.
- Grupo criado por alguém sem conta, ou com conta **Grátis** → limite de
  5 membros (igual a antes).
- Pessoa com conta **Grátis** → só pode estar em 1 grupo ativo por vez
  (criando ou entrando). Pra entrar em outro, precisa sair do anterior.
- Pessoa com conta **Plus** → sem limite de grupos simultâneos.
- Quem nunca cria conta nenhuma continua usando o app exatamente como
  antes, sem essas regras (o servidor não tem como rastrear "a mesma
  pessoa" sem um código).

Teste rápido:
```bash
curl -X POST http://localhost:3001/api/account
# -> {"personalCode":"AB12-CD34-EF56","plan":"free"}

curl -X PATCH http://localhost:3001/api/account \
  -H "Content-Type: application/json" \
  -d '{"code":"AB12-CD34-EF56","plan":"plus"}'
```

## Parte 2 — Pagamento Pix (Mercado Pago)

### 1. Conta no Mercado Pago
Crie uma conta de desenvolvedor em https://www.mercadopago.com.br/developers
e pegue o **Access Token de TESTE** (sandbox) no painel — é de graça e não
precisa de CNPJ pra começar a testar.

### 2. Configurar
Cole o token em `MP_ACCESS_TOKEN` no mesmo `.env` do passo anterior.

### 3. Testar a cobrança
```bash
curl -X POST http://localhost:3001/api/pix/charge \
  -H "Content-Type: application/json" \
  -d '{"amount": 17.50, "description": "Teste Rateia.AI"}'
```
Você deve receber de volta um `qr_code` (texto "copia e cola") e um
`qr_code_base64` (a imagem do QR Code).

## Publicar o servidor (deploy)

Em modo de teste local, ninguém de fora consegue chamar o seu backend.
Pra valer de verdade, publique em algum desses (todos têm plano grátis
suficiente pra começar):
- Render (render.com)
- Railway (railway.app)
- Fly.io (fly.io)

Em qualquer um deles: conecte o repositório, configure as variáveis de
ambiente `DATABASE_URL` e `MP_ACCESS_TOKEN` no painel do serviço (não suba
o `.env`), e defina o comando de start como `npm start`.

## Configurar o webhook do Pix
No painel do Mercado Pago, em "Suas integrações" → "Webhooks", cadastre:
```
https://SEU-BACKEND-PUBLICADO.com/api/pix/webhook
```
É essa rota que avisa o seu sistema quando alguém efetivamente pagou o Pix.
Olhe o comentário `TODO` dentro de `server.js` — é ali que você vai plugar
a atualização de "pago" no banco de dados.

## Ir para produção
Só troque o Access Token de TESTE do Mercado Pago pelo de PRODUÇÃO depois
que a conta da empresa estiver com CNPJ vinculado e aprovada.

## Próximos passos sugeridos
- Restringir o CORS (`app.use(cors())`) para o domínio real do seu site,
  em vez de aceitar qualquer origem.
- Adicionar algum tipo de limite de uso (rate limiting) nas rotas, pra
  evitar abuso já que não há login/autenticação ainda.

