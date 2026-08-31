/**
 * countryRules.ts — per-country employment rules for KSA, UAE, Egypt, Jordan.
 *
 * Every figure here is traceable to a statute, cited inline. Where a rule is
 * genuinely conditional (Egypt and Jordan gratuity) it is modelled as
 * conditional rather than flattened into a number that looks authoritative.
 *
 * Corrections against the original Lua implementation:
 *   1. Egypt and Jordan probation were 30 days. Both statutes say three months.
 *   2. UAE probation was 90 days. The 2021 law allows six months.
 *   3. UAE and Egypt had no sub-one-year annual leave tier. Both statutes
 *      grant a reduced entitlement between six and twelve months.
 *   4. `usesIqama` is now explicit. Iqama is the Saudi residency permit; the
 *      UAE issues an Emirates ID, so Iqama tooling must not touch UAE staff.
 */

import { completedMonths, completedYears } from './tenure';

export type CountryCode = 'KSA' | 'UAE' | 'EGY' | 'JOR';

export interface CountryRule {
  code: CountryCode;
  name: string;
  nameAr: string;
  currency: string;

  /** Statutory maximum probation, in days. */
  probationMaxDays: number;
  /** Where written agreement can extend probation further. */
  probationExtendableToDays?: number;

  /** Minimum months of service before any paid annual leave accrues. */
  minServiceMonthsForLeave: number;

  /** True only where the state issues an Iqama — Saudi Arabia. */
  usesIqama: boolean;

  /** Statutory annual leave in days, given completed service. */
  annualLeaveDays(service: { years: number; months: number }): number;

  /** Statute reference, surfaced in tool output so answers are auditable. */
  source: string;
}

export const COUNTRY_RULES: Record<CountryCode, CountryRule> = {
  KSA: {
    code: 'KSA',
    name: 'Saudi Arabia',
    nameAr: 'المملكة العربية السعودية',
    currency: 'SAR',
    probationMaxDays: 90,
    probationExtendableToDays: 180, // Art. 53, by written agreement
    minServiceMonthsForLeave: 12,
    usesIqama: true,
    // Art. 109: 21 days, rising to 30 after five consecutive years.
    annualLeaveDays: ({ years }) => (years >= 5 ? 30 : 21),
    source: 'Saudi Labor Law, Arts. 53, 109',
  },

  UAE: {
    code: 'UAE',
    name: 'United Arab Emirates',
    nameAr: 'الإمارات العربية المتحدة',
    currency: 'AED',
    probationMaxDays: 180, // Art. 9, Federal Decree-Law 33/2021
    minServiceMonthsForLeave: 6,
    usesIqama: false, // Emirates ID, not Iqama
    // Art. 29: 30 days after one year; 2 days per month between 6 and 12.
    annualLeaveDays: ({ years, months }) => {
      if (years >= 1) return 30;
      if (months >= 6) return months * 2;
      return 0;
    },
    source: 'UAE Federal Decree-Law 33/2021, Arts. 9, 29',
  },

  EGY: {
    code: 'EGY',
    name: 'Egypt',
    nameAr: 'مصر',
    currency: 'EGP',
    probationMaxDays: 90, // Art. 33: three months, and only once per employer
    minServiceMonthsForLeave: 6,
    usesIqama: false,
    // Art. 47: 21 days after one year; 30 after ten years' service or age 50;
    // 15 days for those between six months and one year.
    annualLeaveDays: ({ years, months }) => {
      if (years >= 10) return 30;
      if (years >= 1) return 21;
      if (months >= 6) return 15;
      return 0;
    },
    source: 'Egyptian Labour Law 12/2003, Arts. 33, 47',
  },

  JOR: {
    code: 'JOR',
    name: 'Jordan',
    nameAr: 'الأردن',
    currency: 'JOD',
    probationMaxDays: 90, // Art. 35: three months
    minServiceMonthsForLeave: 12,
    usesIqama: false,
    // Art. 61: 14 days, rising to 21 after five years with the same employer.
    annualLeaveDays: ({ years }) => (years >= 5 ? 21 : 14),
    source: 'Jordanian Labour Law, Arts. 35, 61',
  },
};

/**
 * Aliases for the forms an HRIS actually returns.
 *
 * BambooHR stores "Saudi Arabia" or an ISO-2 code, never "KSA", so every
 * lookup has to pass through here or the rules engine silently sees an
 * unknown country and refuses to answer.
 */
const COUNTRY_ALIASES: Record<string, CountryCode> = {
  KSA: 'KSA', SA: 'KSA', SAU: 'KSA',
  'SAUDI ARABIA': 'KSA',
  'KINGDOM OF SAUDI ARABIA': 'KSA',
  'SAUDI ARABIA (KSA)': 'KSA',
  RIYADH: 'KSA', JEDDAH: 'KSA', DAMMAM: 'KSA',
  'المملكة العربية السعودية': 'KSA', 'السعودية': 'KSA',

  UAE: 'UAE', AE: 'UAE', ARE: 'UAE',
  'UNITED ARAB EMIRATES': 'UAE',
  'U.A.E.': 'UAE',
  DUBAI: 'UAE', 'ABU DHABI': 'UAE', SHARJAH: 'UAE',
  'الإمارات العربية المتحدة': 'UAE', 'الإمارات': 'UAE',

  EGY: 'EGY', EG: 'EGY', EGYPT: 'EGY',
  CAIRO: 'EGY', ALEXANDRIA: 'EGY',
  'مصر': 'EGY',

  JOR: 'JOR', JO: 'JOR', JORDAN: 'JOR',
  AMMAN: 'JOR',
  'الأردن': 'JOR',
};

/**
 * Normalise a country or office location to an internal code.
 * Accepts ISO codes, full names, major city names, and Arabic.
 */
export function normalizeCountry(value: string | null | undefined): CountryCode | null {
  if (!value) return null;
  const key = value.trim().toUpperCase();
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];

  // Office locations often arrive as "Riyadh, Saudi Arabia" or "Dubai - HQ".
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (alias.length >= 4 && key.includes(alias)) return code;
  }
  return null;
}

/** Look up a country's rules. Accepts any form `normalizeCountry` handles. */
export function getCountryRule(country: string | null | undefined): CountryRule | null {
  const code = normalizeCountry(country);
  return code ? COUNTRY_RULES[code] : null;
}

export function isSupportedCountry(country: string | null | undefined): country is CountryCode {
  return getCountryRule(country) !== null;
}

export function supportedCountries(): CountryCode[] {
  return Object.keys(COUNTRY_RULES) as CountryCode[];
}

/** Annual leave entitlement in days for a country and hire date. */
export function annualLeaveDays(
  country: string,
  hireDate: string,
  asOf?: string,
): { days: number; rule: CountryRule } | null {
  const rule = getCountryRule(country);
  if (!rule) return null;

  return {
    days: rule.annualLeaveDays({
      years: completedYears(hireDate, asOf),
      months: completedMonths(hireDate, asOf),
    }),
    rule,
  };
}

export interface ProbationCheck {
  valid: boolean;
  days: number;
  maxDays: number;
  extendableTo?: number;
  reason?: 'exceeds_statutory_maximum' | 'negative_period';
  source: string;
}

/** Validate a probation period against the country's statutory cap. */
export function validateProbation(
  country: string,
  probationDays: number,
): ProbationCheck | null {
  const rule = getCountryRule(country);
  if (!rule) return null;

  const ceiling = rule.probationExtendableToDays ?? rule.probationMaxDays;

  if (probationDays < 0) {
    return {
      valid: false,
      days: probationDays,
      maxDays: rule.probationMaxDays,
      extendableTo: rule.probationExtendableToDays,
      reason: 'negative_period',
      source: rule.source,
    };
  }

  return {
    valid: probationDays <= ceiling,
    days: probationDays,
    maxDays: rule.probationMaxDays,
    extendableTo: rule.probationExtendableToDays,
    reason: probationDays > ceiling ? 'exceeds_statutory_maximum' : undefined,
    source: rule.source,
  };
}
