/**
 * ESC/POS — monta os bytes do cupom térmico a partir da via (PrintJob).
 *
 * Usado pelo caminho do celular: a central de impressão manda esses
 * bytes direto pra impressora Bluetooth (Web Bluetooth), sem toque.
 * O caminho do computador usa o HTML da via com CSS de impressão;
 * este arquivo é o mesmo conteúdo, em bytes.
 *
 * Regras do cupom (iguais às da via na tela — não mudar o conteúdo):
 * cabeçalho com o nome do restaurante + "Pedido Nº 0001", Mesa/Hora/
 * Garçom, faixa do setor, itens com quantidade, observações, rodapé;
 * a conta do balcão tem itens com preços, subtotal, taxa, TOTAL em
 * destaque e "Obrigado pela preferência!".
 *
 * Texto: impressora térmica brasileira (ESC/POS 80mm) não entende
 * acento em UTF-8 — os acentos são removidos (ex.: "Cozinha" fica
 * "COZINHA") e o texto vai em ASCII puro, 42 colunas (papel 80mm).
 */
import type { PrintJob, PrinterSector } from './types';

/** Largura do cupom em colunas (papel 80mm, fonte normal). */
export const ESCPOS_COLS = 42;

const ESC = 0x1b;
const GS = 0x1d;

/** Remove acentos e qualquer caractere fora do ASCII imprimível. */
export function escposPlain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/** Quebra o texto em linhas de no máximo `cols` colunas (sem cortar
 * palavra no meio quando dá). */
export function escposWrap(text: string, cols: number = ESCPOS_COLS): string[] {
  const clean = escposPlain(text).replace(/\s+/g, ' ');
  if (!clean) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length <= cols) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      // Palavra maior que a linha: corta em pedaços.
      let rest = w;
      while (rest.length > cols) {
        lines.push(rest.slice(0, cols));
        rest = rest.slice(cols);
      }
      cur = rest;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Linha "esquerda .... direita" (ex.: "Subtotal .... R$ 10,00"). */
export function escposSides(
  left: string,
  right: string,
  cols: number = ESCPOS_COLS,
): string {
  const l = escposPlain(left);
  const r = escposPlain(right);
  const gap = Math.max(1, cols - l.length - r.length);
  return l + ' '.repeat(gap) + r;
}

function pushText(out: number[], text: string): void {
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0x7f);
}

function pushLine(out: number[], text: string): void {
  pushText(out, text);
  out.push(0x0a);
}

function align(out: number[], mode: 0 | 1 | 2): void {
  out.push(ESC, 0x61, mode);
}

function bold(out: number[], on: boolean): void {
  out.push(ESC, 0x45, on ? 1 : 0);
}

/** Tamanho: 0 = normal, 1 = altura dupla, 2 = largura dupla, 3 = os dois. */
function textSize(out: number[], size: 0 | 1 | 2 | 3): void {
  const v = size === 0 ? 0x00 : size === 1 ? 0x01 : size === 2 ? 0x10 : 0x11;
  out.push(GS, 0x21, v);
}

function hr(out: number[], cols: number = ESCPOS_COLS): void {
  pushLine(out, '-'.repeat(cols));
}

/** Nome do setor no cupom. */
export function sectorLabel(sector: PrinterSector): string {
  return sector === 'kitchen' ? 'COZINHA' : sector === 'bar' ? 'BAR' : 'CONTA';
}

/** Moeda em centavos -> "R$ 12,34" (ASCII, sem acento). */
export function escposBrl(cents: number): string {
  return (
    'R$ ' +
    (cents / 100).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function timeHHMM(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Monta os bytes ESC/POS do cupom de uma via (PrintJob). */
export function buildEscPosSlip(
  job: PrintJob,
  restaurantName: string,
  cols: number = ESCPOS_COLS,
): Uint8Array {
  const out: number[] = [];
  // Inicializa a impressora.
  out.push(ESC, 0x40);
  const orderNo = String(job.order_number).padStart(4, '0');

  // Cabeçalho: nome do restaurante em destaque.
  align(out, 1);
  bold(out, true);
  textSize(out, 3);
  for (const line of escposWrap(restaurantName.toUpperCase(), cols)) {
    pushLine(out, line);
  }
  textSize(out, 0);
  bold(out, false);
  pushLine(out, 'Pedido No ' + orderNo);
  hr(out, cols);

  // Mesa / Hora / Garçom.
  align(out, 0);
  pushLine(
    out,
    `Mesa: ${job.table_number} | Hora: ${timeHHMM(job.created_at)} | Garcom: ${escposPlain(job.waiter_name)}`,
  );
  hr(out, cols);

  // Faixa do setor.
  align(out, 1);
  bold(out, true);
  pushLine(out, sectorLabel(job.sector));
  bold(out, false);
  align(out, 0);
  pushLine(out, 'Qtd.  Produto' + (job.kind === 'close' ? '  Valor' : ''));
  hr(out, cols);

  // Itens.
  for (const item of job.items) {
    const qty = `${item.qty}x`;
    if (job.kind === 'close') {
      pushLine(
        out,
        escposSides(
          `${qty}  ${escposPlain(item.product_name)}`,
          escposBrl(item.price_cents * item.qty),
          cols,
        ),
      );
    } else {
      pushLine(out, `${qty}  ${escposPlain(item.product_name)}`);
    }
    if (job.sector === 'kitchen' && item.description) {
      for (const line of escposWrap('  ' + item.description, cols)) {
        pushLine(out, line);
      }
    }
    if (item.serve) {
      for (const line of escposWrap('  ' + item.serve, cols)) {
        pushLine(out, line);
      }
    }
    if (item.note) {
      for (const line of escposWrap('  obs: ' + item.note, cols)) {
        pushLine(out, line);
      }
    }
  }

  // Observações juntas (vias de envio).
  const notes = job.items
    .filter((i) => i.note)
    .map((i) => `${i.qty}x ${i.product_name}: ${i.note}`);
  if (job.kind === 'send' && notes.length > 0) {
    hr(out, cols);
    pushLine(out, 'Observacoes:');
    for (const n of notes) {
      for (const line of escposWrap(n, cols)) pushLine(out, line);
    }
  }

  hr(out, cols);

  // Rodapé: envio ou conta.
  if (job.kind === 'close' && job.bill) {
    pushLine(out, escposSides('Subtotal', escposBrl(job.bill.subtotal_cents), cols));
    pushLine(out, escposSides('Taxa de servico', escposBrl(job.bill.fee_cents), cols));
    bold(out, true);
    textSize(out, 2);
    pushLine(out, escposSides('TOTAL', escposBrl(job.bill.total_cents), cols));
    textSize(out, 0);
    bold(out, false);
    hr(out, cols);
    align(out, 1);
    pushLine(out, 'Obrigado pela preferencia!');
  } else {
    align(out, 1);
    pushLine(out, 'Pedido em preparo!');
    pushLine(out, 'Qualquer duvida, chame o garcom.');
  }
  align(out, 0);

  // Avança o papel e corta.
  out.push(0x0a, 0x0a, 0x0a);
  out.push(GS, 0x56, 0x00);
  return new Uint8Array(out);
}

/** Cupom de teste — o que sai quando o dono aperta "Testar" na via. */
export function buildEscPosTestSlip(
  restaurantName: string,
  sector: PrinterSector,
  cols: number = ESCPOS_COLS,
): Uint8Array {
  const job: PrintJob = {
    id: 'teste',
    sector,
    kind: sector === 'counter' ? 'close' : 'send',
    order_number: 0,
    table_number: 0,
    waiter_name: 'Teste',
    items:
      sector === 'counter'
        ? [
            {
              product_name: 'Prato teste',
              qty: 1,
              price_cents: 2500,
            },
            {
              product_name: 'Bebida teste',
              qty: 1,
              price_cents: 899,
            },
          ]
        : [
            {
              product_name: 'Item teste',
              qty: 1,
              price_cents: 1000,
              description:
                sector === 'kitchen' ? 'o que vem no prato (teste)' : undefined,
              serve: sector === 'bar' ? 'copo com limao e gelo' : undefined,
            },
          ],
    bill:
      sector === 'counter'
        ? { subtotal_cents: 3399, fee_cents: 102, total_cents: 3501 }
        : null,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  return buildEscPosSlip(job, restaurantName, cols);
}

/** Decodifica os bytes ESC/POS de volta pra texto legível (tira os
 * comandos de controle) — usado na simulação e nos testes, pra
 * conferir o conteúdo do cupom sem impressora. */
export function decodeEscPosText(bytes: Uint8Array): string {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === ESC) {
      // ESC @ = 2 bytes; os demais comandos ESC usados aqui = 3 bytes.
      i += bytes[i + 1] === 0x40 ? 2 : 3;
      continue;
    }
    if (b === GS) {
      i += 3;
      continue;
    }
    if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
    else if (b === 0x0a) text += '\n';
    i++;
  }
  return text;
}
