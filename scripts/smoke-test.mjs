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
const admSrc = readFileSync(path.join(ROOT, 'src/app/adm/page.tsx'), 'utf8');
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
  has(pageSrc, 'Acesso do dono', 'tela "Acesso do dono"');
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
  has(pageSrc, 'Comissão dele (%)', 'garçom tem % de comissão');
  has(pageSrc, 'Salvar alterações', 'edição de garçom/produto');
  has(pageSrc, 'Comissão padrão dos garçons (%)', 'ajuste de comissão padrão');
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
  has(pageSrc, 'Como a bebida vai ser servida?', 'fluxo do garçom: como servir intacto');
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
  has(pageSrc, 'Total a pagar aos garçons', 'confirmação: total a pagar');
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
    'Total a pagar aos garçons',
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
  has(pageSrc, 'AdminAuthView', 'componente de acesso do admin');
  has(pageSrc, 'PlatformAdminView', 'componente da lista do admin');
  has(pageSrc, 'handleAdminLogin', 'login do admin');
  has(pageSrc, 'handleAdminCreate', 'primeiro acesso do admin');
  has(pageSrc, 'PLATFORM_ADMIN_SESSION_KEY', 'sessão do admin separada');
  has(pageSrc, "view === 'admin' && adminSession", 'área do admin só abre com sessão de admin');
  has(pageSrc, 'isAdminPath', 'entrada escondida /adm detectada no boot');
  has(pageSrc, "p === '/adm'", 'caminho /adm reconhecido');
  has(admSrc, "import Page from '../page'", 'rota /adm renderiza o mesmo app');
  has(admSrc, 'export default function AdminPage', 'rota /adm existe');
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

  // A área do admin NÃO tem entrada visível: o link saiu da tela de
  // login — só quem conhece o endereço /adm chega lá.
  const loginStart = pageSrc.indexOf("if (view === 'login')");
  const loginEnd = pageSrc.indexOf("if (view === 'admin' && adminSession)");
  const loginSrc = pageSrc.slice(loginStart, loginEnd);
  check(
    'sem link visível do admin na tela de login',
    !loginSrc.includes('Área do administrador'),
  );
  check(
    'sem botão de admin na tela de login',
    !loginSrc.includes('admin-link'),
  );
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
  // Endereço do QR Code dos garçons (?acesso=garcom, igual ao artefato;
  // ?tela=garcom continua aceito pros links antigos).
  check(
    'URL do QR abre a tela do garçom (?acesso=garcom)',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app') ===
      'https://cardapio-digital-do-futuro.vercel.app/?acesso=garcom',
  );
  check(
    'URL do QR ignora barra no fim da base',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app/') ===
      'https://cardapio-digital-do-futuro.vercel.app/?acesso=garcom',
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
  // Fonte da página: o parâmetro do garçom aceita os dois (?acesso e
  // ?tela) e esconde os links de dono, cadastro e administrador (só
  // login e senha do garçom).
  check(
    'parâmetro do garçom lido (?acesso=garcom)',
    pageSrc.includes("'acesso') === 'garcom'"),
  );
  check(
    'parâmetro antigo do garçom ainda aceito (?tela=garcom)',
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
  // Fonte da página: seção "QR Code dos garçons" dentro da aba
  // Garçons do dono (antes da lista), em SVG 208px.
  check(
    'QR dentro da aba Garçons do dono (OwnerWaitersView)',
    pageSrc.slice(
      pageSrc.indexOf('function OwnerWaitersView'),
      pageSrc.indexOf('/* ------------------- DONO: CARDÁPIO'),
    ).includes('QR Code dos garçons'),
  );
  check(
    'seção "QR Code dos garçons" existe',
    pageSrc.includes('QR Code dos garçons'),
  );
  check(
    'QR gerado no próprio app em SVG (toString)',
    pageSrc.includes("toString(qrUrl") &&
      pageSrc.includes("type: 'svg'"),
  );
  check(
    'QR usa o endereço do sistema (waiterLoginUrl)',
    pageSrc.includes('store.waiterLoginUrl('),
  );
  check('CSS do QR (.qr-svg)', cssSrc.includes('.qr-svg'));
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
      homeSrc.includes('onClick={() => onRegister('),
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
    pageSrc.includes('onRegister={(plan) => {') &&
      pageSrc.includes("setView('register')"),
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
    'tela de sucesso tem o botão "Entrar no meu financeiro"',
    successView.includes('Entrar no meu financeiro'),
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
    'login do dono cai direto no painel (sem tela de primeiro acesso)',
    !pageSrc.includes("setView(ws.length === 0 ? 'setup' : 'owner')") &&
      !pageSrc.includes("setView('setup')"),
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
    homeSrc.includes('CONTA') && homeSrc.includes('R$ 193,64'),
  );
  check(
    'via da cozinha e do bar sem valores (aviso)',
    homeSrc.includes('sem valores'),
  );
  check(
    'conta do exemplo confere: 89,00 + 81,00 + 18,00 = 188,00, taxa 5,64',
    homeSrc.includes('R$ 188,00') && homeSrc.includes('R$ 5,64'),
  );
  check(
    'cabeçalho do exemplo: Pedido 0042, Mesa 07, 20:14, Garçom Carlos',
    homeSrc.includes('0042') &&
      homeSrc.includes('Mesa: 07') &&
      homeSrc.includes('20:14') &&
      homeSrc.includes('Garçom: Carlos'),
  );
  // Financeiro do dono.
  check(
    'seção do painel do dono',
    homeSrc.includes('No painel do dono'),
  );
  check(
    'painel do dono: comissão automática',
    homeSrc.includes('Comissão automática'),
  );
  check(
    'financeiro: finalizar o dia e reabrir às 9h',
    homeSrc.includes('Finalizar o dia') && homeSrc.includes('9h'),
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
  // Botões de cadastro na apresentação: cabeçalho, hero, 2 planos e fim.
  // Os dos planos levam o plano escolhido; os genéricos vão sem plano.
  check(
    'cinco botões "Cadastrar meu restaurante": cabeçalho, hero, planos e fim',
    (homeSrc.match(/onClick=\{\(\) => onRegister\(/g) || []).length === 5,
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
  // O endereço do QR Code dos garçons (?acesso=garcom) também serve.
  let qrStatus = 0;
  try {
    const resQr = await fetch('http://localhost:3100/?acesso=garcom');
    qrStatus = resQr.status;
  } catch {
    qrStatus = 0;
  }
  check('endereço do QR (?acesso=garcom) responde HTTP 200', qrStatus === 200);
  // O parâmetro antigo (?tela=garcom) continua servindo.
  let qrStatusOld = 0;
  try {
    const resQrOld = await fetch('http://localhost:3100/?tela=garcom');
    qrStatusOld = resQrOld.status;
  } catch {
    qrStatusOld = 0;
  }
  check('endereço antigo do QR (?tela=garcom) responde HTTP 200', qrStatusOld === 200);
  server.kill('SIGTERM');
}

/* ------------------------------------------------------------------ */
/* 21 · Port da especificação do artefato (tela por tela)              */
/* ------------------------------------------------------------------ */
section('21 · Port do artefato');
{
  const has = (src, s, name) => check(name, src.includes(s));
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  const dashStart = pageSrc.indexOf('DONO: DASHBOARD FINANCEIRO');
  const dashEnd = pageSrc.indexOf('DONO: GARÇONS');
  const dashSrc = pageSrc.slice(dashStart, dashEnd);
  const waiterSrc = pageSrc.slice(0, dashStart);

  // Apresentação: menu, ordem das seções e maquete.
  has(homeSrc, 'Pro garçom', 'landing: menu "Pro garçom"');
  has(homeSrc, 'Pro dono', 'landing: menu "Pro dono"');
  has(homeSrc, 'landing-nav', 'landing: menu desktop (some no mobile)');
  has(homeSrc, 'Sem instalar nada', 'landing: checklist "Sem instalar nada"');
  has(homeSrc, 'Dados separados', 'landing: checklist "Dados separados"');
  has(homeSrc, 'Pedidos em andamento (3)', 'landing: maquete "Pedidos em andamento (3)"');
  has(homeSrc, 'Mesas livres (4)', 'landing: maquete "Mesas livres (4)"');
  has(homeSrc, 'lp-amber', 'landing: maquete com quadrado âmbar (mesa de outro)');
  check(
    'landing: Dúvidas frequentes vem ANTES de Planos na página',
    homeSrc.indexOf('Dúvidas frequentes') < homeSrc.indexOf('id="planos"'),
  );
  check(
    'landing: menu lista Planos antes de Dúvidas',
    homeSrc.indexOf('>Planos<') < homeSrc.indexOf('>Dúvidas<'),
  );
  check(
    'landing: 4 passos — cadastrar, equipe/cardápio, atender, financeiro',
    homeSrc.includes('Cadastre o restaurante') &&
      homeSrc.includes('Monte a equipe e o cardápio') &&
      homeSrc.includes('O garçom atende pelo celular') &&
      homeSrc.includes('A venda cai no financeiro'),
  );
  check(
    'landing: "No celular do garçom" com os 4 cartões',
    homeSrc.includes('No celular do garçom') &&
      homeSrc.includes('Grade de mesas') &&
      homeSrc.includes('Mesa de quem abriu') &&
      homeSrc.includes('Bebida do jeito do cliente'),
  );
  check(
    'landing: "No painel do dono" com os 4 cartões',
    homeSrc.includes('No painel do dono') &&
      homeSrc.includes('Vendas por garçom') &&
      homeSrc.includes('Finalizar o dia') &&
      homeSrc.includes('Preço e cardápio do dono'),
  );
  check(
    'landing: FAQ em sanfona fechada por padrão (6 perguntas)',
    homeSrc.includes('faq-item') &&
      homeSrc.includes('Preciso instalar algum aplicativo?') &&
      homeSrc.includes('Preciso de impressoras especiais?') &&
      homeSrc.includes("useState<number | null>(null)"),
  );
  check(
    'landing: planos com selo 3 dias grátis e sistema completo',
    homeSrc.includes('plan-badge') && homeSrc.includes('Sistema completo'),
  );
  check(
    'landing: cada plano tem botão "Cadastrar meu restaurante"',
    (homeSrc.match(/Cadastrar meu restaurante/g) || []).length >= 5,
  );
  check(
    'landing: CTA final "Cadastre seu restaurante"',
    homeSrc.includes('Cadastre seu restaurante</h2>'),
  );

  // Cadastro e sucesso.
  has(pageSrc, 'NOVO RESTAURANTE', 'cadastro: eyebrow "NOVO RESTAURANTE"');
  has(pageSrc, 'Seu nome (dono)', 'cadastro: campo "Seu nome (dono)"');
  has(pageSrc, 'Usuário (seu login de dono)', 'cadastro: campo "Usuário (seu login de dono)"');
  has(pageSrc, 'Cadastro realizado com sucesso!', 'sucesso: título com "!"');
  has(pageSrc, 'Entrar no meu financeiro', 'sucesso: botão "Entrar no meu financeiro"');
  has(pageSrc, 'O login já vai preenchido - é só digitar a sua senha.', 'sucesso: texto do login pré-preenchido');

  // Login unificado e do dono.
  has(pageSrc, 'Entrar no sistema', 'login: título "Entrar no sistema"');
  has(pageSrc, 'Acesso do garçom', 'login QR: título "Acesso do garçom"');
  has(pageSrc, 'o garçom cai direto nas mesas, e o dono, no painel do restaurante dele', 'login: subtítulo unificado');
  has(pageSrc, 'pra ver as mesas do seu restaurante', 'login QR: subtítulo do garçom');
  has(pageSrc, 'Entrando…', 'login: botão "Entrando…" enquanto carrega');
  has(pageSrc, 'Não foi possível entrar. Tente de novo.', 'login: erro genérico');
  has(pageSrc, 'O acesso do garçom é criado pelo dono do restaurante', 'login: nota de quem cria o acesso');
  has(pageSrc, 'área financeira dele', 'login: nota de quem cria o acesso (continuação)');
  has(pageSrc, 'Entre com seu usuário e senha pra abrir a área financeira do seu restaurante.', 'dono: texto de "Acesso do dono"');
  has(pageSrc, 'Criar acesso e entrar', 'dono: primeiro acesso "Criar acesso e entrar"');
  has(pageSrc, 'Seu nome', 'dono: primeiro acesso tem campo "Seu nome"');
  check(
    'login: coluna única máx. 428px (.content.auth)',
    cssSrc.includes('.content.auth') && cssSrc.includes('max-width: 428px'),
  );
  check(
    'cadastro: coluna máx. 448px (.content.auth-wide)',
    cssSrc.includes('.content.auth-wide') && cssSrc.includes('max-width: 448px'),
  );

  // Área do dono: cabeçalho, menu e dashboard.
  has(pageSrc, 'Menu do dono', 'dono: nav "Menu do dono"');
  has(pageSrc, "tab === 'dashboard'", 'dono: aba Início');
  has(pageSrc, '<h1>Financeiro</h1>', 'dono: cabeçalho "Financeiro"');
  check(
    'dono: sem aba separada de QR (QR vive na aba Garçons)',
    !pageSrc.includes("'owner-qr'") && !pageSrc.includes('OwnerQrView'),
  );
  check(
    'dono: abas são Início, Garçons, Cardápio e Ajustes (sem Dashboard/QR Code)',
    pageSrc.includes("tab === 'dashboard'") &&
      pageSrc.includes("tab === 'waiters'") &&
      pageSrc.includes("tab === 'menu'") &&
      pageSrc.includes("tab === 'settings'") &&
      pageSrc.includes('Início') &&
      pageSrc.includes('Garçons') &&
      pageSrc.includes('Cardápio') &&
      pageSrc.includes('Ajustes') &&
      !pageSrc.includes("'owner-qr'"),
  );
  check(
    'dono: container max-w-3xl (.app-owner 768px)',
    cssSrc.includes('.app-owner') && cssSrc.includes('max-width: 768px'),
  );
  has(dashSrc, 'conta', 'dashboard: total vendido com nº de contas');
  has(dashSrc, 'stat-card highlight', 'dashboard: "Fica pro restaurante" em destaque');
  has(dashSrc, 'Nenhuma conta fechada neste período.', 'dashboard: texto de vazio');
  has(dashSrc, 'a venda aparece aqui sozinha', 'dashboard: texto de vazio (continuação)');
  has(dashSrc, 'Comissão (', 'dashboard: "Comissão (8%): R$" por garçom');
  has(dashSrc, 'btn-dark', 'dashboard: "Finalizar dia" escuro (#2a1e33)');
  has(dashSrc, 'Dia encerrado', 'dashboard: cartão "Dia encerrado"');
  has(dashSrc, 'Total a pagar aos garçons', 'dashboard: modal "Total a pagar aos garçons"');
  check(
    'dashboard: modal com botão "Voltar"',
    dashSrc.includes('Voltar') && dashSrc.includes('Finalizar dia'),
  );

  // Garçons do dono.
  const waitersSrc = pageSrc.slice(
    pageSrc.indexOf('function OwnerWaitersView'),
    pageSrc.indexOf('/* ------------------- DONO: CARDÁPIO'),
  );
  has(waitersSrc, 'QR Code dos garçons', 'garçons: QR antes da lista');
  has(waitersSrc, 'Mostre este código pros seus garçons', 'garçons: texto do QR');
  has(waitersSrc, 'Novo garçom', 'garçons: botão "Novo garçom"');
  has(waitersSrc, 'Quem cadastra o garçom é você', 'garçons: texto de quem cadastra');
  has(waitersSrc, 'Nome do garçom', 'garçons: campo "Nome do garçom"');
  has(waitersSrc, 'Usuário (pra entrar)', 'garçons: campo "Usuário (pra entrar)"');
  has(waitersSrc, 'Comissão dele (%)', 'garçons: campo "Comissão dele (%)"');
  has(waitersSrc, 'vendeu R$ 200 com comissão de 8%', 'garçons: nota do exemplo R$ 200');
  has(waitersSrc, 'usuário: ', 'garçons: linha "usuário: X · comissão 8%"');
  has(waitersSrc, 'Remover o acesso de ', 'garçons: confirmação de remover');
  has(waitersSrc, 'Remover mesmo', 'garçons: botão "Remover mesmo"');
  has(waitersSrc, 'Editar ${', 'garçons: formulário "Editar <nome>"');

  // Cardápio do dono.
  const menuSrc = pageSrc.slice(
    pageSrc.indexOf('function OwnerMenuView'),
    pageSrc.indexOf('/* ------------------- DONO: AJUSTES'),
  );
  has(menuSrc, 'Cardápio (', 'cardápio: título "Cardápio (N)"');
  has(menuSrc, 'Novo produto', 'cardápio: botão "Novo produto"');
  has(menuSrc, 'Quem mexe no cardápio é você', 'cardápio: texto de quem mexe');
  has(pageSrc, 'O cardápio está vazio. Toque em Novo produto pra cadastrar o', 'cardápio: texto de vazio');
  has(pageSrc, 'primeiro.', 'cardápio: texto de vazio (continuação)');
  has(pageSrc, 'Categoria (botão na tela de pedido)', 'cardápio: campo Categoria');
  has(pageSrc, "category.trim() || 'Geral'", 'cardápio: categoria vazia vira Geral');
  has(pageSrc, 'Preço inválido. Use o formato 32,90.', 'cardápio: erro de preço');
  has(pageSrc, '300g de filé de tilápia', 'cardápio: exemplo "o que vem no prato"');
  has(pageSrc, 'maxLength={300}', 'cardápio: "o que vem" com máx. 300');
  has(pageSrc, 'Pausar', 'cardápio: botão "Pausar/Reativar"');
  has(pageSrc, 'pausado', 'cardápio: linha "· pausado"');
  has(pageSrc, 'Remover ', 'cardápio: confirmação de remover produto');
  has(pageSrc, 'Ele some da tela de', 'cardápio: texto da confirmação');
  has(pageSrc, 'pedido do garçom. Contas já fechadas não mudam.', 'cardápio: texto da confirmação (continuação)');

  // Ajustes do dono.
  has(pageSrc, 'Somada em cima do consumo em toda conta (padrão 3%).', 'ajustes: nota da taxa');
  has(pageSrc, 'Vale pros garçons cadastrados daqui pra frente.', 'ajustes: nota da comissão');
  has(pageSrc, 'Número de mesas inválido (de 1 a 60).', 'ajustes: erro de nº de mesas');
  has(pageSrc, 'Número de mesas', 'ajustes: campo "Número de mesas"');

  // Fluxo do garçom: mesas, pedir, servir, resumo, vias, revisão.
  has(waiterSrc, 'Olá, {firstName}', 'mesas: cabeçalho "Olá, <nome> · <restaurante>"');
  has(waiterSrc, 'Dia encerrado — o dono finalizou o dia.', 'mesas: aviso de dia encerrado');
  has(waiterSrc, 'A mesa ${tableNumber} está com', 'mesas: "A mesa N está com X — só ele pode mexer nela."');
  has(waiterSrc, 'Abrindo…', 'mesas: "Abrindo…" enquanto abre');
  has(waiterSrc, 'setInterval', 'mesas: lista atualiza a cada 5 s');
  has(waiterSrc, '5000', 'mesas: intervalo de 5 s');
  check(
    'cores do garçom no CSS (magenta, laranja, verde, âmbar, cinza)',
    cssSrc.includes('#d81b9f') &&
      cssSrc.includes('#f59e0b') &&
      cssSrc.includes('#43a047') &&
      cssSrc.includes('#e6a817') &&
      cssSrc.includes('#757575'),
  );
  check(
    'cores do tema no CSS (texto, cinza, borda)',
    cssSrc.includes('#2a1e33') &&
      cssSrc.includes('#7e7189') &&
      cssSrc.includes('#e5dcee'),
  );
  has(waiterSrc, 'Resultados para', 'pedir: "Resultados para ..."');
  has(waiterSrc, 'Nenhum produto encontrado. Confira o nome.', 'pedir: sem achado');
  has(waiterSrc, 'O cardápio ainda está vazio. O cadastro dos produtos é', 'pedir: cardápio vazio');
  has(waiterSrc, 'na área financeira do restaurante', 'pedir: cardápio vazio (continuação)');
  check(
    'pedir: REVISAR só com o rótulo (sem contagem/total)',
    waiterSrc.includes('✓ REVISAR') && !waiterSrc.includes('REVISAR ({pendingCount})'),
  );
  has(waiterSrc, 'Como a bebida vai ser servida?', 'servir: pergunta do refrigerante');
  has(waiterSrc, 'Precisa de copos', 'servir: "Precisa de copos?"');
  has(waiterSrc, 'Não precisa', 'servir: "Não precisa"');
  has(waiterSrc, 'Sem copos', 'servir: "Não precisa" vira "Sem copos"');
  has(waiterSrc, 'Quantas canecas vai precisar?', 'servir: pergunta da torre');
  has(waiterSrc, 'Adicionar — {serveQty}', 'servir: botão "Adicionar — N copo(s)/caneca(s)"');
  has(waiterSrc, 'Math.min(30, q + 1)', 'servir: stepper até 30');
  has(waiterSrc, 'A enviar (', 'resumo: seção "A ENVIAR (N)"');
  has(waiterSrc, 'Total da mesa', 'resumo: "Total da mesa"');
  has(waiterSrc, 'Enviar pedido (', 'resumo: botão "Enviar pedido (N)"');
  has(waiterSrc, 'Depois de enviar, a mesa continua sua', 'resumo: aviso depois de enviar');
  has(waiterSrc, 'Envie os itens pendentes pra cozinha/bar antes de fechar a mesa.', 'resumo: fechar com pendência');
  has(waiterSrc, 'Fechar a mesa {tableNumber}?', 'resumo: confirmação "Fechar a mesa N?"');
  has(waiterSrc, 'A conta completa sai na impressora do balcão e a mesa fica', 'resumo: texto da confirmação');
  has(waiterSrc, 'livre.', 'resumo: texto da confirmação (continuação)');
  has(waiterSrc, 'Fechar e imprimir', 'resumo: botão "Fechar e imprimir"');
  has(waiterSrc, 'Vias impressas desta mesa', 'resumo: lista "Vias impressas desta mesa"');
  has(waiterSrc, 'Via impressa', 'resumo: modal "Via impressa"');
  has(waiterSrc, 'Pedido enviado — vias impressas', 'envio: modal "Pedido enviado — vias impressas"');
  has(waiterSrc, 'OK, voltar à mesa', 'envio: botão "OK, voltar à mesa"');
  has(waiterSrc, 'Conta fechada — via do balcão', 'conta: modal "Conta fechada — via do balcão"');
  has(waiterSrc, 'Ver revisão da mesa', 'conta: botão "Ver revisão da mesa"');
  has(waiterSrc, 'O que tinha em cada mesa que você fechou.', 'revisão: texto de abertura');
  has(waiterSrc, 'Você ainda não fechou nenhuma mesa.', 'revisão: texto de vazio');
  has(waiterSrc, 'Fechada em {formatDateTime', 'revisão: cartão "Fechada em dd/mm HH:MM · N itens"');
  has(waiterSrc, 'Aberta às {formatTime', 'revisão: "Aberta às HH:MM · fechada às HH:MM"');
  has(waiterSrc, 'Ver via do balcão', 'revisão: botão "Ver via do balcão"');
  has(waiterSrc, 'Via do balcão — conta fechada', 'revisão: modal "Via do balcão — conta fechada"');
  has(waiterSrc, 'station-badge', 'resumo/revisão: selo Cozinha/Bar');
  has(waiterSrc, 'obs: ${item.note} (editar)', 'resumo: "obs: <texto> (editar)"');
  has(waiterSrc, 'note-save', 'resumo: botão verde "Salvar" da observação');
  check(
    'cupom: papel #fffdf7 máx. 320px, nome em Archivo 26px',
    cssSrc.includes('#fffdf7') &&
      cssSrc.includes('max-width: 320px') &&
      cssSrc.includes('font-size: 26px'),
  );
  has(pageSrc, '<span>TOTAL</span>', 'conta: "TOTAL" em destaque');
  check(
    'vias: sem "✓ Pedido em preparo!" (só "Pedido em preparo!")',
    !pageSrc.includes('✓ Pedido em preparo!'),
  );
}

/* ------------------------------------------------------------------ */
/* 22 · Sem tela de primeiro acesso: dono cai direto no Financeiro     */
/* ------------------------------------------------------------------ */
section('22 · Sem tela de primeiro acesso');
{
  const has = (src, s, name) => check(name, src.includes(s));
  const notHas = (src, s, name) => check(name, !src.includes(s));

  // Estático: nenhum caminho leva mais à tela de primeiro acesso.
  notHas(pageSrc, "setView('setup')", 'nenhum setView para setup');
  notHas(pageSrc, "view === 'setup'", 'nenhuma branch de view setup');
  notHas(pageSrc, 'function SetupView', 'componente SetupView removido');
  notHas(
    pageSrc,
    "ws.length === 0 ? 'setup' : 'owner'",
    'sem desvio por nº de garçons',
  );
  notHas(
    pageSrc,
    'Primeiro acesso — configure o sistema uma única vez.',
    'texto do primeiro acesso removido',
  );
  notHas(
    pageSrc,
    'Cadastre ao menos 1 produto para continuar.',
    'trava do primeiro acesso removida',
  );

  // enterOwnerArea vai direto pro painel do dono.
  const enterOwnerSrc = pageSrc.slice(
    pageSrc.indexOf('async function enterOwnerArea'),
    pageSrc.indexOf('async function handleOwnerLogin'),
  );
  has(enterOwnerSrc, "setView('owner')", 'enterOwnerArea vai pro painel');
  notHas(enterOwnerSrc, "'setup'", 'enterOwnerArea sem setup');

  // Boot com sessão do dono restaurada também vai direto pro painel.
  const bootSrc = pageSrc.slice(
    pageSrc.indexOf(
      '// QR Code dos garçons (?acesso=garcom ou ?tela=garcom): pula a',
    ),
    pageSrc.indexOf('/** Login único do formulário principal'),
  );
  has(bootSrc, "setView('owner')", 'boot do dono vai pro painel');
  // O 'setup' que resta no boot é o modo do acesso do admin (/adm),
  // não a tela de primeiro acesso: a restauração do dono não tem setup.
  const ownerBootSrc = bootSrc.slice(
    bootSrc.indexOf('// Sessão do dono (área financeira)'),
  );
  notHas(ownerBootSrc, "'setup'", 'boot do dono sem setup');

  // Abas do painel funcionam com 0 itens (botão + estado vazio).
  has(pageSrc, 'Novo garçom', 'aba Garçons tem "Novo garçom"');
  has(
    pageSrc,
    'Nenhum garçom cadastrado.',
    'aba Garçons tem estado vazio',
  );
  has(pageSrc, 'Novo produto', 'aba Cardápio tem "Novo produto"');
  has(
    pageSrc,
    'O cardápio está vazio.',
    'aba Cardápio tem estado vazio',
  );
  has(pageSrc, "tab === 'waiters'", 'painel tem aba Garçons');
  has(pageSrc, "tab === 'menu'", 'painel tem aba Cardápio');

  // Funcional (modo local): restaurante novo com 0 garçons e 0 produtos
  // — o dono entra mesmo assim e cadastra garçom e produto pelas abas.
  const hashVazio = await store.hashPassword('senha-vazio-123');
  await store.registerRestaurant({
    restaurantName: 'Teste Vazio',
    ownerName: 'Dono Vazio',
    login: 'dono-vazio',
    passwordHash: hashVazio,
  });
  check(
    'restaurante novo começa com 0 garçons',
    (await store.listWaiters()).length === 0,
  );
  check(
    'restaurante novo começa com 0 produtos',
    (await store.listProducts()).length === 0,
  );
  const authVazio = await store.authenticate('dono-vazio', 'senha-vazio-123');
  check(
    'login do dono com 0 garçons entra como dono',
    authVazio !== null && authVazio.kind === 'owner',
  );
  const wVazio = await store.createWaiter(
    'Carlos Vazio',
    'garcom-vazio',
    await store.hashPassword('senha-garcom-123'),
    8,
  );
  check(
    'criar garçom pela aba Garçons funciona com 0 itens',
    wVazio.login === 'garcom-vazio' &&
      (await store.listWaiters()).length === 1,
  );
  const pVazio = await store.createProduct({
    name: 'Prato Vazio',
    price_cents: 3290,
    category: 'Almoço',
    prints_in: 'kitchen',
  });
  check(
    'criar produto pela aba Cardápio funciona com 0 itens',
    pVazio.name === 'Prato Vazio' &&
      (await store.listProducts()).length === 1,
  );
  const authGarcomVazio = await store.authenticate(
    'garcom-vazio',
    'senha-garcom-123',
  );
  check(
    'garçom criado entra no login',
    authGarcomVazio !== null && authGarcomVazio.kind === 'waiter',
  );
}

/* ------------------------------------------------------------------ */
/* 23 · QR Code dos garçons: leitura e boot sem erro                   */
/* ------------------------------------------------------------------ */
section('23 · QR Code dos garçons');
{
  const has = (src, s, name) => check(name, src.includes(s));
  const notHas = (src, s, name) => check(name, !src.includes(s));

  // O endereço codificado no QR é o login do garçom.
  check(
    'waiterLoginUrl monta o endereço com ?acesso=garcom',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app') ===
      'https://cardapio-digital-do-futuro.vercel.app/?acesso=garcom',
  );
  check(
    'waiterLoginUrl tolera barra no fim da origem',
    store.waiterLoginUrl('https://cardapio-digital-do-futuro.vercel.app/') ===
      'https://cardapio-digital-do-futuro.vercel.app/?acesso=garcom',
  );

  // Geração do QR: margem 4 (zona de silêncio do padrão) e SVG 208px.
  const qrGenSrc = pageSrc.slice(
    pageSrc.indexOf('QRCode.toString(qrUrl'),
    pageSrc.indexOf('}, [qrUrl])'),
  );
  has(qrGenSrc, 'margin: 4', 'QR com margem 4 (zona de silêncio)');
  notHas(qrGenSrc, 'margin: 1', 'QR sem margem 1');
  has(qrGenSrc, "type: 'svg'", 'QR em SVG');
  has(qrGenSrc, 'width: 208', 'QR com 208px');
  has(pageSrc, 'QR Code dos garçons', 'seção do QR na aba Garçons');
  has(
    pageSrc,
    'dangerouslySetInnerHTML={{ __html: qrSvg }}',
    'QR renderizado como SVG inline',
  );

  // O parâmetro é aceito nas duas formas e o estado inicial já cai no login.
  has(
    pageSrc,
    "q.get('acesso') === 'garcom'",
    'parâmetro ?acesso=garcom aceito',
  );
  has(
    pageSrc,
    "q.get('tela') === 'garcom'",
    'parâmetro ?tela=garcom aceito',
  );
  has(
    pageSrc,
    'useState(() => isWaiterOnlyParam())',
    'modo garçom decidido no primeiro render',
  );
  has(
    pageSrc,
    "isWaiterOnlyParam() || isAdminPath() ? 'login' : 'home'",
    'QR abre direto no login',
  );
  has(
    pageSrc,
    '{!waiterOnly && (',
    'login do QR esconde links de dono/cadastro/admin',
  );
  has(
    pageSrc,
    "if (waiterOnly) throw new Error('Não foi possível entrar. Tente de novo.');",
    'login de dono recusado na tela do QR',
  );

  // Boot no endereço do QR nunca mostra a tela de erro: a consulta do
  // administrador não roda nesse modo e o catch não mostra mensagem.
  const bootSrc = pageSrc.slice(
    pageSrc.indexOf(
      '// QR Code dos garçons (?acesso=garcom ou ?tela=garcom): pula a',
    ),
    pageSrc.indexOf('/** Login único do formulário principal'),
  );
  check(
    'boot no QR não consulta o administrador antes de decidir a tela',
    bootSrc.indexOf('if (!onlyWaiter)') <
      bootSrc.indexOf('getPlatformAdmin()'),
  );
  has(
    bootSrc,
    'if (!isWaiterOnlyParam()) {',
    'catch do boot só mostra erro fora do QR',
  );
  has(
    bootSrc,
    "setView(onlyWaiter ? 'login' : 'home')",
    'boot sem sessão no QR cai no login do garçom',
  );
}

/* ------------------------------------------------------------------ */
/* 24 · Planos: cadastro com plano + painel do admin com plano e trial */
/* ------------------------------------------------------------------ */
section('24 · Planos e painel do administrador');
{
  const hash = await store.hashPassword('senha-plano-123');

  // Cadastro com plano Mensal grava o plano certo.
  const mensal = await store.registerRestaurant({
    restaurantName: 'Restaurante Mensal',
    ownerName: 'Marta',
    login: 'dona-marta',
    passwordHash: hash,
    plan: 'monthly',
  });
  check(
    'cadastro com plano Mensal grava monthly',
    mensal.restaurant.plan === 'monthly',
  );
  check(
    'cadastro Mensal volta na lista com o plano',
    (await store.listRestaurants()).find(
      (r) => r.id === mensal.restaurant.id,
    )?.plan === 'monthly',
  );

  // Cadastro com plano Anual grava o plano certo.
  const anual = await store.registerRestaurant({
    restaurantName: 'Restaurante Anual',
    ownerName: 'Ana',
    login: 'dona-ana',
    passwordHash: hash,
    plan: 'annual',
  });
  check(
    'cadastro com plano Anual grava annual',
    anual.restaurant.plan === 'annual',
  );

  // Cadastro genérico (sem plano) fica sem plano definido — período grátis.
  const semPlano = await store.registerRestaurant({
    restaurantName: 'Restaurante Sem Plano',
    ownerName: 'Sofia',
    login: 'dona-sofia',
    passwordHash: hash,
  });
  check(
    'cadastro sem plano fica sem plano definido',
    semPlano.restaurant.plan === null ||
      semPlano.restaurant.plan === undefined,
  );

  // Rótulos dos planos.
  check(
    'rótulo Mensal com preço',
    store.planLabel('monthly') === 'Mensal — R$ 69,99/mês',
  );
  check(
    'rótulo Anual com preço',
    store.planLabel('annual') === 'Anual — R$ 499,99/ano',
  );
  check(
    'rótulo sem plano',
    store.planLabel(undefined) === 'Sem plano escolhido',
  );
  check('período grátis dura 3 dias', store.TRIAL_DAYS === 3);

  // Status do trial: contado da data de cadastro.
  const DAY = 24 * 60 * 60 * 1000;
  const agora = new Date();
  check(
    'trial de quem acabou de cadastrar: em trial, restam 3 dias',
    (() => {
      const t = store.trialStatus(agora.toISOString(), agora);
      return t.inTrial === true && t.daysLeft === 3;
    })(),
  );
  check(
    'trial de quem cadastrou há 2 dias: em trial, resta 1 dia',
    (() => {
      const t = store.trialStatus(
        new Date(agora.getTime() - 2 * DAY).toISOString(),
        agora,
      );
      return t.inTrial === true && t.daysLeft === 1;
    })(),
  );
  check(
    'trial de quem cadastrou há 4 dias: encerrado, 0 dias',
    (() => {
      const t = store.trialStatus(
        new Date(agora.getTime() - 4 * DAY).toISOString(),
        agora,
      );
      return t.inTrial === false && t.daysLeft === 0;
    })(),
  );
  check(
    'fim do trial é 3 dias após o cadastro',
    store.trialEndDate(agora.toISOString()).getTime() ===
      agora.getTime() + 3 * DAY,
  );

  // Painel do admin: plano + trial por restaurante; restaurante antigo
  // sem plano (Gosto Caseiro) aparece como trial, contado do cadastro.
  const summaries = await store.listRestaurantSummaries();
  const m = summaries.find(
    (s) => s.restaurant.name === 'Restaurante Mensal',
  );
  const a = summaries.find((s) => s.restaurant.name === 'Restaurante Anual');
  const sp = summaries.find(
    (s) => s.restaurant.name === 'Restaurante Sem Plano',
  );
  const gc = summaries.find((s) => s.restaurant.name === 'Gosto Caseiro');
  check('admin: Mensal com plano monthly', m?.restaurant.plan === 'monthly');
  check('admin: Anual com plano annual', a?.restaurant.plan === 'annual');
  check(
    'admin: Sem Plano sem plano definido',
    sp?.restaurant.plan === null || sp?.restaurant.plan === undefined,
  );
  check(
    'admin: Gosto Caseiro (antigo, sem plano) aparece como trial',
    gc !== undefined &&
      (gc.restaurant.plan === null || gc.restaurant.plan === undefined) &&
      store.trialStatus(gc.restaurant.created_at).inTrial === true,
  );
  check(
    'admin: resumo continua sem nenhum campo financeiro',
    gc !== undefined &&
      JSON.stringify(Object.keys(gc).sort()) ===
        JSON.stringify(['ownerName', 'restaurant', 'waiterCount']),
  );

  // Checagens estáticas do fluxo do plano.
  const has = (src, s, name) => check(name, src.includes(s));
  has(
    pageSrc,
    "onClick={() => onRegister('monthly')}",
    'cartão Mensal passa o plano pro cadastro',
  );
  has(
    pageSrc,
    "onClick={() => onRegister('annual')}",
    'cartão Anual passa o plano pro cadastro',
  );
  has(
    pageSrc,
    'onClick={() => onRegister()}',
    'botões genéricos (cabeçalho/hero/fim) vão sem plano',
  );
  has(pageSrc, 'plan={registerPlan}', 'cadastro recebe o plano escolhido');
  has(
    pageSrc,
    'onRegister(restaurantName, name, login, password, plan ?? null)',
    'formulário de cadastro repassa o plano',
  );
  has(
    pageSrc,
    'Plano escolhido: ${store.planLabel(plan)}',
    'formulário mostra o plano escolhido',
  );
  has(
    pageSrc,
    'store.planLabel(registeredPlan)',
    'tela de sucesso mostra o plano',
  );
  has(
    pageSrc,
    'store.planLabel(s.restaurant.plan)',
    'painel do admin mostra o plano',
  );
  has(
    pageSrc,
    'store.trialStatus(s.restaurant.created_at)',
    'painel do admin mostra o status do trial',
  );
  has(pageSrc, 'Período', 'painel do admin mostra o período grátis');
  has(storeSrc, 'TRIAL_DAYS', 'store: duração do período grátis');
  has(storeSrc, 'planLabel', 'store: rótulo do plano');
  has(storeSrc, 'trialStatus', 'store: status do trial');
  has(storeSrc, 'trialEndDate', 'store: fim do trial');
  has(storeSrc, 'plan?: PlanId | null', 'store: cadastro aceita o plano');
  has(storeSrc, 'plan: restaurant.plan ?? null', 'store: plano gravado');
  has(
    sqlSrc,
    "plan text check (plan in ('monthly', 'annual'))",
    'SQL: coluna plan em restaurants',
  );
  has(
    sqlSrc,
    'add column if not exists plan',
    'SQL: migração da coluna plan p/ bancos antigos',
  );

  // O painel do admin continua sem financeiro: plano e trial são
  // cadastro, não venda — nenhum valor de venda ou comissão aparece.
  const adminStart = pageSrc.indexOf('function PlatformAdminView');
  const adminEnd = pageSrc.indexOf('type OwnerTab');
  const adminSrc = pageSrc.slice(adminStart, adminEnd);
  for (const s of ['total_cents', 'Total vendido', 'Comissão', 'commission', 'brl(']) {
    check('painel do admin não mostra "' + s + '"', !adminSrc.includes(s));
  }
}

/* ------------------------------------------------------------------ */
/* 25 · Entrada escondida do administrador: /adm                        */
/* ------------------------------------------------------------------ */
section('25 · Administrador escondido em /adm');
{
  const has = (src, s, name) => check(name, src.includes(s));
  const notHas = (src, s, name) => check(name, !src.includes(s));

  // A rota existe e renderiza o mesmo app da página principal.
  has(admSrc, "import Page from '../page'", 'rota /adm usa o mesmo app');
  has(admSrc, 'export default function AdminPage', 'rota /adm exportada');
  has(admSrc, '/adm', 'rota /adm documentada no arquivo');

  // O boot detecta o caminho e abre o login do admin.
  has(pageSrc, 'function isAdminPath()', 'detecção do caminho /adm');
  has(pageSrc, "p === '/adm'", 'caminho /adm reconhecido');
  has(
    pageSrc,
    'isWaiterOnlyParam() || isAdminPath()',
    'estado inicial no /adm já é o login',
  );
  has(
    pageSrc,
    "setAdminAuth(adminExists ? 'login' : 'setup')",
    'boot no /adm abre login (ou primeiro acesso se não há admin)',
  );
  has(
    pageSrc,
    'if (isAdminPath()) {',
    'boot no /adm desvia pro login do admin',
  );

  // No /adm, o boot NÃO restaura sessão de dono nem de garçom: o
  // desvio do /adm vem antes da restauração do dono e retorna antes
  // da restauração do garçom.
  const bootSrc = pageSrc.slice(
    pageSrc.indexOf('useEffect(() => {'),
    pageSrc.indexOf('/** Login único do formulário principal'),
  );
  check(
    'desvio do /adm vem antes da restauração do dono',
    bootSrc.indexOf('if (isAdminPath())') <
      bootSrc.indexOf('// Sessão do dono (área financeira)'),
  );
  check(
    'desvio do /adm vem antes da restauração do garçom',
    bootSrc.indexOf('if (isAdminPath())') <
      bootSrc.indexOf('const raw = safeGet(SESSION_KEY)'),
  );

  // Sair no /adm volta pro login do admin, não pra apresentação.
  has(
    pageSrc,
    'if (isAdminPath()) {\n      setAdminAuth(hasAdmin ? \'login\' : \'setup\');',
    'logout no /adm volta pro login do admin',
  );

  // O login do admin no /adm não tem "Voltar ao login do garçom".
  has(pageSrc, 'hideCancel={isAdminPath()}', 'cancelar escondido no /adm');
  has(pageSrc, 'hideCancel?: boolean', 'AdminAuthView aceita esconder o voltar');

  // Nenhuma entrada visível pro painel em lugar nenhum do site.
  notHas(pageSrc, 'admin-link', 'sem botão de admin em lugar nenhum');
  const homeSrc = pageSrc.slice(
    pageSrc.indexOf('function HomeView'),
    pageSrc.indexOf('/* ------------------- DONO: DASHBOARD'),
  );
  check(
    'apresentação não tem entrada do admin',
    !homeSrc.includes('Área do administrador') &&
      !homeSrc.includes('admin'),
  );
}

console.log(`\n========================================`);
console.log(`SMOKE: ${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  console.log('Falhas:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log('Tudo OK.');
