/**
 * IqamaTool.ts — Iqama expiry checks.
 *
 * The Iqama is the Saudi residency permit and has no counterpart in the other
 * three countries. When a non-Saudi employee asks, the tool says so explicitly
 * rather than returning "no alerts", which would read as reassurance.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import { checkIqama } from '../domain/iqama';
import { resolveEmployee } from './shared';

export class CheckIqamaExpiryTool implements LuaTool {
  name = 'check_iqama_expiry';
  description =
    'Check when a Saudi-based employee’s Iqama expires and how urgent renewal is';

  inputSchema = z.object({
    employeeId: z.string().describe('The BambooHR employee ID'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveEmployee(input.employeeId);
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;

    const result = checkIqama({
      id: employee.id,
      displayName: employee.displayName,
      country: rule.code,
      iqamaNumber: employee.iqamaNumber,
      iqamaExpiry: employee.iqamaExpiry,
    });

    if (!result.applicable) {
      return {
        ok: true,
        applicable: false,
        employeeId: employee.id,
        employeeName: employee.displayName,
        country: rule.code,
        reason: result.reason,
        explanation: result.message,
        agentGuidance:
          result.reason === 'not_saudi'
            ? 'Explain that Iqama tracking is specific to Saudi Arabia. Do not imply their documents are fine — you have not checked anything.'
            : 'Tell the employee the record is incomplete and offer to escalate to HR.',
      };
    }

    if (!result.alert) {
      return {
        ok: true,
        applicable: true,
        employeeId: employee.id,
        employeeName: employee.displayName,
        iqamaExpiry: employee.iqamaExpiry,
        daysRemaining: result.daysRemaining,
        alert: null,
        explanation: `Iqama is valid for another ${result.daysRemaining} days. No action needed yet.`,
      };
    }

    return {
      ok: true,
      applicable: true,
      employeeId: employee.id,
      employeeName: employee.displayName,
      iqamaExpiry: result.alert.iqamaExpiry,
      daysRemaining: result.alert.daysRemaining,
      severity: result.alert.severity,
      alert: {
        en: result.alert.message,
        ar: result.alert.messageAr,
      },
      agentGuidance:
        result.alert.severity === 'expired'
          ? 'This is urgent and carries legal exposure for the employee. Escalate to HR in the same reply.'
          : 'Tell the employee how long they have and what to do next.',
    };
  }
}
