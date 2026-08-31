/**
 * GratuityTool.ts — end-of-service gratuity.
 *
 * `reason` is a required input, not a default. In Saudi Arabia the difference
 * between resigning and being dismissed can be the entire award, so the agent
 * must establish which one applies before it can answer at all.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import { calculateGratuity } from '../domain/gratuity';
import { money, resolveSubject } from './shared';

export class CalculateGratuityTool implements LuaTool {
  name = 'calculate_gratuity';
  description =
    'Calculate end-of-service gratuity for an employee, applying their country’s statutory formula';

  inputSchema = z.object({
    employeeId: z.string().optional().describe('Omit this for the person you are talking to — their identity is taken from their verified account, never from the conversation. Supply it only when an HR user, or a line manager asking about their own report, names someone else.'),
    reason: z
      .enum(['resignation', 'termination'])
      .describe(
        'Whether the employee is resigning or their employment is being terminated. Required — in Saudi Arabia this changes the award substantially, so ask if it is not clear.',
      ),
    lastWorkingDay: z
      .string()
      .optional()
      .describe('Last working day, YYYY-MM-DD. Defaults to today.'),
    monthlyWage: z
      .number()
      .optional()
      .describe('Override the wage on record, when the HRIS does not hold it'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveSubject(input.employeeId, 'view_entitlements');
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;
    const wage = input.monthlyWage ?? employee.monthlyWage;

    if (!wage) {
      return {
        ok: false,
        error: 'wage_not_available',
        detail: `No monthly wage is recorded for ${employee.displayName}, and gratuity cannot be calculated without it.`,
        action: 'Ask HR to complete the compensation record, or ask the employee to confirm their monthly wage.',
      };
    }

    const result = calculateGratuity({
      country: rule.code,
      hireDate: employee.hireDate,
      endDate: input.lastWorkingDay,
      monthlyWage: wage,
      basicMonthlyWage: employee.basicMonthlyWage,
      reason: input.reason,
    });

    if (!result) {
      return {
        ok: false,
        error: 'unsupported_country',
        detail: `No gratuity rules are configured for ${rule.name}.`,
        action: 'Escalate to HR.',
      };
    }

    return {
      ok: true,
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: result.country,
      currency: result.currency,
      reason: result.reason,
      yearsOfService: result.years,

      /** Null where entitlement genuinely cannot be stated — Egypt, Jordan. */
      amount: result.amount === null ? null : money(result.amount),
      indicativeAmount: result.conditional ? money(result.grossAmount) : undefined,
      conditional: result.conditional,

      grossBeforeReduction: money(result.grossAmount),
      reductionApplied: result.reductionFactor < 1,
      reductionFactor: result.reductionFactor,
      cappedAtTwoYearsWage: result.capApplied,

      explanation: result.note,
      source: result.source,

      // The agent must not present a conditional figure as final.
      agentGuidance: result.conditional
        ? 'State this as indicative only, explain why it depends on social-insurance history, and offer to escalate to HR for a binding figure.'
        : 'This is a firm figure. Quote it with the statutory basis.',
    };
  }
}
