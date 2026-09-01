/**
 * OnboardingTools.ts — new-hire onboarding.
 *
 * The document list is country-specific because the paperwork genuinely is:
 * a Saudi hire needs an Iqama copy and GOSI registration, an Emirati hire
 * needs an Emirates ID and a labour card, and asking a Cairo joiner for an
 * Iqama is the kind of error that makes an HR agent untrustworthy.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import type { CountryCode } from '../domain/countryRules';
import { daysBetween } from '../domain/tenure';
import { resolveSubject } from './shared';

interface DocumentRequirement {
  id: string;
  label: string;
  labelAr: string;
  mandatory: boolean;
}

const UNIVERSAL_DOCUMENTS: DocumentRequirement[] = [
  { id: 'passport', label: 'Passport copy', labelAr: 'صورة جواز السفر', mandatory: true },
  { id: 'photo', label: 'Passport-size photograph', labelAr: 'صورة شخصية', mandatory: true },
  { id: 'bank_details', label: 'Bank account details for salary transfer', labelAr: 'بيانات الحساب البنكي لتحويل الراتب', mandatory: true },
  { id: 'emergency_contact', label: 'Emergency contact details', labelAr: 'بيانات جهة الاتصال في حالات الطوارئ', mandatory: true },
  { id: 'qualifications', label: 'Educational certificates', labelAr: 'الشهادات العلمية', mandatory: false },
];

const COUNTRY_DOCUMENTS: Record<CountryCode, DocumentRequirement[]> = {
  KSA: [
    { id: 'iqama', label: 'Iqama copy (residency permit)', labelAr: 'صورة الإقامة', mandatory: true },
    { id: 'gosi', label: 'GOSI registration details', labelAr: 'بيانات التسجيل في التأمينات الاجتماعية', mandatory: true },
    { id: 'medical', label: 'Medical fitness certificate', labelAr: 'شهادة اللياقة الطبية', mandatory: true },
  ],
  UAE: [
    { id: 'emirates_id', label: 'Emirates ID copy', labelAr: 'صورة الهوية الإماراتية', mandatory: true },
    { id: 'labour_card', label: 'Labour card / work permit', labelAr: 'بطاقة العمل / تصريح العمل', mandatory: true },
    { id: 'visa', label: 'Residence visa page', labelAr: 'صفحة تأشيرة الإقامة', mandatory: true },
  ],
  EGY: [
    { id: 'national_id', label: 'National ID copy', labelAr: 'صورة بطاقة الرقم القومي', mandatory: true },
    { id: 'social_insurance', label: 'Social insurance number (Form 1)', labelAr: 'رقم التأمينات الاجتماعية (استمارة ١)', mandatory: true },
    { id: 'military', label: 'Military service certificate (male applicants)', labelAr: 'شهادة الموقف من التجنيد', mandatory: true },
    { id: 'criminal_record', label: 'Criminal record certificate', labelAr: 'صحيفة الحالة الجنائية', mandatory: false },
  ],
  JOR: [
    { id: 'national_id', label: 'National ID copy', labelAr: 'صورة الهوية الشخصية', mandatory: true },
    { id: 'social_security', label: 'Social Security number', labelAr: 'رقم الضمان الاجتماعي', mandatory: true },
    { id: 'work_permit', label: 'Work permit (non-Jordanian nationals)', labelAr: 'تصريح العمل لغير الأردنيين', mandatory: true },
  ],
};

/** Orientation is scheduled by office, not by country — sites differ. */
function orientationFor(location: string | undefined, country: CountryCode) {
  const site = location?.split(/[,\-–]/)[0]?.trim() || 'the regional office';
  return {
    site,
    sessions: [
      { day: 1, title: 'Welcome and company introduction', owner: 'People team' },
      { day: 1, title: 'Health, safety and site induction', owner: 'HSE officer' },
      { day: 2, title: `Payroll, benefits and ${country} statutory entitlements`, owner: 'Payroll' },
      { day: 3, title: 'Department handover and systems access', owner: 'Line manager' },
    ],
  };
}

export class StartOnboardingTool implements LuaTool {
  name = 'start_onboarding';
  description =
    'Begin onboarding for a new hire: list the documents they must provide, their probation terms, and their orientation schedule';

  inputSchema = z.object({
    employeeId: z.string().optional().describe('Omit this for the person you are talking to — their identity is taken from their verified account, never from the conversation. Supply it only when an HR user, or a line manager asking about their own report, names someone else.'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveSubject(input.employeeId, 'view_record');
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;

    const documents = [
      ...UNIVERSAL_DOCUMENTS,
      ...(COUNTRY_DOCUMENTS[rule.code] ?? []),
    ];

    const daysSinceHire = daysBetween(employee.hireDate, new Date().toISOString().slice(0, 10));

    return {
      ok: true,
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: { code: rule.code, name: rule.name, nameAr: rule.nameAr },
      hireDate: employee.hireDate,
      daysSinceHire,

      // English labels only. The Arabic exists in the domain for reference,
      // but returning both lets the tool decide what the employee reads —
      // which belongs to the persona, and in practice picks the wrong one.
      documents: {
        mandatory: documents.filter((d) => d.mandatory).map((d) => ({ id: d.id, label: d.label })),
        optional: documents.filter((d) => !d.mandatory).map((d) => ({ id: d.id, label: d.label })),
        total: documents.length,
      },

      probation: {
        maximumDays: rule.probationMaxDays,
        extendableToDays: rule.probationExtendableToDays ?? null,
        note: `${rule.name} permits up to ${rule.probationMaxDays} days of probation${
          rule.probationExtendableToDays
            ? `, extendable to ${rule.probationExtendableToDays} by written agreement`
            : ''
        }.`,
      },

      orientation: orientationFor(employee.location, rule.code),

      firstLeaveEligibility: `Paid annual leave accrues after ${rule.minServiceMonthsForLeave} months of service in ${rule.name}.`,
      source: rule.source,

      agentGuidance:
        'Walk the new hire through the mandatory documents first, in their own language. Mention the optional ones only if they ask. Do not ask a non-Saudi hire for an Iqama or a non-Emirati hire for an Emirates ID — the list above is already filtered for their country.',
    };
  }
}
