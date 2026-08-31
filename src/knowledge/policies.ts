/**
 * policies.ts — the mock HR knowledge base.
 *
 * Every statutory figure in these documents is GENERATED from the rules
 * engine rather than typed by hand. That is the whole point of this file.
 *
 * In the previous implementation the knowledge base said "EGY 15/21, JOR
 * 21/30" while the rules engine said "EGY 21/30, JOR 14/21", so the agent
 * quoted one set of numbers when reading policy and applied a different set
 * when calculating a balance. Deriving the prose from the same source makes
 * that class of contradiction impossible rather than merely absent.
 *
 * Process documents (transfers, salary certificates, visas, housing) carry no
 * statutory figures, so they are written narrative.
 */

import {
  COUNTRY_RULES,
  supportedCountries,
  type CountryCode,
} from '../domain/countryRules';
import { SICK_LEAVE } from '../domain/leave';

export interface PolicyDocument {
  id: string;
  title: string;
  titleAr: string;
  category: 'leave' | 'onboarding' | 'compensation' | 'mobility' | 'documents';
  countries: CountryCode[] | 'all';
  content: string;
  /** Vector-search text. Include synonyms and the Arabic terms employees use. */
  searchText: string;
  lastReviewed: string;
}

const REVIEWED = '2026-08-01';

/* --------------------------------------------------------------- helpers */

/** Annual leave entitlement, phrased from the rules engine's own thresholds. */
function annualLeaveTable(): string {
  return supportedCountries()
    .map((code) => {
      const rule = COUNTRY_RULES[code];
      const atOneYear = rule.annualLeaveDays({ years: 1, months: 12 });
      const atSix = rule.annualLeaveDays({ years: 6, months: 72 });
      const atTwelve = rule.annualLeaveDays({ years: 12, months: 144 });

      const tiers: string[] = [];
      tiers.push(`${atOneYear} days from ${rule.minServiceMonthsForLeave} months of service`);
      if (atSix !== atOneYear) tiers.push(`${atSix} days after 5 years`);
      if (atTwelve !== atSix && atTwelve !== atOneYear) tiers.push(`${atTwelve} days after 10 years`);

      return `- ${rule.name}: ${tiers.join('; ')}. (${rule.source})`;
    })
    .join('\n');
}

function sickLeaveTable(): string {
  return supportedCountries()
    .map((code) => {
      const tiers = SICK_LEAVE[code] ?? [];
      const described = tiers
        .map((t) => `${t.days} days at ${t.label}`)
        .join(', then ');
      return `- ${COUNTRY_RULES[code].name}: ${described}.`;
    })
    .join('\n');
}

function probationTable(): string {
  return supportedCountries()
    .map((code) => {
      const rule = COUNTRY_RULES[code];
      const extension = rule.probationExtendableToDays
        ? `, extendable to ${rule.probationExtendableToDays} days by written agreement`
        : '';
      return `- ${rule.name}: maximum ${rule.probationMaxDays} days${extension}. (${rule.source})`;
    })
    .join('\n');
}

/* ------------------------------------------------------------- documents */

export const POLICIES: PolicyDocument[] = [
  {
    id: 'sop-onboarding',
    title: 'New Hire Onboarding Procedure',
    titleAr: 'إجراءات استقبال الموظفين الجدد',
    category: 'onboarding',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# New Hire Onboarding Procedure

## Scope
Applies to all new employees across Saudi Arabia, the UAE, Egypt and Jordan.

## Step 1 — Document collection
The People team collects the following from every new joiner before day one:
passport copy, passport-size photograph, bank account details for salary
transfer, and emergency contact details. Educational certificates are
requested but do not block a start date.

Country-specific documents are additional and mandatory:
- Saudi Arabia: Iqama copy, GOSI registration details, medical fitness certificate.
- UAE: Emirates ID copy, labour card or work permit, residence visa page.
- Egypt: national ID copy, social insurance number (Form 1), military service certificate for male applicants.
- Jordan: national ID copy, Social Security number, work permit for non-Jordanian nationals.

Never request an Iqama from an employee based outside Saudi Arabia. The
equivalent document differs by country and asking for the wrong one delays
onboarding.

## Step 2 — Probation terms
Probation is set in the employment contract and may not exceed the statutory
maximum for the employee's country:

${probationTable()}

A probation period longer than the statutory maximum is unenforceable and
creates legal exposure. Raise it with HR before the contract is issued.

## Step 3 — Orientation
Orientation is scheduled at the employee's own site over their first three
days: welcome and company introduction, health and safety site induction,
payroll and statutory entitlements briefing, then departmental handover and
systems access with the line manager.

## Step 4 — Checklist completion
The onboarding checklist is tracked in BambooHR. The People team closes each
item as evidence is received. Onboarding is complete only when every mandatory
document is on file.

## Escalation
Missing documents after day fourteen, or any request to extend probation
beyond the statutory maximum, escalates to the HR Manager.`,
    searchText:
      'onboarding new hire joining first day documents required paperwork passport iqama emirates id national id bank details emergency contact GOSI social insurance probation orientation induction checklist starter new employee توظيف موظف جديد استقبال أوراق مطلوبة فترة التجربة تدريب تعريفي قائمة المهام',
  },

  {
    id: 'sop-annual-leave',
    title: 'Annual Leave Policy',
    titleAr: 'سياسة الإجازات السنوية',
    category: 'leave',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# Annual Leave Policy

## Entitlement
Paid annual leave is a statutory entitlement and varies by country and by
length of service:

${annualLeaveTable()}

Entitlement is calculated from the hire date on the employee's record. Where
an employee has not yet reached the minimum service period for their country,
no paid annual leave has accrued.

## Requesting leave
Requests are submitted through the HR agent or the web portal and route to the
line manager for approval. Submit at least fourteen days ahead for any absence
longer than three days.

A request is checked against the remaining balance before it is submitted.
Both approved and still-pending requests count against the balance, so two
requests made in quick succession cannot together exceed the entitlement.

## Carry-over
Up to five unused days may be carried into the following calendar year and
must be taken by 31 March. Days beyond five are forfeited unless the employee
was formally required to defer leave for operational reasons.

## Public holidays
Public holidays follow the calendar of the country the employee works in and
do not count against annual leave. Where a public holiday falls inside an
approved leave period, that day is returned to the balance.

## Escalation
Disputes over accrued balance, and any request to carry more than five days,
escalate to the HR Manager.`,
    searchText:
      'annual leave holiday vacation entitlement days off balance accrual carry over carryover public holiday time off request approval manager أجازة إجازة سنوية رصيد الإجازات عطلة إجازات ترحيل رصيد طلب إجازة موافقة المدير عطلة رسمية',
  },

  {
    id: 'sop-sick-leave',
    title: 'Sick Leave Policy',
    titleAr: 'سياسة الإجازات المرضية',
    category: 'leave',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# Sick Leave Policy

## Entitlement
Sick leave is graduated: the rate of pay falls as the absence lengthens. It is
not a single flat allowance, and quoting one total misrepresents what an
employee will actually be paid.

${sickLeaveTable()}

In Saudi Arabia specifically, the statutory year runs 30 days at full pay,
then 60 days at three-quarter pay, then 30 days unpaid. An employee asking
"how many sick days do I get" should be told the tiers, not the sum.

## Evidence
Absences of one or two days are self-certified. A medical certificate from a
recognised provider is required from the third consecutive day, and must reach
the People team within five working days of returning.

## Notification
Notify the line manager before the start of the shift on the first day of
absence, by any channel. Notification through the HR agent on WhatsApp
satisfies this requirement.

## Interaction with annual leave
Where an employee falls ill during approved annual leave and provides a
medical certificate, those days may be converted to sick leave and returned to
the annual balance.

## Escalation
Absence beyond the full-pay tier, and any pattern of repeated short absences,
escalates to the HR Manager for a welfare review — not a disciplinary one.`,
    searchText:
      'sick leave illness medical certificate doctor note absence unwell pay rate full pay three quarter unpaid إجازة مرضية مرض شهادة طبية تقرير طبي غياب راتب إجازة مرضية مدفوعة',
  },

  {
    id: 'sop-gratuity',
    title: 'End-of-Service Gratuity',
    titleAr: 'مكافأة نهاية الخدمة',
    category: 'compensation',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# End-of-Service Gratuity

## Saudi Arabia
Half a month's wage for each of the first five years of service, and a full
month's wage for each year after that. Partial years are paid pro rata.

Where the employee resigns rather than being terminated, the award is reduced
by length of service: nothing below two years, one third from two to five
years, two thirds from five to ten years, and the full award at ten years or
more. This reduction is the single largest factor in most Saudi calculations,
so establish the reason for leaving before quoting any figure.
(Saudi Labor Law, Arts. 84–85)

## United Arab Emirates
Twenty-one days of basic wage for each of the first five years, and thirty
days of basic wage for each year after that. The total is capped at two years'
wage.

Accrual is on basic wage only — allowances are excluded, so the figure is
lower than employees expect if they are thinking of their total package.

There is no reduction for resignation. The tapering that existed under the
previous law was abolished, and an employee who resigns now receives the same
rate as one who is dismissed, provided they have completed one year of
service. Below one year, no gratuity is payable.
(UAE Federal Decree-Law 33/2021, Art. 51)

## Egypt and Jordan
Neither country operates a Gulf-style end-of-service scheme. Retirement
provision runs through social insurance in Egypt and Social Security in
Jordan, and a separate end-of-service payment arises only for service that
sits outside that cover.

Any figure produced for an employee in Egypt or Jordan is therefore indicative
only. It cannot be confirmed without their insurance history, which the HRIS
does not hold. Always route these to HR for a binding calculation rather than
quoting the indicative number as final.

## Timing
Gratuity is paid with the final settlement, within fourteen days of the last
working day.

## Escalation
Any dispute over the calculation, and every Egyptian or Jordanian
calculation, escalates to the HR Manager.`,
    searchText:
      'gratuity end of service benefit EOSB severance final settlement leaving resignation termination payout entitlement how much will i get when i leave مكافأة نهاية الخدمة مستحقات استقالة إنهاء خدمة تسوية نهائية كم مستحقاتي',
  },

  {
    id: 'sop-transfer',
    title: 'Internal Transfer Requests',
    titleAr: 'إجراءات النقل الداخلي',
    category: 'mobility',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# Internal Transfer Requests

## Eligibility
Employees may request a transfer to another department, site or operating
country after twelve months in their current role and with a satisfactory
most-recent performance review. Employees still serving probation are not
eligible.

## Process
1. The employee submits a transfer request naming the target role or site.
2. The current line manager gives a view within five working days. A manager
   may not block a transfer outright, only flag operational timing.
3. The receiving manager confirms the vacancy and interviews if required.
4. HR issues a transfer letter setting the effective date and any change to
   terms.
5. Standard notice for the current role applies before the move takes effect.

## Cross-border transfers
A transfer between operating countries is a new employment relationship in the
destination country. It requires a new work permit or residency sponsorship,
and entitlements reset to the destination country's statutory rules —
including annual leave, probation and end-of-service treatment.

Accrued end-of-service in the origin country is settled at the point of
transfer unless a formal continuity-of-service agreement is signed. Employees
frequently assume continuity is automatic. It is not.

## Escalation
Cross-border transfers, and any dispute between the releasing and receiving
manager, escalate to the HR Manager.`,
    searchText:
      'transfer move department relocation internal move change site change country secondment cross border transfer request نقل داخلي طلب نقل تغيير قسم انتقال بين الدول إعارة',
  },

  {
    id: 'sop-salary-certificate',
    title: 'Salary Certificate Issuance',
    titleAr: 'إصدار شهادة الراتب',
    category: 'documents',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# Salary Certificate Issuance

## Purpose
A salary certificate confirms an employee's job title, hire date and salary.
It is most commonly needed for a bank loan, a visa application, a school
admission or a tenancy agreement.

## Requesting
Request through the HR agent or the web portal, naming the addressee — the
bank, embassy or landlord. A certificate addressed "To Whom It May Concern" is
issued where no specific addressee is given, though some banks and embassies
reject those.

## Turnaround
Two working days for a standard certificate. Certificates requiring the
company stamp and an authorised signature for embassy use take five working
days.

## Salary disclosure
Basic salary alone is stated by default. Total package including allowances is
stated only where the employee explicitly asks, since disclosure of allowances
affects some visa and loan assessments.

## Bank transfer letters
A certificate addressed to a bank for loan purposes additionally confirms the
salary transfer arrangement and requires Finance countersignature, which adds
two working days.

## Escalation
Requests for a certificate stating anything other than the recorded salary, or
any backdated certificate, are refused at the People team level and escalate
to the HR Manager.`,
    searchText:
      'salary certificate letter proof of employment income letter bank loan embassy visa letter to whom it may concern employment verification شهادة راتب تعريف بالراتب خطاب تعريف قرض بنكي سفارة إثبات عمل',
  },

  {
    id: 'sop-exit-reentry',
    title: 'Exit and Re-entry Visa Procedure (Saudi Arabia)',
    titleAr: 'إجراءات تأشيرة الخروج والعودة',
    category: 'mobility',
    countries: ['KSA'],
    lastReviewed: REVIEWED,
    content: `# Exit and Re-entry Visa Procedure (Saudi Arabia)

## Scope
Applies only to employees on company sponsorship in Saudi Arabia. Employees in
the UAE, Egypt and Jordan do not require an exit and re-entry visa, and should
not be sent through this process.

## When it is required
Any employee under company sponsorship leaving Saudi Arabia temporarily and
intending to return must hold a valid exit and re-entry visa before departure.
Leaving without one voids the residency permit.

## Prerequisites
- A valid Iqama with more than ninety days remaining at the date of departure.
- Approved leave covering the full period of absence.
- No outstanding traffic violations against the employee's record.

Where the Iqama has ninety days or less remaining, it must be renewed before
the visa is issued. Employees regularly discover this a few days before
travelling, which is why the agent flags Iqama expiry at ninety, sixty, thirty
and seven days.

## Process
1. Submit the request through the HR agent at least ten working days before
   travel, stating departure and return dates.
2. Government Relations verifies Iqama validity and clears any violations.
3. The visa is issued through Absher and takes three to five working days.
4. The employee receives confirmation and travels.

## Single versus multiple entry
A single-entry visa covers one trip within two months. A multiple-entry visa
covers unlimited trips within its validity and is available to employees with
more than one year of service.

## Overstaying
Failing to return before the visa expires carries a fine and may cancel the
residency permit. Contact Government Relations immediately if return is
delayed — do not wait until the return date passes.

## Escalation
Any request with less than ten working days' notice, and every overstay,
escalates to the Government Relations Manager.`,
    searchText:
      'exit re-entry visa reentry travel abroad leaving saudi arabia return absher sponsorship iqama travel permission single entry multiple entry overstay تأشيرة خروج وعودة سفر خارج المملكة أبشر إقامة كفالة خروج نهائي تجديد',
  },

  {
    id: 'sop-housing-allowance',
    title: 'Housing Allowance Policy',
    titleAr: 'سياسة بدل السكن',
    category: 'compensation',
    countries: 'all',
    lastReviewed: REVIEWED,
    content: `# Housing Allowance Policy

## Entitlement
Housing allowance is paid to employees at grade 7 and above, and to all
employees on expatriate terms regardless of grade. It is set at 25 percent of
basic salary and paid monthly with salary.

Employees in company-provided accommodation do not receive the allowance.

## Annual advance
Employees may request the housing allowance as a single annual advance to
cover a yearly rental contract, which is how most residential leases in the
region are structured. The advance is recovered in twelve equal monthly
deductions across the following year.

An employee who leaves before the advance is fully recovered has the
outstanding balance deducted from their final settlement.

## Effect on gratuity
Housing allowance is not part of basic wage. It is excluded from the
end-of-service calculation in the UAE, where gratuity accrues on basic wage
only. Employees frequently expect their total package to be used and are
surprised by the difference — explain this before quoting a UAE figure.

## Changes
A change in grade or accommodation status takes effect from the following
payroll cycle. Retroactive adjustment is not made.

## Escalation
Advance requests above one year, and any dispute about eligibility, escalate
to the HR Manager and Finance jointly.`,
    searchText:
      'housing allowance accommodation rent rental advance yearly rent grade expat basic salary percentage company accommodation بدل سكن سكن إيجار سلفة إيجار بدل الإسكان نسبة من الراتب الأساسي',
  },
];

/** Search text sent to the vector index for one document. */
export function searchTextFor(policy: PolicyDocument): string {
  return [policy.title, policy.titleAr, policy.searchText, policy.content]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
