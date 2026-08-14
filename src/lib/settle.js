import { money } from './ids.js';

/**
 * Split `amount` equally across `count` people without losing paise.
 * The remainder is spread one paisa at a time over the first few shares, so
 * 100 / 3 becomes [33.34, 33.33, 33.33] and always sums back to 100.
 */
export function equalShares(amount, count) {
  const totalPaise = Math.round(money(amount) * 100);
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

/**
 * Turn per-person net positions into the smallest sensible set of payments.
 * Greedy largest-creditor / largest-debtor matching — not provably minimal in
 * every case, but it never invents a payment and reads naturally to humans.
 */
export function settlements(participants) {
  const creditors = participants.filter((p) => p.net > 0.009).map((p) => ({ ...p })).sort((a, b) => b.net - a.net);
  const debtors = participants.filter((p) => p.net < -0.009).map((p) => ({ ...p, net: -p.net })).sort((a, b) => b.net - a.net);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const pay = money(Math.min(debtors[i].net, creditors[j].net));
    if (pay > 0) {
      transfers.push({
        fromParticipantId: debtors[i].id,
        fromName: debtors[i].name,
        toParticipantId: creditors[j].id,
        toName: creditors[j].name,
        amount: pay,
      });
    }
    debtors[i].net = money(debtors[i].net - pay);
    creditors[j].net = money(creditors[j].net - pay);
    if (debtors[i].net <= 0.009) i += 1;
    if (creditors[j].net <= 0.009) j += 1;
  }

  return transfers;
}
