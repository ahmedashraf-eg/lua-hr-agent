/**
 * EmployeeTools.ts — employee lookup and probation validation.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import { validateProbation } from '../domain/countryRules';
import { completedMonths, completedYears, daysBetween, tenureYears } from '../domain/tenure';
import { resolveSubject } from './shared';

export class GetEmployeeTool implements LuaTool {
  name = 'get_employee';
  description = 'Look up an employee record, including country, tenure and job details';

  inputSchema = z.object({
    employeeId: z.string().optional().describe('Omit this for the person you are talking to — their identity is taken from their verified account, never from the conversation. Supply it only when an HR user, or a line manager asking about their own report, names someone else.'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveSubject(input.employeeId, 'view_record');
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;

    return {
      ok: true,
      employee: {
        id: employee.id,
        name: employee.displayName,
        jobTitle: employee.jobTitle,
        department: employee.department,
        manager: employee.supervisor,
        location: employee.location,
        workEmail: employee.workEmail,
      },
      country: { code: rule.code, name: rule.name, nameAr: rule.nameAr },
      service: {
        hireDate: employee.hireDate,
        years: Number(tenureYears(employee.hireDate).toFixed(2)),
        completedYears: completedYears(employee.hireDate),
        completedMonths: completedMonths(employee.hireDate),
      },
      /** Present so the agent can say "the Iqama tool does not apply here". */
      iqamaApplicable: rule.usesIqama,
    };
  }
}

export class CheckProbationTool implements LuaTool {
  name = 'check_probation';
  description =
    'Check whether a probation period is lawful for the employee’s country, and when it ends';

  inputSchema = z.object({
    employeeId: z.string().optional().describe('Omit this for the person you are talking to — their identity is taken from their verified account, never from the conversation. Supply it only when an HR user, or a line manager asking about their own report, names someone else.'),
    probationEndDate: z
      .string()
      .optional()
      .describe('Proposed probation end date, YYYY-MM-DD. Defaults to the statutory maximum.'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveSubject(input.employeeId, 'view_record');
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;

    if (!input.probationEndDate) {
      return {
        ok: true,
        employeeId: employee.id,
        country: rule.code,
        statutoryMaximumDays: rule.probationMaxDays,
        extendableToDays: rule.probationExtendableToDays ?? null,
        note: rule.probationExtendableToDays
          ? `${rule.name} allows ${rule.probationMaxDays} days, extendable to ${rule.probationExtendableToDays} by written agreement.`
          : `${rule.name} allows a maximum of ${rule.probationMaxDays} days.`,
        source: rule.source,
      };
    }

    let days: number;
    try {
      days = daysBetween(employee.hireDate, input.probationEndDate);
    } catch {
      return {
        ok: false,
        error: 'invalid_date',
        detail: 'The probation end date must be in YYYY-MM-DD format.',
        action: 'Ask for the date again.',
      };
    }

    const check = validateProbation(rule.code, days)!;

    return {
      ok: true,
      employeeId: employee.id,
      country: rule.code,
      hireDate: employee.hireDate,
      probationEndDate: input.probationEndDate,
      probationDays: days,
      lawful: check.valid,
      statutoryMaximumDays: check.maxDays,
      extendableToDays: check.extendableTo ?? null,
      reason: check.reason ?? null,
      note: check.valid
        ? 'Within the statutory limit.'
        : `A ${days}-day probation exceeds what ${rule.name} permits. Shorten it before the contract is issued.`,
      source: check.source,
    };
  }
}
