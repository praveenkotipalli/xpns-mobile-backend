import { ApiError } from './http.js';
import { money } from './ids.js';
import { equalShares } from './settle.js';

/**
 * Turn any of the three split modes into a flat [{ id, amount }] list that is
 * guaranteed to add up to `amount`.
 *
 *   SINGLE — one person consumed the whole thing (the quick everyday case)
 *   EQUAL  — divide evenly between the chosen people, leftover paise spread
 *   CUSTOM — exact amounts per person, e.g. one drank more than the other
 *
 * `validIds` is the set of people allowed to appear, so a request can never
 * attach a share to somebody outside the space or event. `defaultIds` is who
 * an EQUAL split covers when the request names nobody — the active members,
 * so a bill is never quietly split onto someone who has been archived.
 */
export function resolveShares({ mode, amount, singleId, ids, shares }, validIds, defaultIds = validIds) {
  const total = money(amount);

  if (mode === 'SINGLE') {
    if (!singleId) throw ApiError.badRequest('Choose who this was spent on');
    if (!validIds.has(singleId)) throw ApiError.badRequest('That person is not in this space');
    return [{ id: singleId, amount: total }];
  }

  if (mode === 'EQUAL') {
    const people = ids?.length ? [...new Set(ids)] : [...defaultIds];
    if (!people.length) throw ApiError.badRequest('Choose who to split between');
    for (const id of people) {
      if (!validIds.has(id)) throw ApiError.badRequest('A selected person is not in this space');
    }
    const amounts = equalShares(total, people.length);
    return people.map((id, index) => ({ id, amount: amounts[index] }));
  }

  if (!shares?.length) throw ApiError.badRequest('Enter how much each person owes');

  const seen = new Set();
  for (const share of shares) {
    if (!validIds.has(share.id)) throw ApiError.badRequest('A selected person is not in this space');
    if (seen.has(share.id)) throw ApiError.badRequest('The same person is listed twice');
    seen.add(share.id);
  }

  const kept = shares.filter((s) => Number(s.amount) > 0).map((s) => ({ id: s.id, amount: money(s.amount) }));
  if (!kept.length) throw ApiError.badRequest('At least one person must have a share above zero');

  const sum = money(kept.reduce((t, s) => t + s.amount, 0));
  if (Math.abs(sum - total) > 0.01) {
    throw ApiError.badRequest(
      `Shares add up to ${sum.toFixed(2)} but the bill is ${total.toFixed(2)}`
    );
  }

  return kept;
}
