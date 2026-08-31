/**
 * authorization.ts — who may see whose record.
 *
 * Before this module, every tool took an `employeeId` supplied by the model,
 * which meant the only thing standing between an employee and a colleague's
 * salary was a sentence in the persona. A persona is guidance. This is a gate.
 *
 * Pure functions only — no I/O, no platform imports — so the policy can be
 * tested exhaustively without a runtime, and so the rules are readable in one
 * place rather than scattered across thirteen tools.
 */

export type Role = 'employee' | 'manager' | 'hr';

export type Action =
  | 'view_record'          // employee details, tenure, country
  | 'view_entitlements'    // leave balance, gratuity, Iqama
  | 'submit_request'       // leave, SOP requests, on someone's behalf
  | 'view_team_performance'
  | 'submit_team_checkin';

/** The verified caller. Never built from anything the model supplied. */
export interface Caller {
  employeeId: string;
  displayName: string;
  role: Role;
  /** Employee IDs of the caller's direct reports. */
  reportIds: string[];
}

/** Enough of the target to decide, without fetching more than necessary. */
export interface Subject {
  employeeId: string;
  displayName?: string;
}

export type Decision =
  | { allowed: true; basis: 'self' | 'direct_report' | 'hr' }
  | { allowed: false; reason: DenialReason; message: string };

export type DenialReason =
  | 'not_self'
  | 'not_your_report'
  | 'requires_hr'
  | 'requires_manager';

/**
 * Departments and titles that carry HR privilege.
 *
 * Derived from the HRIS rather than stored as a claim on the user record: a
 * role that lives in BambooHR is revoked when someone changes job, and a role
 * the agent stores locally is not.
 */
export function inferRole(
  employee: {
    employeeId?: string;
    department?: string;
    jobTitle?: string;
    hasReports: boolean;
  },
  /**
   * Explicit HR employee IDs. When this list is non-empty it is authoritative
   * and the title heuristic below is switched off entirely — an allowlist that
   * a job title can bypass is not an allowlist.
   */
  explicitHrIds: string[] = [],
): Role {
  if (explicitHrIds.length > 0) {
    if (employee.employeeId && explicitHrIds.includes(employee.employeeId)) return 'hr';
    return employee.hasReports ? 'manager' : 'employee';
  }

  const haystack = `${employee.department ?? ''} ${employee.jobTitle ?? ''}`.toLowerCase();

  const isHr =
    /\bhuman resources\b|\bpeople\b|\bhr\b/.test(haystack) ||
    /people (team|operations|partner)|hr (manager|director|business partner|coordinator|generalist)/.test(haystack);

  if (isHr) return 'hr';
  return employee.hasReports ? 'manager' : 'employee';
}

function selfDecision(): Decision {
  return { allowed: true, basis: 'self' };
}

/**
 * Can this caller take this action against this subject?
 *
 * Deliberately conservative: anything not explicitly permitted is denied, and
 * the denial says which capability was missing so the agent can explain rather
 * than just refuse.
 */
export function authorize(
  caller: Caller,
  subject: Subject,
  action: Action,
): Decision {
  const isSelf = caller.employeeId === subject.employeeId;
  const isReport = caller.reportIds.includes(subject.employeeId);

  switch (action) {
    /* ------------------------------------------- personal information */
    case 'view_record':
    case 'view_entitlements':
    case 'submit_request': {
      if (isSelf) return selfDecision();

      if (caller.role === 'hr') return { allowed: true, basis: 'hr' };

      // A manager sees that a report exists and where they sit, but not their
      // pay or end-of-service position. Those stay between the employee and HR.
      if (isReport && action === 'view_record') {
        return { allowed: true, basis: 'direct_report' };
      }

      if (isReport) {
        return {
          allowed: false,
          reason: 'requires_hr',
          message: `Entitlements and end-of-service figures are between the employee and HR. As ${subject.displayName ?? 'their'} line manager you can see their record, but not their balances or gratuity.`,
        };
      }

      return {
        allowed: false,
        reason: 'not_self',
        message: `You can only access your own record. ${subject.displayName ?? 'That employee'} is not you, and is not one of your direct reports.`,
      };
    }

    /* --------------------------------------------------- performance */
    case 'view_team_performance': {
      if (isSelf) return selfDecision();
      if (caller.role === 'hr') return { allowed: true, basis: 'hr' };
      if (isReport) return { allowed: true, basis: 'direct_report' };

      return {
        allowed: false,
        reason: 'not_your_report',
        message: `Team performance is visible to that team's own lead and to HR. ${subject.displayName ?? 'That team lead'} does not report to you.`,
      };
    }

    case 'submit_team_checkin': {
      // Only a lead files for their own team. HR does not file on their behalf,
      // because a check-in is a first-hand judgement, not an administrative act.
      if (isSelf) {
        if (caller.reportIds.length === 0) {
          return {
            allowed: false,
            reason: 'requires_manager',
            message: 'Check-ins are filed by team leads. You have no direct reports on record — if that is wrong, ask HR to correct the reporting line.',
          };
        }
        return selfDecision();
      }

      return {
        allowed: false,
        reason: 'not_self',
        message: 'A check-in has to be filed by the lead who observed the work. You cannot file one for another team.',
      };
    }
  }
}

/** Actions a caller can take on their own record, for a "what can I do" reply. */
export function capabilitiesOf(caller: Caller): string[] {
  const own = [
    'view your own record',
    'check your own leave balance',
    'request leave',
    'calculate your own end-of-service',
    'raise HR service requests',
    'search HR policies',
  ];

  if (caller.reportIds.length > 0) {
    own.push(`file a daily check-in for your ${caller.reportIds.length} direct report${caller.reportIds.length === 1 ? '' : 's'}`);
    own.push('see your own team’s performance summary');
  }

  if (caller.role === 'hr') {
    own.push('access any employee’s record, on behalf of HR');
  }

  return own;
}
