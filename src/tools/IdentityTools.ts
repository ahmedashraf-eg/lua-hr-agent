/**
 * IdentityTools.ts — establishing who the agent is talking to.
 *
 * Every other tool depends on this having run. Until a channel identity is
 * bound to a personnel record, the agent knows a phone number and nothing
 * else, and refuses to read anybody's record.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import { capabilitiesOf } from '../domain/authorization';
import { attemptAutoBind, bindByChallenge, challengeState, clearBinding, getCaller } from './identity';

export class VerifyIdentityTool implements LuaTool {
  name = 'verify_my_identity';
  description =
    'Establish which employee is talking to you. Call this first, with no arguments, before any tool that reads a personnel record.';

  inputSchema = z.object({
    employeeId: z
      .string()
      .optional()
      .describe('Only when automatic recognition failed and the employee has told you their ID'),
    hireDate: z
      .string()
      .optional()
      .describe('Their start date, YYYY-MM-DD. Required alongside employeeId.'),
    startOver: z
      .boolean()
      .optional()
      .default(false)
      .describe('Clear an existing binding — use only if the employee says you have the wrong person'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    if (input.startOver) {
      await clearBinding();
    }

    /* ------------------------------------------- already established */
    if (!input.startOver) {
      const existing = await getCaller();
      if (existing.verified) {
        return {
          ok: true,
          alreadyVerified: true,
          employeeId: existing.caller.employeeId,
          name: existing.caller.displayName,
          role: existing.caller.role,
          agentGuidance: 'Identity was already confirmed. Carry on with what they asked for.',
        };
      }
    }

    /* ------------------------------------------------ challenge path */
    if (input.employeeId) {
      if (!input.hireDate) {
        return {
          ok: false,
          error: 'hire_date_required',
          detail: 'An employee ID on its own is not proof of identity.',
          action: 'Ask for their start date in YYYY-MM-DD, then call this tool again with both.',
        };
      }

      const result = await bindByChallenge(input.employeeId, input.hireDate);

      if (!result.bound && result.reason === 'locked_out') {
        return {
          ok: false,
          error: 'locked_out',
          detail: `Too many failed attempts. Verification is locked until ${result.unlocksAt}.`,
          action:
            'Tell them verification is temporarily locked and hand them to HR. Do not offer another attempt, and do not try this tool again for them.',
        };
      }

      if (!result.bound) {
        return {
          ok: false,
          error: 'verification_failed',
          detail: 'Those details do not match a personnel record.',
          attemptsRemaining: result.attemptsRemaining,
          action:
            result.attemptsRemaining <= 1
              ? 'Say the details did not match and that this is their last attempt before verification locks. Do not say which part was wrong.'
              : 'Say the details did not match, without saying which part was wrong. Offer another attempt. Never confirm whether that employee ID exists.',
        };
      }

      return {
        ok: true,
        verified: true,
        method: 'challenge',
        employeeId: result.employee.id,
        name: result.employee.displayName,
        agentGuidance: 'Greet them by name and continue with whatever they originally asked for.',
      };
    }

    /* ----------------------------------------------- automatic path */
    const auto = await attemptAutoBind();

    if (auto.bound) {
      return {
        ok: true,
        verified: true,
        method: auto.method,
        employeeId: auto.employee.id,
        name: auto.employee.displayName,
        recognisedBy: auto.method === 'work_email' ? 'their work email' : 'the number they are messaging from',
        agentGuidance:
          'Greet them by name, mention briefly that you recognised them, and continue with what they asked for.',
      };
    }

    const explanation: Record<string, string> = {
      no_match: 'The number or address they are messaging from is not on any personnel record.',
      ambiguous_match: 'More than one personnel record carries these contact details.',
      channel_carries_no_identity: 'This channel did not supply a phone number or email address.',
      no_user_context: 'No user context is available on this channel.',
    };

    // startOver clears the binding but deliberately NOT the failure counter,
    // so it cannot be used to escape a lockout.
    const state = await challengeState();
    if (state.locked) {
      return {
        ok: false,
        error: 'locked_out',
        detail: `Verification is locked until ${state.unlocksAt} after repeated failed attempts.`,
        action: 'Hand them to HR. Do not offer another attempt.',
      };
    }

    return {
      ok: false,
      error: 'needs_challenge',
      detail: explanation[auto.reason] ?? 'Automatic recognition was not possible.',
      attemptsRemaining: state.attemptsRemaining,
      needed: [
        { field: 'employeeId', ask: 'What is your employee ID?' },
        { field: 'hireDate', ask: 'What date did you start? (YYYY-MM-DD)' },
      ],
      action:
        'Ask for both, translated into the language of THEIR last message, then call this tool again with them. Do not read anything from a personnel record until this succeeds.',
    };
  }
}

export class WhoAmITool implements LuaTool {
  name = 'whoami';
  description =
    'Report who the agent currently believes it is talking to, and what that person is allowed to do';

  inputSchema = z.object({});

  async execute() {
    const result = await getCaller();

    if (!result.verified) {
      return {
        ok: true,
        verified: false,
        detail: result.message,
        action: result.action,
      };
    }

    const { caller, employee } = result;

    return {
      ok: true,
      verified: true,
      employeeId: caller.employeeId,
      name: caller.displayName,
      jobTitle: employee.jobTitle,
      department: employee.department,
      country: employee.country,
      role: caller.role,
      directReports: caller.reportIds.length,
      canDo: capabilitiesOf(caller),
      agentGuidance:
        caller.role === 'hr'
          ? 'This person holds HR privileges and can ask about any employee. Still tell them whose record you are reading.'
          : caller.reportIds.length > 0
            ? 'This person leads a team. They can see their own record fully, and their reports’ records but not their reports’ pay or entitlements.'
            : 'This person can only access their own record.',
    };
  }
}
