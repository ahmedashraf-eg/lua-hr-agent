/**
 * sopRequests.ts — HR service requests.
 *
 * Workflow 3 of the brief. Answering "what is the transfer policy" is a
 * knowledge-base lookup and already lives in search_policies. This module
 * covers the other half: an employee who wants to actually *make* the request.
 *
 * Each request type carries its own SLA and owning department, because
 * "when will I get it" is the first thing every employee asks and the agent
 * should be able to answer without checking with anyone.
 *
 * Pure functions only. No I/O, no platform imports.
 */

import type { CountryCode } from './countryRules';

export type RequestType =
  | 'salary_certificate'
  | 'transfer'
  | 'exit_reentry_visa'
  | 'housing_allowance'
  | 'employment_letter'
  | 'iqama_renewal'
  | 'other';

export type RequestStatus =
  | 'submitted'
  | 'in_progress'
  | 'awaiting_employee'
  | 'completed'
  | 'rejected';

export interface RequestTypeSpec {
  type: RequestType;
  label: string;
  labelAr: string;
  owner: string;
  slaWorkingDays: number;
  /** Undefined means every country. */
  countries?: CountryCode[];
  /** Details the employee must supply, or the request stalls immediately. */
  requiredFields: Array<{ key: string; prompt: string; promptAr: string }>;
  policyId: string;
}

export const REQUEST_TYPES: Record<RequestType, RequestTypeSpec> = {
  salary_certificate: {
    type: 'salary_certificate',
    label: 'Salary certificate',
    labelAr: 'شهادة راتب',
    owner: 'People team',
    slaWorkingDays: 2,
    requiredFields: [
      { key: 'addressee', prompt: 'Who should the certificate be addressed to?', promptAr: 'إلى من توجَّه الشهادة؟' },
      { key: 'includeAllowances', prompt: 'Should it state basic salary only, or total package?', promptAr: 'هل تُذكر الراتب الأساسي فقط أم إجمالي الحزمة؟' },
    ],
    policyId: 'sop-salary-certificate',
  },

  employment_letter: {
    type: 'employment_letter',
    label: 'Employment verification letter',
    labelAr: 'خطاب تعريف بالعمل',
    owner: 'People team',
    slaWorkingDays: 2,
    requiredFields: [
      { key: 'addressee', prompt: 'Who should the letter be addressed to?', promptAr: 'إلى من يوجَّه الخطاب؟' },
    ],
    policyId: 'sop-salary-certificate',
  },

  transfer: {
    type: 'transfer',
    label: 'Internal transfer',
    labelAr: 'طلب نقل داخلي',
    owner: 'HR Business Partner',
    slaWorkingDays: 10,
    requiredFields: [
      { key: 'targetRole', prompt: 'Which role or department are you asking to move to?', promptAr: 'إلى أي وظيفة أو قسم ترغب في الانتقال؟' },
      { key: 'reason', prompt: 'Why are you requesting the transfer?', promptAr: 'ما سبب طلب النقل؟' },
    ],
    policyId: 'sop-transfer',
  },

  exit_reentry_visa: {
    type: 'exit_reentry_visa',
    label: 'Exit and re-entry visa',
    labelAr: 'تأشيرة خروج وعودة',
    owner: 'Government Relations',
    slaWorkingDays: 5,
    countries: ['KSA'],
    requiredFields: [
      { key: 'departureDate', prompt: 'What date do you leave?', promptAr: 'ما تاريخ المغادرة؟' },
      { key: 'returnDate', prompt: 'What date do you return?', promptAr: 'ما تاريخ العودة؟' },
      { key: 'entryType', prompt: 'Single entry or multiple entry?', promptAr: 'خروج وعودة مرة واحدة أم متعددة؟' },
    ],
    policyId: 'sop-exit-reentry',
  },

  iqama_renewal: {
    type: 'iqama_renewal',
    label: 'Iqama renewal',
    labelAr: 'تجديد الإقامة',
    owner: 'Government Relations',
    slaWorkingDays: 10,
    countries: ['KSA'],
    requiredFields: [],
    policyId: 'sop-exit-reentry',
  },

  housing_allowance: {
    type: 'housing_allowance',
    label: 'Housing allowance advance',
    labelAr: 'سلفة بدل السكن',
    owner: 'People team and Finance',
    slaWorkingDays: 7,
    requiredFields: [
      { key: 'amount', prompt: 'How much are you requesting as an advance?', promptAr: 'ما المبلغ المطلوب كسلفة؟' },
      { key: 'tenancyStart', prompt: 'When does the tenancy start?', promptAr: 'متى يبدأ عقد الإيجار؟' },
    ],
    policyId: 'sop-housing-allowance',
  },

  other: {
    type: 'other',
    label: 'General HR request',
    labelAr: 'طلب عام للموارد البشرية',
    owner: 'People team',
    slaWorkingDays: 5,
    requiredFields: [
      { key: 'details', prompt: 'What do you need?', promptAr: 'ما الذي تحتاجه؟' },
    ],
    policyId: 'sop-onboarding',
  },
};

export interface SopRequest {
  reference: string;
  type: RequestType;
  employeeId: string;
  employeeName: string;
  country: CountryCode;
  status: RequestStatus;
  details: Record<string, string>;
  owner: string;
  submittedAt: string;
  dueBy: string;
  completedAt?: string;
  note?: string;
}

export function getRequestType(type: string | null | undefined): RequestTypeSpec | null {
  if (!type) return null;
  return REQUEST_TYPES[type.trim().toLowerCase() as RequestType] ?? null;
}

/** Request types available to an employee in a given country. */
export function availableRequestTypes(country: CountryCode): RequestTypeSpec[] {
  return Object.values(REQUEST_TYPES).filter(
    (spec) => !spec.countries || spec.countries.includes(country),
  );
}

/**
 * A short human reference. Employees read these out over the phone, so it
 * avoids characters that are ambiguous when spoken or handwritten.
 */
export function makeReference(type: RequestType, seed = Date.now()): string {
  const prefix = {
    salary_certificate: 'SAL',
    employment_letter: 'EMP',
    transfer: 'TRF',
    exit_reentry_visa: 'VIS',
    iqama_renewal: 'IQR',
    housing_allowance: 'HSG',
    other: 'GEN',
  }[type];

  return `${prefix}-${String(seed).slice(-6)}`;
}

/**
 * Due date, counting working days only.
 *
 * The Gulf working week runs Sunday to Thursday, so Friday and Saturday are
 * skipped. Quoting a calendar-day SLA to an employee in Riyadh overpromises
 * by two days in most weeks.
 */
export function dueDate(from: string, workingDays: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  let remaining = workingDays;

  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0 Sun … 6 Sat
    const isWeekend = day === 5 || day === 6; // Friday, Saturday
    if (!isWeekend) remaining -= 1;
  }

  return d.toISOString().slice(0, 10);
}

export type RequestRejection =
  | 'unknown_type'
  | 'not_available_in_country'
  | 'missing_details';

export interface RequestValidation {
  ok: boolean;
  reason?: RequestRejection;
  message?: string;
  missing?: Array<{ key: string; prompt: string; promptAr: string }>;
  spec?: RequestTypeSpec;
}

/** Check a request is possible for this employee and has what it needs. */
export function validateRequest(input: {
  type: string;
  country: CountryCode;
  details: Record<string, string>;
}): RequestValidation {
  const spec = getRequestType(input.type);

  if (!spec) {
    return {
      ok: false,
      reason: 'unknown_type',
      message: `Unrecognised request type. Available: ${Object.keys(REQUEST_TYPES).join(', ')}.`,
    };
  }

  if (spec.countries && !spec.countries.includes(input.country)) {
    return {
      ok: false,
      reason: 'not_available_in_country',
      spec,
      message: `${spec.label} applies to ${spec.countries.join(', ')} only, and this employee is in ${input.country}.`,
    };
  }

  const missing = spec.requiredFields.filter(
    (f) => !input.details?.[f.key]?.toString().trim(),
  );

  if (missing.length) {
    return {
      ok: false,
      reason: 'missing_details',
      spec,
      missing,
      message: `Before this can be submitted, ${missing.length} more detail${missing.length === 1 ? ' is' : 's are'} needed.`,
    };
  }

  return { ok: true, spec };
}

export type StatusTransition = { ok: true } | { ok: false; message: string };

const TERMINAL: RequestStatus[] = ['completed', 'rejected'];

export function canTransition(from: RequestStatus, to: RequestStatus): StatusTransition {
  if (TERMINAL.includes(from)) {
    return { ok: false, message: `Request is already ${from} and cannot be changed.` };
  }
  if (from === to) {
    return { ok: false, message: `Request is already ${from}.` };
  }
  return { ok: true };
}

export interface SlaState {
  breached: boolean;
  workingDaysRemaining: number;
  dueBy: string;
}

/** Where a request sits against its SLA, as of a given date. */
export function slaState(request: SopRequest, asOf: string): SlaState {
  if (request.completedAt) {
    return { breached: request.completedAt > request.dueBy, workingDaysRemaining: 0, dueBy: request.dueBy };
  }

  let count = 0;
  const cursor = new Date(`${asOf}T00:00:00Z`);
  const due = new Date(`${request.dueBy}T00:00:00Z`);
  const overdue = cursor > due;

  const [start, end] = overdue ? [due, cursor] : [cursor, due];
  const walker = new Date(start);

  while (walker < end) {
    walker.setUTCDate(walker.getUTCDate() + 1);
    const day = walker.getUTCDay();
    if (day !== 5 && day !== 6) count += 1;
  }

  return {
    breached: overdue,
    workingDaysRemaining: overdue ? -count : count,
    dueBy: request.dueBy,
  };
}
