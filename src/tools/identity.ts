/**
 * identity.ts — binding a channel identity to a personnel record.
 *
 * The trust anchor is `user._luaProfile`: userId, full name, verified phone
 * numbers and email addresses, supplied by the platform from the channel the
 * message actually arrived on. It is read-only, and nothing the model writes
 * can change it. Everything here builds on that and on BambooHR — never on a
 * value the model produced.
 *
 * Binding happens once. After that the employee's identity is read from their
 * user record rather than from the conversation, so "check the leave balance
 * for employee 89" cannot be answered just because someone typed it.
 */

import { env, User } from 'lua-cli';

import { authorize, inferRole, type Action, type Caller, type Decision } from '../domain/authorization';
import { getDirectory, getEmployee, type Employee } from '../integrations/bamboo';

/* ------------------------------------------------------------ matching */

/**
 * Compare phone numbers by their last nine digits.
 *
 * A Saudi mobile is written +966 5X XXX XXXX in the HRIS and arrives from
 * WhatsApp as 9665XXXXXXXX. Comparing the significant tail sidesteps country
 * codes, leading zeros, spaces and dashes without trying to parse dialling
 * plans for four countries.
 */
export function phoneMatches(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const digits = (s: string) => s.replace(/\D/g, '');
  const tail = (s: string) => digits(s).slice(-9);
  return tail(a).length === 9 && tail(a) === tail(b);
}

function emailMatches(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* -------------------------------------------------------------- profile */

interface LuaProfile {
  userId?: string;
  fullName?: string;
  emailAddresses?: string[];
  mobileNumbers?: string[];
}

function profileOf(user: unknown): LuaProfile {
  return ((user as { _luaProfile?: LuaProfile })?._luaProfile ?? {}) as LuaProfile;
}

/* -------------------------------------------------------------- binding */

export interface Binding {
  employeeId: string;
  verifiedAt: string;
  method: 'work_email' | 'mobile_number' | 'challenge';
}

/**
 * Try to identify the caller from the channel alone.
 *
 * A work email or a mobile number that resolves to exactly one personnel
 * record is treated as proof — the channel already verified it. More than one
 * match is treated as no match: an ambiguous identity is worse than none.
 */
export async function attemptAutoBind(): Promise<
  { bound: true; employee: Employee; method: Binding['method'] } | { bound: false; reason: string }
> {
  const user = await User.get();
  if (!user) return { bound: false, reason: 'no_user_context' };

  const profile = profileOf(user);
  const emails = profile.emailAddresses ?? [];
  const phones = profile.mobileNumbers ?? [];

  if (!emails.length && !phones.length) {
    return { bound: false, reason: 'channel_carries_no_identity' };
  }

  const roster = await getDirectory();

  const byEmail = roster.filter((e) => emails.some((addr) => emailMatches(addr, e.workEmail)));
  if (byEmail.length === 1) {
    await persistBinding(byEmail[0].id, 'work_email');
    return { bound: true, employee: byEmail[0], method: 'work_email' };
  }

  const byPhone = roster.filter((e) => phones.some((num) => phoneMatches(num, e.mobilePhone)));
  if (byPhone.length === 1) {
    await persistBinding(byPhone[0].id, 'mobile_number');
    return { bound: true, employee: byPhone[0], method: 'mobile_number' };
  }

  if (byEmail.length > 1 || byPhone.length > 1) {
    return { bound: false, reason: 'ambiguous_match' };
  }

  return { bound: false, reason: 'no_match' };
}

/**
 * Fall back to a challenge when the channel cannot identify the caller.
 *
 * Employee ID plus hire date. The ID alone is guessable and semi-public; the
 * hire date is known to the employee and to HR and is not sensitive if it
 * leaks, which makes it a reasonable second factor for a demo. Anything
 * stronger — an OTP to the number on file — is the production answer, and is
 * noted as such in the README.
 */
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface LockoutState {
  locked: boolean;
  attemptsRemaining: number;
  unlocksAt?: string;
}

/**
 * How many attempts this account has left.
 *
 * Employee IDs are small integers, so without a limit the challenge is a few
 * hundred requests away from being brute-forced. Attempts are counted on the
 * account rather than in memory so a lockout survives a new conversation.
 */
export async function challengeState(): Promise<LockoutState> {
  const user = await User.get();
  if (!user) return { locked: false, attemptsRemaining: MAX_CHALLENGE_ATTEMPTS };

  const until = (user as { identityLockedUntil?: string }).identityLockedUntil;
  if (until && new Date(until) > new Date()) {
    return { locked: true, attemptsRemaining: 0, unlocksAt: until };
  }

  const failures = Number((user as { identityFailures?: number }).identityFailures ?? 0);
  return {
    locked: false,
    attemptsRemaining: Math.max(0, MAX_CHALLENGE_ATTEMPTS - failures),
  };
}

async function recordFailure(): Promise<LockoutState> {
  const user = await User.get();
  if (!user) return { locked: false, attemptsRemaining: MAX_CHALLENGE_ATTEMPTS };

  const failures = Number((user as { identityFailures?: number }).identityFailures ?? 0) + 1;

  if (failures >= MAX_CHALLENGE_ATTEMPTS) {
    const unlocksAt = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
    await user.update({ identityFailures: failures, identityLockedUntil: unlocksAt });
    return { locked: true, attemptsRemaining: 0, unlocksAt };
  }

  await user.update({ identityFailures: failures });
  return { locked: false, attemptsRemaining: MAX_CHALLENGE_ATTEMPTS - failures };
}

async function clearFailures(): Promise<void> {
  const user = await User.get();
  if (!user) return;
  try {
    await user.unset('identityFailures', 'identityLockedUntil');
  } catch {
    // unset throws when neither field exists, which is the common case.
  }
}

export type ChallengeResult =
  | { bound: true; employee: Employee }
  | { bound: false; reason: 'verification_failed'; attemptsRemaining: number }
  | { bound: false; reason: 'locked_out'; unlocksAt: string };

export async function bindByChallenge(
  employeeId: string,
  hireDate: string,
): Promise<ChallengeResult> {
  const state = await challengeState();
  if (state.locked) {
    return { bound: false, reason: 'locked_out', unlocksAt: state.unlocksAt! };
  }

  let employee: Employee | null = null;
  try {
    employee = await getEmployee(employeeId);
  } catch {
    employee = null;
  }

  // A wrong ID and a wrong date fail identically. Distinguishing them would
  // turn the endpoint into a way to discover which employee IDs are real.
  const verified = Boolean(
    employee && employee.hireDate && employee.hireDate === hireDate.trim(),
  );

  if (!verified) {
    const after = await recordFailure();
    return after.locked
      ? { bound: false, reason: 'locked_out', unlocksAt: after.unlocksAt! }
      : { bound: false, reason: 'verification_failed', attemptsRemaining: after.attemptsRemaining };
  }

  await clearFailures();
  await persistBinding(employee!.id, 'challenge');
  return { bound: true, employee: employee! };
}

async function persistBinding(employeeId: string, method: Binding['method']): Promise<void> {
  const user = await User.get();
  if (!user) return;

  await user.update({
    employeeId,
    identityVerifiedAt: new Date().toISOString(),
    identityMethod: method,
  });
}

export async function getBinding(): Promise<Binding | null> {
  const user = await User.get();
  if (!user) return null;

  const employeeId = (user as { employeeId?: string }).employeeId;
  if (!employeeId) return null;

  return {
    employeeId,
    verifiedAt: (user as { identityVerifiedAt?: string }).identityVerifiedAt ?? '',
    method: ((user as { identityMethod?: Binding['method'] }).identityMethod ?? 'challenge'),
  };
}

/** Remove the binding — used when someone says the agent has the wrong person. */
export async function clearBinding(): Promise<void> {
  const user = await User.get();
  if (!user) return;
  await user.unset('employeeId', 'identityVerifiedAt', 'identityMethod');
}

/* ------------------------------------------------------------- caller */

export interface UnverifiedCaller {
  verified: false;
  reason: 'not_bound' | 'record_missing';
  message: string;
  action: string;
}

export type CallerResult = { verified: true; caller: Caller; employee: Employee } | UnverifiedCaller;

/**
 * The verified caller, assembled from the binding and the live HRIS.
 *
 * Role and reporting line are read from BambooHR on every call rather than
 * cached on the user record. That costs a request, and it means a promotion or
 * a team move takes effect immediately instead of persisting until someone
 * remembers to clear a stale claim.
 */
export async function getCaller(): Promise<CallerResult> {
  const binding = await getBinding();

  if (!binding) {
    return {
      verified: false,
      reason: 'not_bound',
      message: 'I have not confirmed who you are yet.',
      action:
        'Call verify_my_identity with no arguments first — it can usually recognise the number or email you are messaging from. If it cannot, it will tell you what to ask for.',
    };
  }

  let employee: Employee;
  try {
    employee = await getEmployee(binding.employeeId);
  } catch {
    return {
      verified: false,
      reason: 'record_missing',
      message: 'The personnel record linked to this account is no longer available.',
      action: 'Ask the employee to verify again, and escalate to HR if it keeps failing.',
    };
  }

  const roster = await getDirectory();
  const reports = roster.filter(
    (e) => e.supervisor?.trim().toLowerCase() === employee.displayName?.trim().toLowerCase(),
  );

  const caller: Caller = {
    employeeId: employee.id,
    displayName: employee.displayName,
    role: inferRole(
      {
        employeeId: employee.id,
        department: employee.department,
        jobTitle: employee.jobTitle,
        hasReports: reports.length > 0,
      },
      // Comma-separated employee IDs. Set this and the title heuristic is off.
      (env('HR_EMPLOYEE_IDS') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    reportIds: reports.map((r) => r.id),
  };

  return { verified: true, caller, employee };
}

/** Authorise the verified caller against a subject. Thin, but the one door. */
export function check(caller: Caller, subjectId: string, action: Action, subjectName?: string): Decision {
  return authorize(caller, { employeeId: subjectId, displayName: subjectName }, action);
}
