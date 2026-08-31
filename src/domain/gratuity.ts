/**
 * gratuity.ts — end-of-service entitlement for KSA, UAE, Egypt, Jordan.
 *
 * Corrections against the original Lua implementation:
 *
 *   1. KSA resignation tiers were missing entirely. Art. 85 reduces the award
 *      sharply on resignation, and the old code paid every leaver in full.
 *   2. UAE carried a resignation reduction in ARCHITECTURE.md that no longer
 *      exists — Federal Decree-Law 33/2021 abolished the old tapering, so a
 *      resigning employee now receives the same rate as one who is dismissed.
 *   3. Egypt and Jordan were modelled as a flat one month per year. Neither
 *      country runs a Gulf-style scheme: both route through social insurance,
 *      and a separate gratuity arises only for service outside that cover.
 *      They are returned as conditional, never as a bare number.
 *   4. Service years were floored. Saudi law pays fractions of a year pro
 *      rata, so flooring underpaid anyone not leaving on an anniversary.
 *   5. UAE accrues on BASIC wage, excluding allowances — a distinction the
 *      old single `monthly_wage` field could not express.
 */

import { getCountryRule, type CountryCode } from './countryRules';
import { tenureYears } from './tenure';

export type EndReason = 'resignation' | 'termination';

export interface GratuityInput {
  country: string;
  hireDate: string;
  endDate?: string;
  /** Full monthly wage. Used by KSA, Egypt and Jordan. */
  monthlyWage: number;
  /** Basic monthly wage, allowances excluded. UAE accrues on this. */
  basicMonthlyWage?: number;
  reason?: EndReason;
}

export interface GratuityResult {
  /** null where entitlement cannot be stated without more information. */
  amount: number | null;
  currency: string;
  country: CountryCode;
  years: number;
  reason: EndReason;

  /** Award before any statutory reduction or cap. */
  grossAmount: number;
  /** Multiplier applied for resignation, where the statute reduces the award. */
  reductionFactor: number;
  capApplied: boolean;

  /** True where entitlement depends on facts the HRIS does not hold. */
  conditional: boolean;
  /** Plain-language explanation. Surfaced to the employee verbatim. */
  note: string;
  source: string;
}

const DAYS_PER_MONTH = 30;

/**
 * KSA resignation tiers — Saudi Labor Law Art. 85.
 * Under two years nothing; a third to five; two thirds to ten; then full.
 */
function ksaResignationFactor(years: number): number {
  if (years < 2) return 0;
  if (years < 5) return 1 / 3;
  if (years < 10) return 2 / 3;
  return 1;
}

export function calculateGratuity(input: GratuityInput): GratuityResult | null {
  const rule = getCountryRule(input.country);
  if (!rule) return null;

  const reason: EndReason = input.reason ?? 'termination';
  const years = Math.max(0, tenureYears(input.hireDate, input.endDate));

  if (!Number.isFinite(input.monthlyWage) || input.monthlyWage < 0) {
    throw new Error(`monthlyWage must be a non-negative number, received: ${input.monthlyWage}`);
  }

  const base = {
    currency: rule.currency,
    country: rule.code,
    years: Number(years.toFixed(3)),
    reason,
  };

  switch (rule.code) {
    /* ---------------------------------------------------------------- KSA */
    case 'KSA': {
      // Art. 84: half a month per year for the first five, a full month after.
      const firstFive = Math.min(years, 5);
      const beyond = Math.max(years - 5, 0);
      const months = firstFive * 0.5 + beyond * 1.0;
      const gross = months * input.monthlyWage;

      const factor = reason === 'resignation' ? ksaResignationFactor(years) : 1;
      const amount = gross * factor;

      let note: string;
      if (reason === 'resignation' && factor === 0) {
        note =
          'No end-of-service award is payable: the employee resigned with under two years of service (Art. 85).';
      } else if (reason === 'resignation' && factor < 1) {
        note = `Resignation after ${years.toFixed(1)} years, so ${
          factor === 1 / 3 ? 'one third' : 'two thirds'
        } of the full award is payable (Art. 85).`;
      } else {
        note = 'Full award payable, calculated pro rata for partial years (Art. 84).';
      }

      return {
        ...base,
        amount,
        grossAmount: gross,
        reductionFactor: factor,
        capApplied: false,
        conditional: false,
        note,
        source: 'Saudi Labor Law, Arts. 84–85',
      };
    }

    /* ---------------------------------------------------------------- UAE */
    case 'UAE': {
      // Art. 51: 21 days of BASIC wage per year for the first five, 30 after.
      // Total capped at two years' wage. No resignation reduction since 2021.
      const basic = input.basicMonthlyWage ?? input.monthlyWage;

      if (years < 1) {
        return {
          ...base,
          amount: 0,
          grossAmount: 0,
          reductionFactor: 0,
          capApplied: false,
          conditional: false,
          note: 'No gratuity is payable below one year of continuous service (Art. 51).',
          source: 'UAE Federal Decree-Law 33/2021, Art. 51',
        };
      }

      const firstFive = Math.min(years, 5);
      const beyond = Math.max(years - 5, 0);
      const days = firstFive * 21 + beyond * 30;
      const gross = (days / DAYS_PER_MONTH) * basic;

      const cap = 24 * basic;
      const capApplied = gross > cap;
      const amount = capApplied ? cap : gross;

      return {
        ...base,
        amount,
        grossAmount: gross,
        reductionFactor: 1,
        capApplied,
        conditional: false,
        note: capApplied
          ? 'Award capped at two years’ wage (Art. 51). Accrued on basic wage, allowances excluded.'
          : 'Accrued on basic wage, allowances excluded. Resignation and dismissal are paid at the same rate under the 2021 law.',
        source: 'UAE Federal Decree-Law 33/2021, Art. 51',
      };
    }

    /* -------------------------------------------------------- EGY and JOR */
    case 'EGY':
    case 'JOR': {
      // Both countries route retirement provision through social insurance.
      // A separate end-of-service payment arises only for service outside
      // that cover, which the HRIS does not record — so the honest answer is
      // an indicative figure plus an explicit escalation, not a hard number.
      const months =
        rule.code === 'EGY'
          ? Math.min(years, 5) * 0.5 + Math.max(years - 5, 0) * 1.0
          : years * 1.0;
      const indicative = months * input.monthlyWage;

      return {
        ...base,
        amount: null,
        grossAmount: indicative,
        reductionFactor: 1,
        capApplied: false,
        conditional: true,
        note:
          rule.code === 'EGY'
            ? `Egypt provides for retirement through social insurance, and a separate end-of-service gratuity arises only for service not covered by it. Indicative figure for uncovered service: ${indicative.toFixed(
                2,
              )} ${rule.currency}. Confirm the employee's insurance history with HR before quoting a final amount.`
            : `Jordan provides for retirement through Social Security, and end-of-service compensation of one month per year applies only where employment sits outside that framework. Indicative figure: ${indicative.toFixed(
                2,
              )} ${rule.currency}. Confirm the employee's Social Security registration with HR before quoting a final amount.`,
        source:
          rule.code === 'EGY'
            ? 'Egyptian Labour Law 12/2003 and Social Insurance Law'
            : 'Jordanian Labour Law and Social Security Law',
      };
    }
  }
}
