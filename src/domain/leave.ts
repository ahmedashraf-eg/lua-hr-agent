/**
 * leave.ts — leave entitlement, balance and request validation.
 *
 * Corrections against the original Lua implementation:
 *
 *   1. Sick leave was a flat 15 days everywhere. KSA Art. 117 actually grants
 *      a graduated year: 30 days at full pay, 60 at three quarters, 30 unpaid.
 *      That is now modelled as tiers rather than a single misleading number.
 *   2. Unpaid leave was `math.huge`, so the agent would approve any length of
 *      unpaid leave without a second thought. It now requires HR approval.
 *   3. Entitlement is derived from hire date rather than a stored tenure
 *      field, which had already gone stale in the fixtures.
 */

import { annualLeaveDays, getCountryRule } from './countryRules';
import { completedMonths, inclusiveDays, parseISO } from './tenure';

export type LeaveType = 'annual' | 'sick' | 'unpaid';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export const LEAVE_TYPES: readonly LeaveType[] = ['annual', 'sick', 'unpaid'] as const;

export interface LeaveRecord {
  id: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  status: LeaveStatus;
  createdAt: string;
}

/** A band of sick leave at a given rate of pay. */
export interface SickLeaveTier {
  days: number;
  payRate: number;
  label: string;
}

/**
 * Sick leave entitlement per country, as graduated tiers.
 * KSA Art. 117 is the detailed case; the others are the common statutory
 * position and should be confirmed against local counsel before production.
 */
export const SICK_LEAVE: Record<string, SickLeaveTier[]> = {
  KSA: [
    { days: 30, payRate: 1.0, label: 'full pay' },
    { days: 60, payRate: 0.75, label: 'three-quarter pay' },
    { days: 30, payRate: 0.0, label: 'unpaid' },
  ],
  UAE: [
    { days: 15, payRate: 1.0, label: 'full pay' },
    { days: 30, payRate: 0.5, label: 'half pay' },
    { days: 45, payRate: 0.0, label: 'unpaid' },
  ],
  EGY: [{ days: 180, payRate: 0.75, label: 'social-insurance rate' }],
  JOR: [{ days: 14, payRate: 1.0, label: 'full pay' }],
};

export interface Entitlement {
  annual: number;
  sickTotal: number;
  sickTiers: SickLeaveTier[];
  source: string;
}

/** Full entitlement picture for an employee. */
export function entitlements(
  country: string,
  hireDate: string,
  asOf?: string,
): Entitlement | null {
  const annual = annualLeaveDays(country, hireDate, asOf);
  const rule = getCountryRule(country);
  if (!annual || !rule) return null;

  const sickTiers = SICK_LEAVE[rule.code] ?? [];

  return {
    annual: annual.days,
    sickTotal: sickTiers.reduce((sum, tier) => sum + tier.days, 0),
    sickTiers,
    source: rule.source,
  };
}

export interface LeaveYear {
  start: string;
  end: string;
  label: string;
}

/**
 * The leave year a given date falls in.
 *
 * Calendar year, which is the common convention across the four operating
 * countries and matches the carry-over rule in the leave policy (up to five
 * days into the following year, to be taken by 31 March).
 *
 * This exists because entitlement is annual and leave records are not. An
 * employee hired in 2019 has seven years of history in the HRIS; summing all
 * of it against one year's entitlement reports everyone as having nothing
 * left, which is both wrong and the kind of wrong that looks plausible.
 */
export function leaveYearOf(asOf: string = new Date().toISOString().slice(0, 10)): LeaveYear {
  const year = asOf.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
}

/**
 * Days already committed for a leave type — approved plus pending.
 *
 * Pending requests reserve entitlement so two requests submitted in quick
 * succession cannot together overdraw the balance.
 *
 * Scoped to a leave year. A request is counted in the year it starts, so a
 * period spanning New Year lands wholly in the year it began rather than
 * being split — simpler to explain to an employee, and it matches how the
 * request was approved.
 */
export function reservedDays(
  records: LeaveRecord[],
  type: LeaveType,
  period?: LeaveYear,
): number {
  return records
    .filter((r) => {
      if (r.type !== type) return false;
      if (r.status !== 'approved' && r.status !== 'pending') return false;
      if (!period) return true;
      return r.startDate >= period.start && r.startDate <= period.end;
    })
    .reduce((sum, r) => sum + (r.days || 0), 0);
}

export interface Balance {
  type: LeaveType;
  entitlement: number;
  reserved: number;
  remaining: number;
  requiresApproval: boolean;
  /** The leave year these numbers describe. */
  period: LeaveYear;
  source: string;
}

/** Remaining balance for a leave type, within the current leave year. */
export function balance(
  country: string,
  hireDate: string,
  type: LeaveType,
  records: LeaveRecord[],
  asOf?: string,
): Balance | null {
  const ent = entitlements(country, hireDate, asOf);
  if (!ent) return null;

  const period = leaveYearOf(asOf);
  const reserved = reservedDays(records, type, period);

  if (type === 'unpaid') {
    // No statutory cap, but unpaid leave is never automatically granted.
    return {
      type,
      entitlement: Infinity,
      reserved,
      remaining: Infinity,
      requiresApproval: true,
      period,
      source: ent.source,
    };
  }

  const entitlement = type === 'annual' ? ent.annual : ent.sickTotal;

  return {
    type,
    entitlement,
    reserved,
    remaining: Math.max(0, entitlement - reserved),
    requiresApproval: false,
    period,
    source: ent.source,
  };
}

export type LeaveRejection =
  | 'unknown_country'
  | 'invalid_type'
  | 'invalid_dates'
  | 'end_before_start'
  | 'insufficient_balance'
  | 'below_minimum_service';

export interface LeaveValidation {
  ok: boolean;
  reason?: LeaveRejection;
  days?: number;
  remaining?: number;
  entitlement?: number;
  requiresApproval?: boolean;
  message?: string;
}

/** Validate a leave request against dates, service length and balance. */
export function validateLeaveRequest(params: {
  country: string;
  hireDate: string;
  type: string;
  startDate: string;
  endDate: string;
  records: LeaveRecord[];
  asOf?: string;
}): LeaveValidation {
  const rule = getCountryRule(params.country);
  if (!rule) {
    return { ok: false, reason: 'unknown_country', message: `Unsupported country: ${params.country}` };
  }

  if (!LEAVE_TYPES.includes(params.type as LeaveType)) {
    return {
      ok: false,
      reason: 'invalid_type',
      message: `Leave type must be one of: ${LEAVE_TYPES.join(', ')}`,
    };
  }
  const type = params.type as LeaveType;

  let days: number;
  try {
    if (parseISO(params.endDate) < parseISO(params.startDate)) {
      return { ok: false, reason: 'end_before_start', message: 'The end date falls before the start date.' };
    }
    days = inclusiveDays(params.startDate, params.endDate);
  } catch {
    return { ok: false, reason: 'invalid_dates', message: 'Dates must be in YYYY-MM-DD format.' };
  }

  if (type === 'annual') {
    const months = rule.minServiceMonthsForLeave;
    // Must be measured in months, not years x 12 — otherwise a UAE employee
    // at eight months reads as zero and is refused leave they are owed.
    const served = completedMonths(params.hireDate, params.asOf);
    if (served < months) {
      return {
        ok: false,
        reason: 'below_minimum_service',
        days,
        message: `${rule.name} requires ${months} months of service before paid annual leave accrues.`,
      };
    }
  }

  // Checked against the leave year the request falls in, not today's. Leave
  // booked for January is drawn from January's entitlement, so a request made
  // in December for the new year does not fail against the old year's balance.
  const bal = balance(params.country, params.hireDate, type, params.records, params.startDate);
  if (!bal) {
    return { ok: false, reason: 'unknown_country' };
  }

  if (type === 'unpaid') {
    return {
      ok: true,
      days,
      remaining: Infinity,
      entitlement: Infinity,
      requiresApproval: true,
      message: 'Unpaid leave is not automatically granted and needs HR approval.',
    };
  }

  if (days > bal.remaining) {
    return {
      ok: false,
      reason: 'insufficient_balance',
      days,
      remaining: bal.remaining,
      entitlement: bal.entitlement,
      message: `Requested ${days} days but only ${bal.remaining} of ${bal.entitlement} remain.`,
    };
  }

  return {
    ok: true,
    days,
    remaining: bal.remaining - days,
    entitlement: bal.entitlement,
    requiresApproval: false,
  };
}
