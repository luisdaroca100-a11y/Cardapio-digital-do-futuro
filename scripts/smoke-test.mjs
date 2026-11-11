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
/* 1 · Cadastro do restaurante + dono: primeiro acesso e login         */
/* ------------------------------------------------------------------ */
section('1 · Cadastro do restaurante + dono');
let gostoId = '';
{
  check('sem restaurante no início', (await store.listRestaurants()).length === 0);
  check('sem dono no início', (await store.getOwner()) === null);
  check('sem admin no início', (await store.getPlatformAdmin()) === null);
  check(
    'login de dono inexistente retorna null',
    (await store.findOwnerByLogin('dono')) === null,
  );
  check(
    'login livre não está tomado',
    (await store.isLoginTaken('dono-luis')) === false,
  );
  const hash = await store.hashPassword('senha-dono-123');
  const { restaurant, owner } = await store.registerRestaurant({
    restaurantName: 'Gosto Caseiro',
    ownerName: 'Luis',
    login: 'dono-luis',
    passwordHash: hash,
  });
  gostoId = restaurant.id;
  check('restaurante criado com nome', restaurant.name === 'Gosto Caseiro');
  check('restaurante ativo é o Gosto Caseiro', (await store.getActiveRestaurant())?.id === gostoId);
  check('1 restaurante cadastrado', (await store.listRestaurants()).length === 1);
  check('dono criado com login', owner.login === 'dono-luis');
  check('dono criado com nome', owner.name === 'Luis');
  check('dono pertence ao restaurante', owner.restaurant_id === gostoId);
  check(
    'login do dono agora está tomado',
    (await store.isLoginTaken('dono-luis')) === true,
  );
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
    () => store.registerRestaurant({
      restaurantName: 'Outro',
      ownerName: 'Outro',
      login: 'dono-luis',
      passwordHash: hash,
    }),
    'cadastro com login de dono já usado é rejeitado',
  );
  await throwsAsync(
    () => store.createOwner('Outro', 'outro', hash),
    'segundo dono no mesmo restaurante é rejeitado',
  );
  await throwsAsync(
    () => store.createWaiter('Falso Dono', 'dono-luis', hash),
    'garçom com login do dono é rejeitado',
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
  has(pageSrc, 'handleRestaurantRegister', 'cadastro do restaurante');
  has(pageSrc, 'Cadastrar meu restaurante', 'login tem link "Cadastrar meu restaurante"');
  has(pageSrc, 'RegisterRestaurantView', 'componente de cadastro do restaurante');
  has(pageSrc, 'handleOwnerLogin', 'login do dono');
  has(pageSrc, 'registerRestaurant', 'tela chama registerRestaurant');
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
  has(storeSrc, 'registerRestaurant', 'store: registerRestaurant');
  has(storeSrc, 'listRestaurants', 'store: listRestaurants');
  has(storeSrc, 'getActiveRestaurant', 'store: getActiveRestaurant');
  has(storeSrc, 'setActiveRestaurant', 'store: setActiveRestaurant');
  has(storeSrc, 'isLoginTaken', 'store: login único na plataforma');
  has(storeSrc, 'restaurant_id', 'store: filtro por restaurant_id');
  has(storeSrc, 'updateWaiter', 'store: updateWaiter');
  has(storeSrc, 'deleteWaiter', 'store: deleteWaiter');
  has(storeSrc, 'updateProduct', 'store: updateProduct');
  has(storeSrc, 'DEFAULT_COMMISSION_PCT', 'store: comissão padrão 8%');
  has(sqlSrc, 'create table if not exists public.owners', 'SQL: tabela owners');
  has(sqlSrc, 'create table if not exists public.restaurants', 'SQL: tabela restaurants');
  has(sqlSrc, 'create table if not exists public.platform_admins', 'SQL: tabela platform_admins');
  has(sqlSrc, 'add column if not exists restaurant_id', 'SQL: coluna restaurant_id p/ banco antigo');
  has(sqlSrc, 'next_order_number(p_restaurant_id uuid)', 'SQL: sequencial por restaurante');
  has(sqlSrc, 'settings_restaurant_id_key', 'SQL: uma linha de settings por restaurante');
  has(sqlSrc, 'Gosto Caseiro', 'SQL: migração do Gosto Caseiro');
  has(sqlSrc, 'commission_pct numeric', 'SQL: coluna commission_pct');
  has(sqlSrc, 'default_commission_pct', 'SQL: coluna default_commission_pct');
  has(sqlSrc, 'commission_cents integer', 'SQL: coluna commission_cents');
  has(sqlSrc, 'add column if not exists', 'SQL: compatível com banco antigo');
  has(sqlSrc, 'dono_all_owners', 'SQL: policy RLS owners');
  has(cssSrc, '.owner-link', 'CSS: link do dono');
  has(cssSrc, '.owner-tabs', 'CSS: abas do dono');
  has(cssSrc, '.stat-grid', 'CSS: cartões do dashboard');
  // Fechamento: só a via do balcão (CONTA) aparece; cozinha/bar só no envio.
  has(pageSrc, "data.kind === 'send' && data.kitchen.length > 0", 'fechamento: via da cozinha só aparece no envio');
  has(pageSrc, "data.kind === 'send' && data.bar.length > 0", 'fechamento: via do bar só aparece no envio');
  has(pageSrc, 'kind: \'close\',', 'fechamento: modal da conta é kind close');
  has(pageSrc, 'kind: \'send\',', 'envio: modal do pedido é kind send');
  has(pageSrc, '{data.bill && (', 'fechamento: via do balcão (CONTA) aparece');
  // Fluxo do garçom intacto.
  has(pageSrc, 'Sistema do Garçom', 'fluxo do garçom: título intacto');
  has(pageSrc, 'Fechar mesa', 'fluxo do garçom: fechar mesa intacto');
  has(pageSrc, 'Enviar pedido', 'fluxo do garçom: enviar intacto');
  has(pageSrc, 'REVISAR', 'fluxo do garçom: revisar intacto');
  has(pageSrc, 'Como servir', 'fluxo do garçom: como servir intacto');
}

/* ------------------------------------------------------------------ */
/* 9 · Finalizar dia: trava, reabertura automática às 9h e acerto     */
/* ------------------------------------------------------------------ */
section('9 · Finalizar dia');
{
  const s0 = await store.getSettings();
  check('dia aberto no início (sem data)', s0.day_closed_date == null);
  check('isDayClosed false com dia aberto', store.isDayClosed(s0) === false);

  // Data local de hoje no formato AAAA-MM-DD.
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const todayStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  check('localDateString devolve hoje', store.localDateString(now) === todayStr);

  // Finalizar o dia grava a data de hoje.
  const fin = await store.finalizeDay();
  check('finalizeDay grava a data de hoje', fin.day_closed_date === todayStr);
  const s1 = await store.getSettings();
  check('data do fechamento persiste no banco', s1.day_closed_date === todayStr);
  check('dia fechado logo após finalizar', store.isDayClosed(s1) === true);
  check(
    'dia fechado ainda hoje às 23:30',
    store.isDayClosed(s1, new Date(y, m, d, 23, 30)) === true,
  );
  check(
    'dia fechado no dia seguinte às 8h (antes das 9h)',
    store.isDayClosed(s1, new Date(y, m, d + 1, 8, 0)) === true,
  );
  check(
    'dia fechado no dia seguinte às 8:59',
    store.isDayClosed(s1, new Date(y, m, d + 1, 8, 59)) === true,
  );
  check(
    'dia reabre sozinho no dia seguinte às 9h',
    store.isDayClosed(s1, new Date(y, m, d + 1, 9, 0)) === false,
  );
  check(
    'dia aberto no dia seguinte às 12h',
    store.isDayClosed(s1, new Date(y, m, d + 1, 12, 0)) === false,
  );
  check(
    'dia aberto 2 dias depois às 8h',
    store.isDayClosed(s1, new Date(y, m, d + 2, 8, 0)) === false,
  );
  check(
    'data inválida não trava o dia',
    store.isDayClosed({ ...s1, day_closed_date: 'invalida' }) === false,
  );

  // Salvar ajustes não apaga o fechamento do dia.
  await store.saveSettings({ service_fee_pct: 4, table_count: 12, default_commission_pct: 8 });
  check(
    'fechamento preservado ao salvar ajustes',
    (await store.getSettings()).day_closed_date === todayStr,
  );
  await store.saveSettings({ service_fee_pct: 3, table_count: 12, default_commission_pct: 8 });

  // Acerto do dia: quanto pagar pra cada garçom (vendas de hoje).
  const bills = await store.listClosedBills();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const todayBills = bills.filter((b) => new Date(b.closed_at) >= startToday);
  check('4 contas fechadas hoje', todayBills.length === 4);
  const pay = (waiterId) => {
    const wb = todayBills.filter((b) => b.waiter_id === waiterId);
    return {
      sold: wb.reduce((s, b) => s + b.total_cents, 0),
      comm: wb.reduce((s, b) => s + (b.commission_cents ?? 0), 0),
    };
  };
  const carlosPay = pay(carlos.id);
  check('Carlos vendeu hoje R$ 400,00', carlosPay.sold === 40000);
  check('Carlos tem a receber R$ 36,00', carlosPay.comm === 3600);
  const anaPay = pay(ana.id);
  check('Ana vendeu hoje R$ 515,00', anaPay.sold === 51500);
  check('Ana tem a receber R$ 51,50', anaPay.comm === 5150);
  const totalPay = todayBills.reduce((s, b) => s + (b.commission_cents ?? 0), 0);
  check('total a pagar aos garçons R$ 87,50', totalPay === 8750);
  const totalSold = todayBills.reduce((s, b) => s + b.total_cents, 0);
  check('restaurante fica com R$ 827,50', totalSold - totalPay === 82750);

  // Reabrir o dia (dono finalizou sem querer).
  const re = await store.reopenDay();
  check('reopenDay limpa a data', re.day_closed_date == null);
  const s2 = await store.getSettings();
  check('dia aberto após reabrir', store.isDayClosed(s2) === false);
  check('data limpa no banco', s2.day_closed_date == null);

  // Checagens estáticas da tela.
  const has = (src, s, name) => check(name, src.includes(s));
  has(pageSrc, 'Finalizar dia', 'dashboard: botão "Finalizar dia"');
  has(pageSrc, 'Reabrir dia', 'dashboard: botão "Reabrir dia"');
  has(pageSrc, 'Finalizar o dia?', 'dashboard: confirmação de finalizar');
  has(pageSrc, 'Quanto pagar pra cada garçom', 'confirmação: quanto pagar por garçom');
  has(pageSrc, 'a receber', 'confirmação: valor a receber do garçom');
  has(pageSrc, 'A pagar aos garçons', 'confirmação: total a pagar');
  has(pageSrc, 'Dia encerrado', 'tela de mesas: aviso de dia encerrado');
  has(pageSrc, 'Reabre amanhã às 9h', 'aviso: reabre às 9h');
  has(pageSrc, 'dayClosedNow', 'travas do garçom conferem o dia no banco');
  has(pageSrc, 'finalizeDay', 'tela chama finalizeDay');
  has(pageSrc, 'reopenDay', 'tela chama reopenDay');
  has(pageSrc, 'isDayClosed(settings)', 'tela de mesas e dashboard leem o estado do dia');
  has(pageSrc, 'settings={settings}', 'dashboard recebe os ajustes (estado do dia)');
  has(storeSrc, 'isDayClosed', 'store: isDayClosed');
  has(storeSrc, 'finalizeDay', 'store: finalizeDay');
  has(storeSrc, 'reopenDay', 'store: reopenDay');
  has(storeSrc, 'DAY_REOPEN_HOUR', 'store: reabertura às 9h');
  has(storeSrc, 'localDateString', 'store: data local AAAA-MM-DD');
  has(storeSrc, 'day_closed_date', 'store: campo day_closed_date');
  has(sqlSrc, 'day_closed_date', 'SQL: coluna day_closed_date');
  has(sqlSrc, 'add column if not exists day_closed_date', 'SQL: compatível com banco antigo');

  // O resumo de quanto pagar é SÓ do dono: o garçom só vê o aviso de
  // dia encerrado, sem nenhum valor. As frases de pagamento só podem
  // existir dentro da área do dono (dashboard), nunca na parte do garçom.
  const dashStart = pageSrc.indexOf('DONO: DASHBOARD FINANCEIRO');
  const dashEnd = pageSrc.indexOf('DONO: GARÇONS');
  const dashSrc = pageSrc.slice(dashStart, dashEnd);
  const waiterSrc = pageSrc.slice(0, dashStart);
  for (const s of [
    'a receber',
    'Quanto pagar pra cada garçom',
    'A pagar aos garçons',
    'Finalizar dia',
    'Reabrir dia',
  ]) {
    check(
      '"' + s + '" só aparece na área do dono',
      dashSrc.includes(s) && !waiterSrc.includes(s),
    );
  }
  check(
    'garçom vê o aviso de dia encerrado',
    waiterSrc.includes('Dia encerrado'),
  );
  check(
    'aviso do garçom é só o aviso, sem valor',
    waiterSrc.includes('O dia está encerrado. Reabre amanhã às 9h.'),
  );
}

/* ------------------------------------------------------------------ */
/* 10 · Multi-restaurante: isolamento entre dois restaurantes          */
/* ------------------------------------------------------------------ */
section('10 · Multi-restaurante');
let bellaId = '';
{
  const h = await store.hashPassword('senha-bela');
  const { restaurant, owner } = await store.registerRestaurant({
    restaurantName: 'Cantina Bella',
    ownerName: 'Bela',
    login: 'dono-bela',
    passwordHash: h,
  });
  bellaId = restaurant.id;
  check('segundo restaurante criado', restaurant.name === 'Cantina Bella');
  check('2 restaurantes cadastrados', (await store.listRestaurants()).length === 2);
  check('restaurante ativo trocou pra Bella', (await store.getActiveRestaurant())?.id === bellaId);
  check('dona da Bella', owner.name === 'Bela');
  // Restaurante novo começa vazio — nada do Gosto Caseiro aparece aqui.
  check('Bella: sem garçons', (await store.listWaiters()).length === 0);
  check('Bella: sem produtos', (await store.listProducts()).length === 0);
  check('Bella: sem vendas', (await store.listClosedBills()).length === 0);
  check('Bella: sem pedidos abertos', (await store.listOpenOrders()).length === 0);
  check('Bella: ajustes no padrão', (await store.getSettings()).service_fee_pct === 3);
  check('Bella: comissão padrão 8%', (await store.getSettings()).default_commission_pct === 8);
  check('Bella: primeiro Pedido Nº é 1 (sequencial próprio)', (await store.nextOrderNumber()) === 1);

  // Login duplicado na plataforma toda: nem garçom nem dono nem
  // cadastro novo podem reutilizar um login que já existe.
  await throwsAsync(
    () => store.createWaiter('Outro Carlos', 'carlos', h),
    'garçom com login de outro restaurante é rejeitado',
  );
  await throwsAsync(
    () => store.createOwner('Falsa', 'dono-luis', h),
    'dono com login de outro restaurante é rejeitado',
  );
  await throwsAsync(
    () => store.registerRestaurant({
      restaurantName: 'Terceiro',
      ownerName: 'X',
      login: 'ana',
      passwordHash: h,
    }),
    'cadastro com login de garçom de outro restaurante é rejeitado',
  );

  // Vida própria na Bella: garçom, produto e uma venda de R$ 50.
  const bruno = await store.createWaiter('Bruno', 'bruno', h);
  check('garçom da Bella criado', bruno.restaurant_id === bellaId);
  const pratoBella = await store.createProduct({
    name: 'Prato Bella',
    price_cents: 5000,
    category: 'Almoço',
    prints_in: 'kitchen',
  });
  await store.saveSettings({ service_fee_pct: 0, table_count: 12, default_commission_pct: 8 });
  const orderB = await store.createOrder(2, bruno);
  await store.addItem(orderB.id, pratoBella);
  const billB = await store.closeOrder(orderB.id, 0);
  check('Bella: venda de R$ 50,00', billB.total_cents === 5000);
  check('Bella: 1 conta fechada', (await store.listClosedBills()).length === 1);

  // Volta pro Gosto Caseiro: tudo dele intacto, nada da Bella misturado.
  store.setActiveRestaurant(gostoId);
  check('voltou pro Gosto Caseiro', (await store.getActiveRestaurant())?.id === gostoId);
  check('Gosto: taxa continua 3%', (await store.getSettings()).service_fee_pct === 3);
  check('Gosto: 2 garçons (Carlos e Ana)', (await store.listWaiters()).length === 2);
  check(
    'Gosto: garçom da Bella não aparece',
    (await store.listWaiters()).find((w) => w.login === 'bruno') === undefined,
  );
  check(
    'Gosto: produto da Bella não aparece',
    (await store.listProducts()).find((p) => p.name === 'Prato Bella') === undefined,
  );
  check(
    'Gosto: produto dele continua lá',
    (await store.listProducts()).find((p) => p.name === 'Filé R$ 200') !== undefined,
  );
  check('Gosto: 4 contas fechadas (só as dele)', (await store.listClosedBills()).length === 4);
  check(
    'Gosto: venda da Bella não aparece',
    (await store.listClosedBills()).find((b) => b.id === billB.id) === undefined,
  );
  check(
    'Gosto: próximo Pedido Nº é 3 (sequencial dele, não o da Bella)',
    (await store.nextOrderNumber()) === 3,
  );

  // Finalizar o dia na Bella não fecha o dia no Gosto Caseiro.
  store.setActiveRestaurant(bellaId);
  await store.finalizeDay();
  check('Bella: dia fechado', store.isDayClosed(await store.getSettings()) === true);
  store.setActiveRestaurant(gostoId);
  check('Gosto: dia continua aberto', store.isDayClosed(await store.getSettings()) === false);
  store.setActiveRestaurant(bellaId);
  await store.reopenDay();
  check('Bella: dia reaberto', store.isDayClosed(await store.getSettings()) === false);
  store.setActiveRestaurant(gostoId);
}

/* ------------------------------------------------------------------ */
/* 11 · Migração local: banco antigo vira Gosto Caseiro sem perder nada */
/* ------------------------------------------------------------------ */
section('11 · Migração do Gosto Caseiro');
{
  // Guarda o banco atual e simula um banco local ANTIGO (formato de
  // antes do multi-restaurante: sem restaurants, dono único, settings
  // única, order_seq solto).
  const snap = new Map(mem);
  const snapActive = store.getActiveRestaurantId();
  store.setActiveRestaurant(null);
  const legacyHash = await store.hashPassword('senha-legado');
  const legacy = {
    owner: {
      id: 'legacy-owner-1',
      name: 'Luis',
      login: 'dono-legado',
      password_hash: legacyHash,
      created_at: '2026-11-01T00:00:00.000Z',
    },
    waiters: [
      {
        id: 'legacy-waiter-1',
        name: 'Legado',
        login: 'legado',
        password_hash: 'x',
        commission_pct: 8,
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    products: [
      {
        id: 'legacy-prod-1',
        name: 'Prato legado',
        price_cents: 2500,
        category: 'Almoço',
        prints_in: 'kitchen',
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    settings: {
      service_fee_pct: 4,
      table_count: 10,
      order_seq: 0,
      default_commission_pct: 8,
      day_closed_date: null,
    },
    order_seq: 7,
    orders: [
      {
        id: 'legacy-order-1',
        table_number: 3,
        waiter_id: 'legacy-waiter-1',
        waiter_name: 'Legado',
        status: 'closed',
        created_at: '2026-11-01T00:00:00.000Z',
        closed_at: '2026-11-01T01:00:00.000Z',
      },
    ],
    items: [
      {
        id: 'legacy-item-1',
        order_id: 'legacy-order-1',
        product_id: 'legacy-prod-1',
        product_name: 'Prato legado',
        price_cents: 2500,
        qty: 2,
        note: '',
        sent: true,
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    bills: [
      {
        id: 'legacy-bill-1',
        order_id: 'legacy-order-1',
        table_number: 3,
        waiter_id: 'legacy-waiter-1',
        waiter_name: 'Legado',
        subtotal_cents: 5000,
        fee_cents: 200,
        total_cents: 5200,
        commission_cents: 416,
        commission_pct: 8,
        closed_at: '2026-11-01T01:00:00.000Z',
      },
    ],
  };
  mem.set('garcom_db_v1', JSON.stringify(legacy));

  // A primeira leitura dispara a migração.
  const migrated = await store.listRestaurants();
  check('migração: 1 restaurante criado', migrated.length === 1);
  check('migração: restaurante é o Gosto Caseiro', migrated[0].name === 'Gosto Caseiro');
  check(
    'migração: restaurante ativo é o Gosto Caseiro',
    (await store.getActiveRestaurant())?.name === 'Gosto Caseiro',
  );
  check(
    'migração: dono antigo preservado',
    (await store.getOwner())?.login === 'dono-legado',
  );
  check(
    'migração: garçom antigo preservado',
    (await store.listWaiters()).find((w) => w.login === 'legado') !== undefined,
  );
  check(
    'migração: produto antigo preservado',
    (await store.listProducts()).find((p) => p.name === 'Prato legado') !== undefined,
  );
  check('migração: venda antiga preservada', (await store.listClosedBills()).length === 1);
  check(
    'migração: valor da venda antiga (R$ 52,00)',
    (await store.listClosedBills())[0].total_cents === 5200,
  );
  check('migração: taxa antiga preservada (4%)', (await store.getSettings()).service_fee_pct === 4);
  check('migração: nº de mesas antigo (10)', (await store.getSettings()).table_count === 10);
  check(
    'migração: sequencial preservado (próximo Pedido Nº é 8)',
    (await store.nextOrderNumber()) === 8,
  );
  check(
    'migração: idempotente (segunda leitura não duplica)',
    (await store.listRestaurants()).length === 1,
  );

  // Restaura o banco de verdade e o restaurante ativo.
  mem.clear();
  for (const [k, v] of snap) mem.set(k, v);
  store.setActiveRestaurant(snapActive);
  check(
    'restauração: voltou pro Gosto Caseiro de verdade',
    (await store.getActiveRestaurant())?.id === gostoId,
  );
  check(
    'restauração: 2 garçons de verdade (Carlos e Ana)',
    (await store.listWaiters()).length === 2,
  );
}

/* ------------------------------------------------------------------ */
/* 12 · Administrador da plataforma: criação, login e lista sem financeiro */
/* ------------------------------------------------------------------ */
section('12 · Administrador da plataforma');
{
  check('sem admin no início', (await store.getPlatformAdmin()) === null);
  const hash = await store.hashPassword('senha-admin-123');
  const admin = await store.createPlatformAdmin('luis-admin', hash);
  check('admin criado com login', admin.login === 'luis-admin');
  check(
    'hash da senha confere (login do admin)',
    (await store.hashPassword('senha-admin-123')) === admin.password_hash,
  );
  check(
    'senha errada não confere',
    (await store.hashPassword('outra-senha')) !== admin.password_hash,
  );
  check(
    'findPlatformAdminByLogin acha o admin',
    (await store.findPlatformAdminByLogin('luis-admin'))?.id === admin.id,
  );
  check(
    'getPlatformAdmin retorna o admin',
    (await store.getPlatformAdmin())?.id === admin.id,
  );
  await throwsAsync(
    () => store.createPlatformAdmin('outro-admin', hash),
    'segundo admin é rejeitado',
  );
  await throwsAsync(
    () => store.createPlatformAdmin('carlos', hash),
    'admin com login de garçom é rejeitado',
  );
  await throwsAsync(
    () => store.registerRestaurant({
      restaurantName: 'Terceiro',
      ownerName: 'X',
      login: 'luis-admin',
      passwordHash: hash,
    }),
    'cadastro com login do admin é rejeitado',
  );
  // O admin é SEPARADO: o login dele não é login de dono nem de garçom.
  check(
    'login do admin não é login de dono',
    (await store.findOwnerByLogin('luis-admin')) === null,
  );
  check(
    'login do admin não é login de garçom',
    (await store.findWaiterByLogin('luis-admin')) === null,
  );
  check(
    'login de dono não é login de admin',
    (await store.findPlatformAdminByLogin('dono-luis')) === null,
  );
  check(
    'login de garçom não é login de admin',
    (await store.findPlatformAdminByLogin('carlos')) === null,
  );

  // A lista do admin: SÓ cadastro — nome, dono, data e nº de garçons.
  // NENHUM dado financeiro: sem total vendido, sem valores, sem comissão.
  const summaries = await store.listRestaurantSummaries();
  check('lista do admin: 2 restaurantes', summaries.length === 2);
  const gc = summaries.find((s) => s.restaurant.name === 'Gosto Caseiro');
  const bella = summaries.find((s) => s.restaurant.name === 'Cantina Bella');
  check('lista: Gosto Caseiro presente', gc !== undefined);
  check('lista: dono do Gosto é o Luis', gc?.ownerName === 'Luis');
  check('lista: Gosto tem 2 garçons', gc?.waiterCount === 2);
  check('lista: data de cadastro do Gosto', typeof gc?.restaurant.created_at === 'string' && gc.restaurant.created_at.length > 0);
  check('lista: Cantina Bella presente', bella !== undefined);
  check('lista: dona da Bella é a Bela', bella?.ownerName === 'Bela');
  check('lista: Bella tem 1 garçom', bella?.waiterCount === 1);
  check(
    'lista: resumo NÃO tem total vendido nem nenhum campo financeiro',
    gc !== undefined &&
      !('totalSoldCents' in gc) &&
      !('total_cents' in gc) &&
      !('sold' in gc) &&
      !('commission' in gc) &&
      !('totalVendido' in gc),
  );
  check(
    'lista: resumo tem SÓ restaurante, dono e nº de garçons',
    gc !== undefined &&
      JSON.stringify(Object.keys(gc).sort()) ===
        JSON.stringify(['ownerName', 'restaurant', 'waiterCount']),
  );
}

/* ------------------------------------------------------------------ */
/* 13 · Checagens estáticas: admin e multi-restaurante no fonte        */
/* ------------------------------------------------------------------ */
section('13 · Fonte: admin e multi-restaurante');
{
  const has = (src, s, name) => check(name, src.includes(s));
  const notHas = (src, s, name) => check(name, !src.includes(s));
  has(pageSrc, 'Área do administrador', 'login tem link "Área do administrador"');
  has(pageSrc, 'AdminAuthView', 'componente de acesso do admin');
  has(pageSrc, 'PlatformAdminView', 'componente da lista do admin');
  has(pageSrc, 'handleAdminLogin', 'login do admin');
  has(pageSrc, 'handleAdminCreate', 'primeiro acesso do admin');
  has(pageSrc, 'PLATFORM_ADMIN_SESSION_KEY', 'sessão do admin separada');
  has(pageSrc, "view === 'admin' && adminSession", 'área do admin só abre com sessão de admin');
  has(pageSrc, 'Restaurantes cadastrados na plataforma', 'lista do admin: título');
  has(pageSrc, 'garçons', 'lista do admin: nº de garçons');
  has(pageSrc, 'Cadastrado em', 'lista do admin: data do cadastro');
  notHas(pageSrc, 'totalSoldCents', 'admin: sem total vendido em lugar nenhum da tela');
  notHas(pageSrc, 'handleOwnerCreate', 'tela: primeiro acesso do dono antigo removido');
  notHas(pageSrc, 'RESTAURANT_NAME', 'tela: nome fixo do restaurante removido');
  has(storeSrc, 'createPlatformAdmin', 'store: createPlatformAdmin');
  has(storeSrc, 'findPlatformAdminByLogin', 'store: findPlatformAdminByLogin');
  has(storeSrc, 'getPlatformAdmin', 'store: getPlatformAdmin');
  has(storeSrc, 'listRestaurantSummaries', 'store: listRestaurantSummaries');
  has(storeSrc, 'PLATFORM_ADMIN_SESSION_KEY', 'store: chave da sessão do admin');
  has(sqlSrc, 'create table if not exists public.platform_admins', 'SQL: tabela platform_admins');
  has(sqlSrc, 'admin_all_platform_admins', 'SQL: policy RLS platform_admins');
  has(sqlSrc, 'garcom_all_restaurants', 'SQL: policy RLS restaurants');

  // A lista do admin NÃO tem financeiro: o componente só mostra nome,
  // dono, data e nº de garçons — nenhum valor, venda ou comissão.
  const adminStart = pageSrc.indexOf('function PlatformAdminView');
  const adminEnd = pageSrc.indexOf('type OwnerTab');
  const adminSrc = pageSrc.slice(adminStart, adminEnd);
  for (const s of ['total_cents', 'Total vendido', 'Comissão', 'commission', 'brl(']) {
    check('lista do admin não mostra "' + s + '"', !adminSrc.includes(s));
  }
  check('lista do admin mostra o nome do restaurante', adminSrc.includes('s.restaurant.name'));
  check('lista do admin mostra o dono', adminSrc.includes('s.ownerName'));
  check('lista do admin mostra a data', adminSrc.includes('Cadastrado em'));
  check('lista do admin mostra os garçons', adminSrc.includes('s.waiterCount'));

  // O link do admin só existe na tela de login: nem o garçom (mesas)
  // nem o dono (área dele) veem o link.
  const loginStart = pageSrc.indexOf("if (view === 'login')");
  const loginEnd = pageSrc.indexOf("if (view === 'admin' && adminSession)");
  const loginSrc = pageSrc.slice(loginStart, loginEnd);
  check('link do admin está na tela de login', loginSrc.includes('Área do administrador'));
  const tablesStart = pageSrc.indexOf("if (view === 'tables')");
  const tablesEnd = pageSrc.indexOf('/* ------------------------------ PEDIR ------------------------------ */');
  check(
    'garçom (mesas) não vê o link do admin',
    !pageSrc.slice(tablesStart, tablesEnd).includes('Área do administrador'),
  );
  const ownerStart = pageSrc.indexOf("if (view === 'owner' && ownerSession)");
  const ownerEnd = pageSrc.indexOf('if (!session)');
  check(
    'dono (área dele) não vê o link do admin',
    !pageSrc.slice(ownerStart, ownerEnd).includes('Área do administrador'),
  );
}

/* ------------------------------------------------------------------ */
/* 14 · Build + HTTP                                                   */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 15 · Login unificado + QR Code dos garçons                         */
/* ------------------------------------------------------------------ */
section('15 · Login unificado + QR Code');
{
  // Login único do formulário principal (garçom 'carlos', senha '1234';
  // dono 'dono-luis', senha 'senha-dono-123' — criados nas seções 1 e 3).
  const asWaiter = await store.authenticate('carlos', '1234');
  check(
    "login de garçom no formulário principal acha o garçom",
    asWaiter !== null && asWaiter.kind === 'waiter' && asWaiter.user.login === 'carlos',
  );
  check(
    'login de garçom com senha errada não entra',
    (await store.authenticate('carlos', 'errada')) === null,
  );
  const asOwner = await store.authenticate('dono-luis', 'senha-dono-123');
  check(
    'login de dono no formulário principal acha o dono',
    asOwner !== null && asOwner.kind === 'owner' && asOwner.user.login === 'dono-luis',
  );
  check(
    'login de dono com senha errada não entra',
    (await store.authenticate('dono-luis', 'errada')) === null,
  );
  check(
    'login inexistente não entra',
    (await store.authenticate('ninguem', '1234')) === null,
  );
  // Endereço do QR Code dos garçons (?tela=garcom).
  check(
    'URL do QR abre a tela do garçom',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app') ===
      'https://cardapio-digital-do-futuro.vercel.app/?tela=garcom',
  );
  check(
    'URL do QR ignora barra no fim da base',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app/') ===
      'https://cardapio-digital-do-futuro.vercel.app/?tela=garcom',
  );
  // Fonte da página: login principal usa o authenticate e entra na
  // área do dono quando o login é de dono.
  check(
    'handleLogin usa store.authenticate',
    pageSrc.includes('store.authenticate('),
  );
  check(
    'login de dono no formulário principal entra na área do dono',
    pageSrc.includes('enterOwnerArea(result.user)'),
  );
  // Fonte da página: o parâmetro ?tela=garcom esconde os links de
  // dono, cadastro e administrador (só login e senha do garçom).
  check(
    'parâmetro do garçom lido (?tela=garcom)',
    pageSrc.includes("'tela') === 'garcom'"),
  );
  check(
    'links de dono/cadastro/admin escondidos na tela do garçom',
    pageSrc.includes('!waiterOnly'),
  );
  check(
    'boot do QR pula a apresentação e vai pro login',
    pageSrc.includes("onlyWaiter ? 'login' : 'home'"),
  );
  // Fonte da página: seção "QR Code dos garçons" na área do dono.
  check(
    'rota do QR na área do dono (owner-qr)',
    pageSrc.includes("'owner-qr'"),
  );
  check(
    'seção "QR Code dos garçons" existe',
    pageSrc.includes('QR Code dos garçons'),
  );
  check(
    'QR gerado no próprio app (toDataURL)',
    pageSrc.includes('toDataURL'),
  );
  check(
    'QR usa o endereço do sistema (waiterLoginUrl)',
    pageSrc.includes('store.waiterLoginUrl('),
  );
  check('CSS do QR (.qr-img)', cssSrc.includes('.qr-img'));
}

/* ------------------------------------------------------------------ */
/* 16 · Apresentação como primeira tela (junção com o site)           */
/* ------------------------------------------------------------------ */
section('16 · Apresentação (primeira tela)');
{
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  check('componente da apresentação existe (HomeView)', homeSrc.length > 0);
  check(
    'apresentação é a primeira tela sem sessão',
    pageSrc.includes("onlyWaiter ? 'login' : 'home'"),
  );
  check(
    'apresentação explica como funciona',
    homeSrc.includes('Como funciona'),
  );
  check('plano mensal R$ 69,99', homeSrc.includes('R$ 69,99'));
  check('plano anual R$ 499,99', homeSrc.includes('R$ 499,99'));
  check('3 dias grátis no plano', homeSrc.includes('3 dias grátis'));
  check(
    'suporte 24 horas nos dois planos',
    homeSrc.includes('Suporte 24 horas'),
  );
  check(
    'botão flutuante de WhatsApp (5519971995144)',
    homeSrc.includes('wa.me/5519971995144'),
  );
  check(
    'botão "Cadastrar meu restaurante" abre o cadastro in-app',
    homeSrc.includes('Cadastrar meu restaurante') &&
      homeSrc.includes('onClick={onRegister}'),
  );
  check(
    'sem botão grande "Entrar" na apresentação — só o link discreto no rodapé',
    !homeSrc.includes('>Entrar<') &&
      homeSrc.includes('Já tem uma conta? Entrar'),
  );
  check(
    'link discreto do rodapé leva ao login',
    homeSrc.includes('onClick={onLogin}'),
  );
  check(
    'cadastro abre dentro do sistema (sem abrir outro site)',
    pageSrc.includes("onRegister={() => setView('register')}"),
  );
  check('CSS dos planos (.plan-card)', cssSrc.includes('.plan-card'));
  check(
    'CSS do botão flutuante (.wa-float)',
    cssSrc.includes('.wa-float'),
  );
}

section('17 · Botão flutuante não cobre os planos');
{
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  check(
    'espaço no fim da apresentação (.content.home com padding inferior)',
    cssSrc.includes('.content.home') &&
      cssSrc.includes('padding-bottom: 96px'),
  );
  check(
    'botão flutuante menor (48px, não 56px)',
    /\.wa-float\s*\{[^}]*width:\s*48px/.test(cssSrc),
  );
  check(
    'estado escondido do botão (.wa-float.wa-hidden com opacity 0)',
    cssSrc.includes('.wa-float.wa-hidden') &&
      cssSrc.includes('opacity: 0'),
  );
  check(
    'grade de planos tem ref pra medir a posição',
    homeSrc.includes('ref={plansRef}'),
  );
  check(
    'botão some enquanto os planos estão na faixa dele',
    homeSrc.includes("hideWa ? 'wa-float wa-hidden' : 'wa-float'") &&
      homeSrc.includes('getBoundingClientRect') &&
      homeSrc.includes('innerHeight - 76'),
  );
  check(
    'posição do botão é reavaliada ao rolar e ao redimensionar',
    homeSrc.includes("addEventListener('scroll'") &&
      homeSrc.includes("addEventListener('resize'"),
  );
}

/* ------------------------------------------------------------------ */
/* 18 · Cadastro → tela de sucesso → login do dono pré-preenchido     */
/* ------------------------------------------------------------------ */
section('18 · Cadastro realizado com sucesso');
{
  // Funcional (modo local): o cadastro cria o restaurante + o dono, e
  // o login criado no cadastro funciona no login (é o que a tela de
  // sucesso pré-preenche). O cadastro em si NÃO loga ninguém.
  const hashTeste = await store.hashPassword('senha-teste-123');
  const { restaurant: rTeste, owner: oTeste } =
    await store.registerRestaurant({
      restaurantName: 'Teste Sucesso',
      ownerName: 'Dono Teste',
      login: 'dono-teste',
      passwordHash: hashTeste,
    });
  check('restaurante novo criado', rTeste.name === 'Teste Sucesso');
  check(
    'restaurante novo é outro (não é o Gosto Caseiro)',
    rTeste.id !== gostoId,
  );
  check(
    'dono do restaurante novo acha pelo login',
    (await store.findOwnerByLogin('dono-teste'))?.id === oTeste.id,
  );
  const authTeste = await store.authenticate('dono-teste', 'senha-teste-123');
  check(
    'login criado no cadastro entra como dono',
    authTeste !== null &&
      authTeste.kind === 'owner' &&
      authTeste.user.login === 'dono-teste',
  );
  check(
    'login criado no cadastro com senha errada não entra',
    (await store.authenticate('dono-teste', 'errada')) === null,
  );

  // Fonte da página: o cadastro vai pra tela de sucesso, sem entrar
  // direto na área do dono (sem sessão, sem ir pro setup).
  const regStart = pageSrc.indexOf('async function handleRestaurantRegister');
  const regFn = pageSrc.slice(
    regStart,
    pageSrc.indexOf('async function handleAdminLogin', regStart),
  );
  check(
    "cadastro vai pra tela de sucesso (setView('register-success'))",
    regFn.includes("setView('register-success')"),
  );
  check(
    'cadastro NÃO entra direto na área do dono (sem sessão)',
    !regFn.includes('setOwnerSession') &&
      !regFn.includes('safeSet(OWNER_SESSION_KEY'),
  );
  check(
    "cadastro NÃO vai direto pro setup (só depois do login)",
    !regFn.includes("setView('setup')"),
  );
  check(
    'cadastro guarda o login pra pré-preencher',
    regFn.includes('setRegisteredLogin('),
  );
  check(
    "tela 'register-success' existe no tipo View",
    pageSrc.includes("'register-success'"),
  );
  check(
    'tela de sucesso com o texto "Cadastro realizado com sucesso"',
    pageSrc.includes('Cadastro realizado com sucesso'),
  );
  // Fonte da página: a tela de sucesso tem o botão que abre a tela de
  // login do dono (com o login já preenchido).
  const successView = pageSrc.slice(
    pageSrc.indexOf("view === 'register-success'"),
    pageSrc.indexOf('/* ------------------------------ LOGIN'),
  );
  check(
    'tela de sucesso tem o botão "Entrar no financeiro"',
    successView.includes('Entrar no financeiro'),
  );
  check(
    'botão abre a tela de login do dono',
    successView.includes('setOwnerAuth(true)') &&
      successView.includes("setView('login')"),
  );
  check(
    'tela de login do dono aceita login pré-preenchido (initialLogin)',
    pageSrc.includes('initialLogin?: string') &&
      pageSrc.includes('useState(initialLogin)'),
  );
  check(
    'login do dono recebe o login criado no cadastro',
    pageSrc.includes('initialLogin={registeredLogin}'),
  );
  check(
    'primeiro acesso (setup) continua só depois do login do dono',
    pageSrc.includes("setView(ws.length === 0 ? 'setup' : 'owner')"),
  );
}

/* ------------------------------------------------------------------ */
/* 19 · Apresentação rica: vias, financeiro e calculadora             */
/* ------------------------------------------------------------------ */
section('19 · Apresentação rica: vias, financeiro e calculadora');
{
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  // Vias em formato de cupom térmico (reutilizam .ticket).
  check(
    'via da cozinha em cupom térmico',
    homeSrc.includes('COZINHA') && homeSrc.includes('className="ticket"'),
  );
  check(
    'via do bar com o jeito de servir a bebida',
    homeSrc.includes('BAR') && homeSrc.includes('copo com limão e gelo'),
  );
  check(
    'via do balcão (CONTA) com valores e total',
    homeSrc.includes('CONTA') && homeSrc.includes('R$ 39,03'),
  );
  check(
    'via da cozinha e do bar sem valores (aviso)',
    homeSrc.includes('sem valores'),
  );
  check(
    'conta do exemplo confere: 28,90 + 8,99 = 37,89, taxa 1,14',
    homeSrc.includes('R$ 37,89') && homeSrc.includes('R$ 1,14'),
  );
  // Financeiro do dono.
  check(
    'seção do financeiro do dono',
    homeSrc.includes('O financeiro do dono'),
  );
  check(
    'financeiro: comissão calculada sozinha',
    homeSrc.includes('Comissão calculada sozinha'),
  );
  check(
    'financeiro: finalizar o dia e reabrir às 9h',
    homeSrc.includes('finalizar o dia') && homeSrc.includes('9h'),
  );
  // Calculadora de comissão — exemplo do Luis: R$ 200,00 a 8% =
  // R$ 16,00 do garçom, R$ 184,00 pro restaurante.
  check(
    'calculadora de comissão existe',
    homeSrc.includes('Calculadora de comissão'),
  );
  check(
    'calculadora começa com R$ 200 e 8% (exemplo)',
    homeSrc.includes("useState('200')") &&
      homeSrc.includes("useState('8')"),
  );
  check(
    'calculadora mostra quanto é do garçom',
    homeSrc.includes('Do garçom:'),
  );
  check(
    'calculadora mostra quanto fica pro restaurante',
    homeSrc.includes('Fica pro restaurante:'),
  );
  const venda = 20000;
  const pct = 8;
  const comissao = Math.round((venda * pct) / 100);
  check(
    'exemplo: R$ 200,00 a 8% = R$ 16,00 do garçom',
    comissao === 1600,
  );
  check(
    'exemplo: R$ 200,00 a 8% = R$ 184,00 pro restaurante',
    venda - comissao === 18400,
  );
  check('CSS das vias (.home-tickets)', cssSrc.includes('.home-tickets'));
  check('CSS da calculadora (.calc-card)', cssSrc.includes('.calc-card'));
}

section('20 · Landing escura igual à da versão de teste');
{
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  // Hero escuro com o título grande em duas cores.
  check(
    'landing usa o wrapper escuro (app landing)',
    homeSrc.includes('className="app landing"'),
  );
  check(
    'título do hero: "O pedido sai da mesa direto pra cozinha."',
    homeSrc.includes('O pedido sai da mesa direto pra cozinha.'),
  );
  check(
    'título do hero: "E a venda, direto pro seu financeiro."',
    homeSrc.includes('E a venda, direto pro seu financeiro.'),
  );
  check(
    'segunda frase do título em laranja (landing-accent)',
    homeSrc.includes('landing-accent'),
  );
  check(
    'subtítulo da landing',
    homeSrc.includes('Sistema completo para restaurantes:'),
  );
  check(
    'cabeçalho "Sistema de Restaurante" com botão de cadastro',
    homeSrc.includes('Sistema de Restaurante') &&
      homeSrc.includes('landing-header'),
  );
  check(
    'botão "Ver como funciona" rola até a seção',
    homeSrc.includes('Ver como funciona') &&
      homeSrc.includes("getElementById('como-funciona')"),
  );
  check(
    'seção "Como funciona" tem o id do botão',
    homeSrc.includes('id="como-funciona"'),
  );
  check(
    'maquete de celular da tela de Mesas no hero',
    homeSrc.includes('landing-phone') &&
      homeSrc.includes('landing-phone-grid'),
  );
  // A landing sempre abre rolada pro topo.
  check(
    'landing rola pro topo ao carregar (scrollTo 0, 0)',
    homeSrc.includes('window.scrollTo(0, 0)'),
  );
  check(
    'restauração de scroll do navegador desligada na landing',
    homeSrc.includes("history.scrollRestoration = 'manual'"),
  );
  // WhatsApp não cobre o cupom térmico nem os planos.
  check(
    'WhatsApp se esconde também nas vias (ticketsRef)',
    homeSrc.includes('ticketsRef') &&
      homeSrc.includes('ref={ticketsRef}'),
  );
  check(
    'esconder o WhatsApp olha vias E planos',
    homeSrc.includes('inBand(plansRef.current)') &&
      homeSrc.includes('inBand(ticketsRef.current)'),
  );
  // Botão de cadastro no fim da apresentação (depois da última seção).
  check(
    'três botões "Cadastrar meu restaurante": cabeçalho, hero e fim',
    (homeSrc.match(/onClick={onRegister}/g) || []).length === 3,
  );
  check(
    'botão final fica depois das Dúvidas frequentes (fim da página)',
    homeSrc.indexOf('Dúvidas frequentes') <
      homeSrc.lastIndexOf('Cadastrar meu restaurante'),
  );
  check(
    'chamada final com os 3 dias grátis antes do botão do fim',
    homeSrc.includes('landing-final') &&
      homeSrc.includes('Pronto pra começar?'),
  );
  check('CSS da chamada final (.landing-final)', cssSrc.includes('.landing-final'));
  // Fluxo preservado: só o botão de cadastro; entrar é link discreto.
  check(
    'link discreto "Já tem uma conta? Entrar" no rodapé',
    homeSrc.includes('Já tem uma conta? Entrar'),
  );
  // CSS escuro.
  check('CSS: fundo escuro #17110c', cssSrc.includes('#17110c'));
  check('CSS: laranja #f26a3d', cssSrc.includes('#f26a3d'));
  check('CSS do hero escuro (.landing-hero)', cssSrc.includes('.landing-hero'));
  check(
    'CSS: respiro no fim das vias (.landing .home-tickets)',
    cssSrc.includes('.landing .home-tickets'),
  );
  check(
    'CSS do botão outline "Ver como funciona" (.landing-outline)',
    cssSrc.includes('.landing-outline'),
  );
}

section('14 · Build + HTTP');
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
  // O endereço do QR Code dos garçons (?tela=garcom) também serve.
  let qrStatus = 0;
  try {
    const resQr = await fetch('http://localhost:3100/?tela=garcom');
    qrStatus = resQr.status;
  } catch {
    qrStatus = 0;
  }
  check('endereço do QR (?tela=garcom) responde HTTP 200', qrStatus === 200);
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
