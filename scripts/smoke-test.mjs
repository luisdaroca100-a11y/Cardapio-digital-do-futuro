/**
 * Smoke tests do Sistema do Garçom (garçom + dono/financeiro).
 *
 * Roda em Node (sem navegador): o store roda em modo local com um
 * localStorage em memória; a página é verificada por build + HTTP +
 * checagens estáticas do fonte.
 *
 * Uso: npm test
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* localStorage em memória — o store lê `window.localStorage`. */
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(String(k), String(v)),
    removeItem: (k) => mem.delete(k),
  },
};

const store = await import(new URL('../src/lib/store.ts', import.meta.url));
const pageSrc = readFileSync(path.join(ROOT, 'src/app/page.tsx'), 'utf8');
const storeSrc = readFileSync(path.join(ROOT, 'src/lib/store.ts'), 'utf8');
const sqlSrc = readFileSync(path.join(ROOT, 'supabase.sql'), 'utf8');
const cssSrc = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name);
    console.error('  FALHOU: ' + name);
  }
}
function section(name) {
  console.log('\n== ' + name + ' ==');
}
async function throwsAsync(fn, name) {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ------------------------------------------------------------------ */
/* 1 · Dono: primeiro acesso e login                                   */
/* ------------------------------------------------------------------ */
section('1 · Dono: primeiro acesso e login');
{
  check('sem dono no início', (await store.getOwner()) === null);
  check(
    'login de dono inexistente retorna null',
    (await store.findOwnerByLogin('dono')) === null,
  );
  const hash = await store.hashPassword('senha-dono-123');
  const owner = await store.createOwner('Luis', 'dono-luis', hash);
  check('dono criado com login', owner.login === 'dono-luis');
  check('dono criado com nome', owner.name === 'Luis');
  const again = await store.getOwner();
  check('getOwner retorna o dono', again !== null && again.id === owner.id);
  check(
    'findOwnerByLogin acha o dono',
    (await store.findOwnerByLogin('dono-luis'))?.id === owner.id,
  );
  check(
    'hash da senha confere (login do dono)',
    (await store.hashPassword('senha-dono-123')) === owner.password_hash,
  );
  check(
    'senha errada não confere',
    (await store.hashPassword('outra-senha')) !== owner.password_hash,
  );
  await throwsAsync(
    () => store.createOwner('Outro', 'outro', hash),
    'segundo dono é rejeitado',
  );
}

/* ------------------------------------------------------------------ */
/* 2 · Ajustes: taxa de serviço e comissão padrão                      */
/* ------------------------------------------------------------------ */
section('2 · Ajustes');
{
  const s = await store.getSettings();
  check('taxa padrão 3%', s.service_fee_pct === 3);
  check('comissão padrão 8%', s.default_commission_pct === 8);
  check('mesas padrão 12', s.table_count === 12);
  await store.saveSettings({ service_fee_pct: 5, table_count: 12, default_commission_pct: 10 });
  const s2 = await store.getSettings();
  check('taxa salva (5%)', s2.service_fee_pct === 5);
  check('comissão padrão salva (10%)', s2.default_commission_pct === 10);
  check('order_seq preservado ao salvar ajustes', s2.order_seq === 0);
  await store.saveSettings({ service_fee_pct: 3, table_count: 12, default_commission_pct: 8 });
  check('ajustes voltam ao padrão', (await store.getSettings()).service_fee_pct === 3);
}

/* ------------------------------------------------------------------ */
/* 3 · Garçons: cadastro, % própria, edição e remoção                  */
/* ------------------------------------------------------------------ */
section('3 · Garçons');
let carlos;
let ana;
{
  const h = await store.hashPassword('1234');
  carlos = await store.createWaiter('Carlos', 'carlos', h);
  check('garçom novo herda comissão padrão 8%', carlos.commission_pct === 8);
  ana = await store.createWaiter('Ana', 'ana', h, 10);
  check('garçom com % própria (10%)', ana.commission_pct === 10);
  check('2 garçons cadastrados', (await store.listWaiters()).length === 2);
  await throwsAsync(
    () => store.createWaiter('Outro Carlos', 'carlos', h),
    'login duplicado de garçom é rejeitado',
  );
  await store.updateWaiter(carlos.id, { commission_pct: 12 });
  check(
    'editar % do garçom (12%)',
    (await store.getWaiterById(carlos.id))?.commission_pct === 12,
  );
  await store.updateWaiter(carlos.id, { commission_pct: 8 });
  check(
    '% volta pra 8%',
    (await store.getWaiterById(carlos.id))?.commission_pct === 8,
  );
  const teste = await store.createWaiter('Teste', 'teste', h);
  await store.deleteWaiter(teste.id);
  check(
    'remover garçom sem vendas funciona',
    (await store.listWaiters()).find((w) => w.id === teste.id) === undefined,
  );
}

/* ------------------------------------------------------------------ */
/* 4 · Cardápio: cadastro, edição e remoção (pelo dono)               */
/* ------------------------------------------------------------------ */
section('4 · Cardápio');
let file;
{
  const p = await store.createProduct({
    name: 'Prato da casa',
    price_cents: 3290,
    category: 'Almoço',
    prints_in: 'kitchen',
    description: 'arroz, feijão, batata frita',
  });
  check('produto criado', p.name === 'Prato da casa');
  check('descrição "o que vem" gravada', p.description === 'arroz, feijão, batata frita');
  await store.updateProduct(p.id, { price_cents: 3490 });
  const after = (await store.listProducts()).find((x) => x.id === p.id);
  check('editar preço do produto', after?.price_cents === 3490);
  await store.updateProduct(p.id, { name: 'Prato da casa 2' });
  check(
    'editar nome do produto',
    (await store.listProducts()).find((x) => x.id === p.id)?.name === 'Prato da casa 2',
  );
  await store.deleteProduct(p.id);
  check(
    'remover produto',
    (await store.listProducts()).find((x) => x.id === p.id) === undefined,
  );
  // Produto do teste de fechamento: R$ 200,00 (exemplo do dono).
  file = await store.createProduct({
    name: 'Filé R$ 200',
    price_cents: 20000,
    category: 'Almoço',
    prints_in: 'kitchen',
    description: 'arroz, feijão, 300g de filé',
  });
  check('produto de teste criado', file.price_cents === 20000);
}

/* ------------------------------------------------------------------ */
/* 5 · Fechamento: comissão congelada na conta                         */
/* ------------------------------------------------------------------ */
section('5 · Fechamento e comissão');
let bill1;
let bill2;
{
  // Exemplo do dono, sem taxa: vendeu R$ 200, 8% = R$ 16, R$ 184 do restaurante.
  await store.saveSettings({ service_fee_pct: 0, table_count: 12, default_commission_pct: 8 });
  const order1 = await store.createOrder(5, carlos);
  await store.addItem(order1.id, file);
  bill1 = await store.closeOrder(order1.id, 0);
  check('conta 1: total R$ 200,00', bill1.total_cents === 20000);
  check('conta 1: comissão R$ 16,00', bill1.commission_cents === 1600);
  check('conta 1: % congelada em 8', bill1.commission_pct === 8);
  check(
    'conta 1: restaurante fica com R$ 184,00',
    bill1.total_cents - bill1.commission_cents === 18400,
  );

  // A % do garçom muda pra 10%: a conta nova usa 10%, a antiga NÃO muda.
  await store.updateWaiter(carlos.id, { commission_pct: 10 });
  const order2 = await store.createOrder(6, carlos);
  await store.addItem(order2.id, file);
  bill2 = await store.closeOrder(order2.id, 0);
  check('conta 2: % congelada em 10', bill2.commission_pct === 10);
  check('conta 2: comissão R$ 20,00', bill2.commission_cents === 2000);
  const bills = await store.listClosedBills();
  const old = bills.find((b) => b.id === bill1.id);
  check('conta antiga mantém 8%', old?.commission_pct === 8);
  check('conta antiga mantém R$ 16,00', old?.commission_cents === 1600);
  check('2 contas fechadas', bills.length === 2);

  // Garçom com vendas não pode ser removido (o financeiro precisa dele).
  await throwsAsync(
    () => store.deleteWaiter(carlos.id),
    'remover garçom com vendas é bloqueado',
  );

  // Com taxa de serviço: subtotal R$ 100 + 3% = R$ 103; comissão 8% do total.
  await store.saveSettings({ service_fee_pct: 3, table_count: 12, default_commission_pct: 8 });
  const barato = await store.createProduct({
    name: 'Prato R$ 100',
    price_cents: 10000,
    category: 'Almoço',
    prints_in: 'kitchen',
  });
  const order3 = await store.createOrder(7, ana);
  await store.addItem(order3.id, barato);
  const bill3 = await store.closeOrder(order3.id, 3);
  check('conta 3: subtotal R$ 100,00', bill3.subtotal_cents === 10000);
  check('conta 3: taxa R$ 3,00', bill3.fee_cents === 300);
  check('conta 3: total R$ 103,00', bill3.total_cents === 10300);
  check('conta 3: comissão 10% do total = R$ 10,30', bill3.commission_cents === 1030);
  check('conta 3: % da Ana (10%)', bill3.commission_pct === 10);
}

/* ------------------------------------------------------------------ */
/* 6 · Dashboard: totais e por garçom (mesma conta do financeiro)      */
/* ------------------------------------------------------------------ */
section('6 · Dashboard');
{
  const bills = await store.listClosedBills();
  const sold = bills.reduce((s, b) => s + b.total_cents, 0);
  const comm = bills.reduce((s, b) => s + (b.commission_cents ?? 0), 0);
  check('total vendido R$ 503,00', sold === 50300);
  check('total comissão R$ 46,30', comm === 4630);
  check('restaurante fica com R$ 456,70', sold - comm === 45670);
  const carlosBills = bills.filter((b) => b.waiter_id === carlos.id);
  const carlosSold = carlosBills.reduce((s, b) => s + b.total_cents, 0);
  const carlosComm = carlosBills.reduce((s, b) => s + (b.commission_cents ?? 0), 0);
  check('Carlos vendeu R$ 400,00', carlosSold === 40000);
  check('Carlos: comissão R$ 36,00', carlosComm === 3600);
  check('Carlos: restaurante R$ 364,00', carlosSold - carlosComm === 36400);
  const anaBills = bills.filter((b) => b.waiter_id === ana.id);
  check('Ana vendeu R$ 103,00', anaBills.reduce((s, b) => s + b.total_cents, 0) === 10300);
  // Filtro de período (mesma regra da tela): contas de hoje aparecem.
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const today = bills.filter((b) => new Date(b.closed_at) >= startToday);
  check('filtro Hoje inclui as 3 contas', today.length === 3);
  const start7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  check(
    'filtro 7 dias inclui as 3 contas',
    bills.filter((b) => new Date(b.closed_at) >= start7).length === 3,
  );
  console.log(`   (resumo: vendido ${brl(sold)} · comissão ${brl(comm)} · restaurante ${brl(sold - comm)})`);
}

/* ------------------------------------------------------------------ */
/* 7 · Regressão do garçom (fluxo antigo não mudou)                    */
/* ------------------------------------------------------------------ */
section('7 · Regressão do garçom');
{
  const order = await store.createOrder(8, ana);
  await store.addItem(order.id, file);
  await store.addItem(order.id, file);
  const ow = await store.getOrderWithItems(order.id);
  check('mesmo produto soma na linha (qty 2)', ow.items.length === 1 && ow.items[0].qty === 2);
  await store.sendOrder(order.id);
  const sent = await store.getOrderWithItems(order.id);
  check('enviar marca itens como enviados', sent.items.every((i) => i.sent));
  const n1 = await store.nextOrderNumber();
  const n2 = await store.nextOrderNumber();
  check('número do pedido é sequencial', n2 === n1 + 1);
  const empty = await store.createOrder(9, ana);
  check('pedido vazio é limpo (mesa volta livre)', (await store.cleanupEmptyOrders()) === 1);
  check(
    'pedido vazio sumiu',
    (await store.getOrderWithItems(empty.id)) === null,
  );
  const bill = await store.closeOrder(order.id, 3);
  check('fechar mesa com taxa funciona', bill.total_cents === 40000 + 1200);
}

/* ------------------------------------------------------------------ */
/* 8 · Checagens estáticas: área do dono no fonte                      */
/* ------------------------------------------------------------------ */
section('8 · Fonte: área do dono');
{
  const has = (src, s, name) => check(name, src.includes(s));
  has(pageSrc, 'Sou o dono', 'login tem link "Sou o dono"');
  has(pageSrc, 'Área do dono', 'tela "Área do dono"');
  has(pageSrc, 'OwnerAuthView', 'componente de acesso do dono');
  has(pageSrc, 'OwnerDashboardView', 'componente do dashboard');
  has(pageSrc, 'OwnerWaitersView', 'componente de garçons do dono');
  has(pageSrc, 'OwnerMenuView', 'componente de cardápio do dono');
  has(pageSrc, 'OwnerSettingsView', 'componente de ajustes do dono');
  has(pageSrc, 'OWNER_SESSION_KEY', 'sessão do dono separada');
  has(pageSrc, 'handleOwnerLogin', 'login do dono');
  has(pageSrc, 'handleOwnerCreate', 'primeiro acesso do dono');
  has(pageSrc, 'Por garçom', 'dashboard mostra "Por garçom"');
  has(pageSrc, 'Contas fechadas', 'dashboard lista contas fechadas');
  has(pageSrc, 'Fica pro restaurante', 'dashboard mostra o que fica pro restaurante');
  has(pageSrc, 'Comissão dos garçons', 'dashboard mostra comissão total');
  has(pageSrc, 'Total vendido', 'dashboard mostra total vendido');
  has(pageSrc, "'Hoje'", 'filtro Hoje');
  has(pageSrc, "'7 dias'", 'filtro 7 dias');
  has(pageSrc, "'30 dias'", 'filtro 30 dias');
  has(pageSrc, "'Tudo'", 'filtro Tudo');
  has(pageSrc, 'Cadastrar garçom', 'dono cadastra garçom');
  has(pageSrc, 'Comissão (%)', 'garçom tem % de comissão');
  has(pageSrc, 'Salvar alterações', 'edição de garçom/produto');
  has(pageSrc, 'Comissão padrão (%)', 'ajuste de comissão padrão');
  has(pageSrc, 'Taxa de serviço (%)', 'ajuste de taxa de serviço');
  has(pageSrc, 'commission_cents', 'conta guarda comissão em centavos');
  has(pageSrc, 'commission_pct', 'conta guarda % do fechamento');
  has(storeSrc, 'getOwner', 'store: getOwner');
  has(storeSrc, 'createOwner', 'store: createOwner');
  has(storeSrc, 'findOwnerByLogin', 'store: findOwnerByLogin');
  has(storeSrc, 'updateWaiter', 'store: updateWaiter');
  has(storeSrc, 'deleteWaiter', 'store: deleteWaiter');
  has(storeSrc, 'updateProduct', 'store: updateProduct');
  has(storeSrc, 'DEFAULT_COMMISSION_PCT', 'store: comissão padrão 8%');
  has(sqlSrc, 'create table if not exists public.owners', 'SQL: tabela owners');
  has(sqlSrc, 'commission_pct numeric', 'SQL: coluna commission_pct');
  has(sqlSrc, 'default_commission_pct', 'SQL: coluna default_commission_pct');
  has(sqlSrc, 'commission_cents integer', 'SQL: coluna commission_cents');
  has(sqlSrc, 'add column if not exists', 'SQL: compatível com banco antigo');
  has(sqlSrc, 'dono_all_owners', 'SQL: policy RLS owners');
  has(cssSrc, '.owner-link', 'CSS: link do dono');
  has(cssSrc, '.owner-tabs', 'CSS: abas do dono');
  has(cssSrc, '.stat-grid', 'CSS: cartões do dashboard');
  // Fluxo do garçom intacto.
  has(pageSrc, 'Sistema do Garçom', 'fluxo do garçom: título intacto');
  has(pageSrc, 'Fechar mesa', 'fluxo do garçom: fechar mesa intacto');
  has(pageSrc, 'Enviar pedido', 'fluxo do garçom: enviar intacto');
  has(pageSrc, 'REVISAR', 'fluxo do garçom: revisar intacto');
  has(pageSrc, 'Como servir', 'fluxo do garçom: como servir intacto');
}

/* ------------------------------------------------------------------ */
/* 9 · Build + HTTP                                                    */
/* ------------------------------------------------------------------ */
section('9 · Build + HTTP');
{
  const run = (cmd, args) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore' });
      p.on('exit', (code) => resolve(code));
      p.on('error', () => resolve(-1));
    });
  const buildCode = await run('npm', ['run', 'build']);
  check('npm run build passa', buildCode === 0);

  // Sobe o servidor de produção e confere HTTP 200.
  const server = spawn('npx', ['next', 'start', '-p', '3100'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  let status = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:3100/');
      status = res.status;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check('servidor responde HTTP 200', status === 200);
  server.kill('SIGTERM');
}

console.log(`\n========================================`);
console.log(`SMOKE: ${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  console.log('Falhas:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log('Tudo OK.');
