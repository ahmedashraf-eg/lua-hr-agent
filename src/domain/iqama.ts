/**
 * iqama.ts — Iqama expiry monitoring.
 *
 * The Iqama is the Saudi residency permit. It has no counterpart in the other
 * three operating countries: the UAE issues an Emirates ID, and Egyptian and
 * Jordanian nationals working at home need no permit at all.
 *
 * Corrections against the original Lua implementation:
 *
 *   1. There was no country gate, and the UAE fixture carried an Iqama number.
 *      Every entry point here refuses non-Saudi employees explicitly.
 *   2. mock_config.lua declared thresholds of 90/60/30/7 days and nothing ever
 *      read them. Tiers are a parameter with a documented default.
 *   3. The 7-day tier existed in config but never in code, so the most urgent
 *      band silently did not exist.
 *   4. Already-expired Iqamas were skipped entirely — a negative day count
 *      failed the `remaining >= 0` guard, so the worst case reported nothing.
 */

import { getCountryRule } from './countryRules';
import { daysBetween, today } from './tenure';

export type AlertSeverity = 'expired' | 'critical' | 'urgent' | 'warning';

export interface AlertTier {
  withinDays: number;
  severity: AlertSeverity;
}

/** Default tiers, matching the thresholds the original config declared. */
export const DEFAULT_TIERS: AlertTier[] = [
  { withinDays: 7, severity: 'critical' },
  { withinDays: 30, severity: 'urgent' },
  { withinDays: 60, severity: 'warning' },
  { withinDays: 90, severity: 'warning' },
];

export interface IqamaHolder {
  id: string;
  displayName?: string;
  /**
   * Null where the HRIS holds a country the rules engine cannot resolve.
   * That employee is not Saudi as far as this module is concerned, so Iqama
   * tracking does not apply — which is the safe direction to fail.
   */
  country: string | null;
  iqamaNumber?: string | null;
  iqamaExpiry?: string | null;
}

export interface IqamaAlert {
  employeeId: string;
  displayName?: string;
  iqamaExpiry: string;
  daysRemaining: number;
  severity: AlertSeverity;
  tier: number | null;
  message: string;
  messageAr: string;
}

/** Whether this employee is subject to Iqama tracking at all. */
export function requiresIqama(employee: Pick<IqamaHolder, 'country'>): boolean {
  return getCountryRule(employee.country)?.usesIqama ?? false;
}

export type IqamaCheck =
  | { applicable: false; reason: 'not_saudi' | 'no_iqama_on_record'; message: string }
  | { applicable: true; alert: IqamaAlert | null; daysRemaining: number };

/**
 * Check one employee's Iqama.
 *
 * Returns `applicable: false` for non-Saudi staff rather than a null alert, so
 * a caller can say "the UAE issues an Emirates ID, not an Iqama" instead of
 * implying the permit is simply fine.
 */
export function checkIqama(
  employee: IqamaHolder,
  asOf: string = undefined as unknown as string,
  tiers: AlertTier[] = DEFAULT_TIERS,
): IqamaCheck {
  const rule = getCountryRule(employee.country);

  if (!rule?.usesIqama) {
    const where = rule?.name ?? employee.country;
    return {
      applicable: false,
      reason: 'not_saudi',
      message: `Iqama tracking applies to Saudi Arabia only. This employee is based in ${where}${
        rule?.code === 'UAE' ? ', which issues an Emirates ID instead' : ''
      }.`,
    };
  }

  if (!employee.iqamaExpiry) {
    return {
      applicable: false,
      reason: 'no_iqama_on_record',
      message: 'No Iqama expiry date is recorded for this employee. Ask HR to complete the record.',
    };
  }

  const reference = asOf ?? (today().toISOString().slice(0, 10) as string);
  const daysRemaining = daysBetween(reference, employee.iqamaExpiry);

  // Already expired — the most urgent case, and the one the old code dropped.
  if (daysRemaining < 0) {
    const overdue = Math.abs(daysRemaining);
    return {
      applicable: true,
      daysRemaining,
      alert: {
        employeeId: employee.id,
        displayName: employee.displayName,
        iqamaExpiry: employee.iqamaExpiry,
        daysRemaining,
        severity: 'expired',
        tier: null,
        message: `Iqama expired ${overdue} day${overdue === 1 ? '' : 's'} ago. Escalate to HR immediately.`,
        messageAr: `انتهت صلاحية الإقامة منذ ${overdue} يوم. يرجى التصعيد إلى الموارد البشرية فوراً.`,
      },
    };
  }

  const sorted = [...tiers].sort((a, b) => a.withinDays - b.withinDays);
  const matched = sorted.find((tier) => daysRemaining <= tier.withinDays);

  if (!matched) {
    return { applicable: true, daysRemaining, alert: null };
  }

  return {
    applicable: true,
    daysRemaining,
    alert: {
      employeeId: employee.id,
      displayName: employee.displayName,
      iqamaExpiry: employee.iqamaExpiry,
      daysRemaining,
      severity: matched.severity,
      tier: matched.withinDays,
      message: `Iqama expires in ${daysRemaining} day${
        daysRemaining === 1 ? '' : 's'
      } (${employee.iqamaExpiry}). Start renewal now.`,
      messageAr: `تنتهي صلاحية الإقامة خلال ${daysRemaining} يوم (${employee.iqamaExpiry}). يرجى بدء إجراءات التجديد.`,
    },
  };
}

/**
 * Sweep a roster for Iqamas needing attention.
 * Non-Saudi employees are skipped silently — this is the scheduled-job path,
 * where "not applicable" is not a finding worth reporting.
 */
export function sweepIqamaExpiry(
  employees: IqamaHolder[],
  asOf?: string,
  tiers: AlertTier[] = DEFAULT_TIERS,
): IqamaAlert[] {
  const alerts: IqamaAlert[] = [];

  for (const employee of employees) {
    const result = checkIqama(employee, asOf as string, tiers);
    if (result.applicable && result.alert) alerts.push(result.alert);
  }

  // Most urgent first; expired entries sort to the top on negative days.
  return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
}
