/**
 * tenure.ts — date and service-length helpers.
 *
 * Replaces the three separate copies of the Hinnant days-from-civil algorithm
 * that lived in employee.lua, leave.lua and iqama.lua. JavaScript Date covers
 * every case those needed, and one implementation means one place for a bug.
 *
 * All dates are handled in UTC so results never shift with the runtime's
 * timezone — an employee's hire date is a calendar fact, not a moment in time.
 */

/** Parse an ISO date (YYYY-MM-DD) as UTC midnight. Throws on malformed input. */
export function parseISO(value: string | Date): Date {
  if (value instanceof Date) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Expected an ISO date (YYYY-MM-DD), received: ${value}`);
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Not a valid calendar date: ${value}`);
  }
  return date;
}

/** Format a Date as YYYY-MM-DD. */
export function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today, as UTC midnight. Injectable everywhere so tests stay deterministic. */
export function today(): Date {
  return parseISO(toISO(new Date()));
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: string | Date, to: string | Date): number {
  const a = parseISO(from);
  const b = parseISO(to);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Inclusive day count for a leave request — a request that starts and ends on
 * the same day is one day, not zero. This is the count HR means by "days off".
 */
export function inclusiveDays(startDate: string | Date, endDate: string | Date): number {
  return daysBetween(startDate, endDate) + 1;
}

/**
 * Service length in years as a decimal, measured against real anniversaries.
 *
 * Use this for gratuity: Saudi Labor Law Art. 84 pays a fraction of a year
 * pro rata, so truncating to whole years — as the original Lua did — quietly
 * underpays every leaver who is not on an exact anniversary.
 *
 * Deliberately NOT days / 365.25. That approximation returns 4.9993 for an
 * employee who has served exactly five years, and the KSA resignation tiers
 * are cliffs: landing a fraction under five years cuts the award from
 * two thirds to one third. Anchoring on the actual anniversary, and dividing
 * by the true length of the current service year, makes the boundary exact
 * and still handles leap years correctly.
 */
export function tenureYears(hireDate: string | Date, asOf: string | Date = today()): number {
  const start = parseISO(hireDate);
  const end = parseISO(asOf);
  if (end <= start) return 0;

  const whole = completedYears(start, end);

  const lastAnniversary = new Date(Date.UTC(
    start.getUTCFullYear() + whole, start.getUTCMonth(), start.getUTCDate(),
  ));
  const nextAnniversary = new Date(Date.UTC(
    start.getUTCFullYear() + whole + 1, start.getUTCMonth(), start.getUTCDate(),
  ));

  const yearLength = daysBetween(lastAnniversary, nextAnniversary); // 365 or 366
  const intoYear = daysBetween(lastAnniversary, end);

  return whole + intoYear / yearLength;
}

/**
 * Completed whole years of service.
 *
 * Use this for entitlement tiers, where the question is whether a threshold
 * has been crossed. An employee reaches the KSA 30-day tier the day they
 * complete five years, not partway through the fifth.
 */
export function completedYears(hireDate: string | Date, asOf: string | Date = today()): number {
  const start = parseISO(hireDate);
  const end = parseISO(asOf);

  let years = end.getUTCFullYear() - start.getUTCFullYear();
  const anniversary = new Date(Date.UTC(
    end.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  ));
  if (end < anniversary) years -= 1;

  return Math.max(0, years);
}

/** Completed whole months of service — needed for sub-one-year leave tiers. */
export function completedMonths(hireDate: string | Date, asOf: string | Date = today()): number {
  const start = parseISO(hireDate);
  const end = parseISO(asOf);

  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;

  return Math.max(0, months);
}
