/**
 * performance.ts — daily check-ins and weekly team performance.
 *
 * Workflow 4 of the brief. No system exists for this today, so unlike leave or
 * gratuity there is no statute to encode — the rules here are operational
 * conventions, and they are stated as such rather than dressed up as law.
 *
 * Pure functions only. No I/O, no platform imports.
 */

export const MIN_RATING = 1;
export const MAX_RATING = 5;

/** Below this weekly average, a team member is surfaced for a conversation. */
export const CONCERN_THRESHOLD = 2.5;

/** A blocker seen on this many days in a week is treated as systemic. */
export const RECURRING_BLOCKER_DAYS = 3;

export interface MemberRating {
  employeeId: string;
  name: string;
  rating: number;
  note?: string;
}

export interface CheckIn {
  id: string;
  teamLeadId: string;
  teamLeadName: string;
  date: string;
  accomplishments: string;
  blockers: string[];
  ratings: MemberRating[];
  createdAt: string;
}

/* ---------------------------------------------------------- validation */

export type CheckInRejection =
  | 'no_ratings'
  | 'rating_out_of_range'
  | 'duplicate_member'
  | 'invalid_date'
  | 'empty_accomplishments';

export interface CheckInValidation {
  ok: boolean;
  reason?: CheckInRejection;
  message?: string;
  offending?: string;
}

export function validateCheckIn(input: {
  date: string;
  accomplishments: string;
  ratings: Array<{ employeeId: string; rating: number; name?: string }>;
}): CheckInValidation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, reason: 'invalid_date', message: 'Date must be YYYY-MM-DD.' };
  }

  if (!input.accomplishments?.trim()) {
    return {
      ok: false,
      reason: 'empty_accomplishments',
      message: 'A check-in needs at least a short note on what the team accomplished.',
    };
  }

  if (!input.ratings?.length) {
    return {
      ok: false,
      reason: 'no_ratings',
      message: 'A check-in needs a productivity rating for at least one team member.',
    };
  }

  const seen = new Set<string>();
  for (const r of input.ratings) {
    if (seen.has(r.employeeId)) {
      return {
        ok: false,
        reason: 'duplicate_member',
        offending: r.employeeId,
        message: `Employee ${r.employeeId} was rated twice in the same check-in.`,
      };
    }
    seen.add(r.employeeId);

    if (!Number.isFinite(r.rating) || r.rating < MIN_RATING || r.rating > MAX_RATING) {
      return {
        ok: false,
        reason: 'rating_out_of_range',
        offending: r.name ?? r.employeeId,
        message: `Ratings run ${MIN_RATING} to ${MAX_RATING}. Received ${r.rating} for ${r.name ?? r.employeeId}.`,
      };
    }
  }

  return { ok: true };
}

/* --------------------------------------------------------- aggregation */

export type Trend = 'improving' | 'declining' | 'steady' | 'insufficient_data';

export interface MemberSummary {
  employeeId: string;
  name: string;
  averageRating: number;
  daysRated: number;
  lowest: number;
  highest: number;
  trend: Trend;
  needsAttention: boolean;
}

export interface TeamSummary {
  teamLeadId: string;
  teamLeadName: string;
  periodStart: string;
  periodEnd: string;
  checkInsSubmitted: number;
  expectedCheckIns: number;
  reportingRate: number;
  teamAverage: number | null;
  members: MemberSummary[];
  membersNeedingAttention: MemberSummary[];
  recurringBlockers: Array<{ blocker: string; days: number }>;
  allBlockers: string[];
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Direction of travel across a member's ratings for the period.
 *
 * Compares the first and last thirds rather than fitting a line: with three to
 * five data points a regression reads noise as signal, and a team lead asking
 * "is she improving" wants a robust answer, not a precise one.
 */
export function trendOf(ratings: number[]): Trend {
  if (ratings.length < 3) return 'insufficient_data';

  const size = Math.max(1, Math.floor(ratings.length / 3));
  const first = ratings.slice(0, size);
  const last = ratings.slice(-size);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = mean(last) - mean(first);

  if (delta >= 0.5) return 'improving';
  if (delta <= -0.5) return 'declining';
  return 'steady';
}

/** Blockers reported on RECURRING_BLOCKER_DAYS or more distinct days. */
export function recurringBlockers(
  checkIns: CheckIn[],
): Array<{ blocker: string; days: number }> {
  const byBlocker = new Map<string, Set<string>>();

  for (const checkIn of checkIns) {
    for (const raw of checkIn.blockers ?? []) {
      const key = raw.trim().toLowerCase();
      if (!key) continue;
      if (!byBlocker.has(key)) byBlocker.set(key, new Set());
      byBlocker.get(key)!.add(checkIn.date);
    }
  }

  return [...byBlocker.entries()]
    .map(([blocker, dates]) => ({ blocker, days: dates.size }))
    .filter((b) => b.days >= RECURRING_BLOCKER_DAYS)
    .sort((a, b) => b.days - a.days);
}

/**
 * Roll a set of check-ins into a weekly summary.
 *
 * `expectedCheckIns` defaults to 5 — the Gulf working week is Sunday to
 * Thursday, so a lead reporting every working day files five.
 */
export function summariseTeam(
  checkIns: CheckIn[],
  periodStart: string,
  periodEnd: string,
  expectedCheckIns = 5,
): TeamSummary | null {
  if (!checkIns.length) return null;

  const sorted = [...checkIns].sort((a, b) => a.date.localeCompare(b.date));
  const lead = sorted[0];

  const byMember = new Map<string, { name: string; ratings: number[] }>();

  for (const checkIn of sorted) {
    for (const rating of checkIn.ratings ?? []) {
      if (!byMember.has(rating.employeeId)) {
        byMember.set(rating.employeeId, { name: rating.name, ratings: [] });
      }
      byMember.get(rating.employeeId)!.ratings.push(rating.rating);
    }
  }

  const members: MemberSummary[] = [...byMember.entries()].map(([employeeId, m]) => {
    const average = m.ratings.reduce((a, b) => a + b, 0) / m.ratings.length;
    return {
      employeeId,
      name: m.name,
      averageRating: round(average),
      daysRated: m.ratings.length,
      lowest: Math.min(...m.ratings),
      highest: Math.max(...m.ratings),
      trend: trendOf(m.ratings),
      needsAttention: average < CONCERN_THRESHOLD,
    };
  });

  members.sort((a, b) => a.averageRating - b.averageRating);

  const allRatings = members.flatMap((m) => Array(m.daysRated).fill(m.averageRating) as number[]);
  const teamAverage = allRatings.length
    ? round(allRatings.reduce((a, b) => a + b, 0) / allRatings.length)
    : null;

  const distinctDays = new Set(sorted.map((c) => c.date)).size;

  return {
    teamLeadId: lead.teamLeadId,
    teamLeadName: lead.teamLeadName,
    periodStart,
    periodEnd,
    checkInsSubmitted: distinctDays,
    expectedCheckIns,
    reportingRate: round(Math.min(1, distinctDays / expectedCheckIns), 2),
    teamAverage,
    members,
    membersNeedingAttention: members.filter((m) => m.needsAttention),
    recurringBlockers: recurringBlockers(sorted),
    allBlockers: [...new Set(sorted.flatMap((c) => c.blockers ?? []).map((b) => b.trim()).filter(Boolean))],
  };
}

/* --------------------------------------------------------------- dates */

/** ISO date N days before the given date. */
export function daysAgo(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive date-range filter for check-ins. */
export function withinPeriod(checkIns: CheckIn[], start: string, end: string): CheckIn[] {
  return checkIns.filter((c) => c.date >= start && c.date <= end);
}
