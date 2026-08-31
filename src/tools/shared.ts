/**
 * shared.ts — helpers common to every tool.
 *
 * The single most important rule in this layer: no tool ever assumes whose
 * record it is looking at. Every one takes an employeeId as an input, the
 * model extracts it from conversation, and there is nowhere to hardcode a
 * default. The previous implementation resolved every request to the same
 * employee regardless of who was asking, which is the failure this prevents.
 */

import { BambooError, getEmployee, type Employee } from '../integrations/bamboo';
import { getCountryRule, type CountryRule } from '../domain/countryRules';

/** A refusal the agent can read out verbatim, rather than a thrown stack. */
export interface Refusal {
  ok: false;
  error: string;
  detail: string;
  action: string;
}

export interface Resolved {
  ok: true;
  employee: Employee;
  rule: CountryRule;
}

function refuse(error: string, detail: string, action: string): Refusal {
  return { ok: false, error, detail, action };
}

/**
 * Load an employee and confirm their country is one the rules engine covers.
 *
 * Returns a structured refusal rather than throwing, so the agent explains
 * the problem in the employee's own language instead of surfacing an error.
 */
export async function resolveEmployee(employeeId: string): Promise<Resolved | Refusal> {
  let employee: Employee;

  try {
    employee = await getEmployee(employeeId);
  } catch (error) {
    if (error instanceof BambooError && error.status === 404) {
      return refuse(
        'employee_not_found',
        `No employee with ID ${employeeId} exists in BambooHR.`,
        'Ask the employee to confirm their employee ID, or look them up by name first.',
      );
    }
    if (error instanceof BambooError) {
      return refuse('hris_unavailable', error.message, 'Tell the employee HR systems are briefly unavailable and to try again shortly.');
    }
    throw error;
  }

  if (!employee.hireDate) {
    return refuse(
      'incomplete_record',
      `${employee.displayName} has no hire date recorded, and every entitlement is calculated from it.`,
      'Escalate to HR to complete the employee record before answering.',
    );
  }

  const rule = getCountryRule(employee.country);
  if (!rule) {
    return refuse(
      'unsupported_country',
      `${employee.displayName} is recorded in "${employee.countryRaw ?? 'an unknown location'}", which is outside the four countries this agent covers.`,
      'Escalate to HR. Do not estimate entitlements for countries the rules engine does not cover.',
    );
  }

  return { ok: true, employee, rule };
}

/** Round money to two places without floating-point noise in the output. */
export function money(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** The channel this request arrived on, where the runtime exposes it. */
export function currentChannel(): string {
  try {
    const lua = (globalThis as { Lua?: { request?: { channel?: string } } }).Lua;
    return lua?.request?.channel ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
