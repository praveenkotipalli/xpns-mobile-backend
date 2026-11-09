import { env } from '../env.js';

/**
 * Calendar dates in the app's time zone, not the server's.
 *
 * The server runs in UTC and Postgres' CURRENT_DATE follows it, so an entry
 * saved in India at 1 am used to be dated yesterday, and on the 1st of a month
 * "this month" still meant last month until 5:30 am. Every default date the
 * server fills in comes from here instead.
 */
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today as YYYY-MM-DD (en-CA formats dates exactly that way). */
export function today() {
  return formatter.format(new Date());
}

/** { year, month } for today, month being 1-12. */
export function currentPeriod() {
  const [year, month] = today().split('-').map(Number);
  return { year, month };
}

/** First day of the current month as YYYY-MM-DD. */
export function monthStart() {
  return `${today().slice(0, 7)}-01`;
}
