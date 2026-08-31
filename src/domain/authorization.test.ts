/**
 * authorization.test.ts — who may see whose record.
 *
 * Run with:  npx tsx src/domain/authorization.test.ts
 *
 * This is the suite that matters most. Every other test protects an employee
 * from a wrong number; these protect them from a colleague reading their pay.
 *
 * Written as an explicit matrix rather than a handful of happy paths, because
 * an authorization bug is invisible until someone finds it, and the failure
 * mode is disclosure rather than an error message.
 */

import {
  authorize,
  capabilitiesOf,
  inferRole,
  type Action,
  type Caller,
} from './authorization';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          received ${a}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------- cast */

const employee: Caller = {
  employeeId: '100', displayName: 'Layla Nasser', role: 'employee', reportIds: [],
};

const manager: Caller = {
  employeeId: '200', displayName: 'Ahmad Al-Rashid', role: 'manager', reportIds: ['100', '101'],
};

const hr: Caller = {
  employeeId: '300', displayName: 'Noura Al-Qahtani', role: 'hr', reportIds: [],
};

const SELF = (c: Caller) => ({ employeeId: c.employeeId });
const REPORT = { employeeId: '100', displayName: 'Layla Nasser' };
const STRANGER = { employeeId: '999', displayName: 'Someone Else' };

function allowed(caller: Caller, subject: { employeeId: string }, action: Action): boolean {
  return authorize(caller, subject, action).allowed;
}

/* ============================================== role inference */
section('Role inference');

check('a plain employee is an employee',
  inferRole({ department: 'Operations', jobTitle: 'Technician', hasReports: false }), 'employee');

check('anyone with reports is a manager',
  inferRole({ department: 'Operations', jobTitle: 'Shift Supervisor', hasReports: true }), 'manager');

check('the People department is HR',
  inferRole({ department: 'People', jobTitle: 'Coordinator', hasReports: false }), 'hr');

check('Human Resources is HR',
  inferRole({ department: 'Human Resources', jobTitle: 'Analyst', hasReports: false }), 'hr');

check('an HR title is HR even outside the department',
  inferRole({ department: 'Corporate', jobTitle: 'HR Business Partner', hasReports: false }), 'hr');

check('HR outranks having reports',
  inferRole({ department: 'People', jobTitle: 'HR Manager', hasReports: true }), 'hr');

// The obvious false positive: "HR" must not match inside an unrelated word.
check('"Chrome" does not make someone HR',
  inferRole({ department: 'IT', jobTitle: 'Chrome Platform Engineer', hasReports: false }), 'employee');

check('"Thruster" does not make someone HR',
  inferRole({ department: 'Engineering', jobTitle: 'Thruster Technician', hasReports: false }), 'employee');

/* ------------------------------------------------- explicit allowlist */
section('An explicit allowlist replaces the heuristic entirely');

const ALLOWLIST = ['300', '301'];

check('someone on the list is HR',
  inferRole({ employeeId: '300', department: 'Operations', jobTitle: 'Technician', hasReports: false }, ALLOWLIST), 'hr');

// The point of an allowlist: a job title must not be able to bypass it.
check('an HR job title off the list is NOT HR',
  inferRole({ employeeId: '999', department: 'Human Resources', jobTitle: 'HR Manager', hasReports: false }, ALLOWLIST), 'employee');

check('an HR job title off the list still keeps manager status',
  inferRole({ employeeId: '999', department: 'People', jobTitle: 'HR Director', hasReports: true }, ALLOWLIST), 'manager');

check('an empty allowlist falls back to the heuristic',
  inferRole({ employeeId: '999', department: 'People', jobTitle: 'Coordinator', hasReports: false }, []), 'hr');

check('the allowlist does not grant HR without an employee ID',
  inferRole({ department: 'People', jobTitle: 'HR Manager', hasReports: false }, ALLOWLIST), 'employee');

/* =================================================== self access */
section('Everyone reaches their own record');

for (const [name, caller] of [['employee', employee], ['manager', manager], ['HR', hr]] as const) {
  for (const action of ['view_record', 'view_entitlements', 'submit_request'] as Action[]) {
    check(`${name} may ${action} on themselves`, allowed(caller, SELF(caller), action), true);
  }
}

/* ============================================= employee limits */
section('An employee reaches nobody else');

check('not a colleague’s record', allowed(employee, STRANGER, 'view_record'), false);
check('not a colleague’s entitlements', allowed(employee, STRANGER, 'view_entitlements'), false);
check('cannot request on a colleague’s behalf', allowed(employee, STRANGER, 'submit_request'), false);
check('not a colleague’s performance', allowed(employee, STRANGER, 'view_team_performance'), false);

check('the refusal names the reason',
  (authorize(employee, STRANGER, 'view_entitlements') as { reason?: string }).reason, 'not_self');

check('the refusal message does not leak the subject’s data',
  /salary|balance|\d{4}-\d{2}-\d{2}/.test(
    (authorize(employee, STRANGER, 'view_entitlements') as { message?: string }).message ?? '',
  ), false);

/* =============================================== manager limits */
section('A manager reaches their reports, and only so far');

check('may see a report’s record', allowed(manager, REPORT, 'view_record'), true);
check('may see a report’s team performance', allowed(manager, REPORT, 'view_team_performance'), true);

// The line that matters: a manager is not entitled to their report's money.
check('may NOT see a report’s entitlements', allowed(manager, REPORT, 'view_entitlements'), false);
check('may NOT request on a report’s behalf', allowed(manager, REPORT, 'submit_request'), false);

check('the entitlements refusal explains why',
  (authorize(manager, REPORT, 'view_entitlements') as { reason?: string }).reason, 'requires_hr');

check('may not touch someone outside their team', allowed(manager, STRANGER, 'view_record'), false);
check('may not see another team’s performance', allowed(manager, STRANGER, 'view_team_performance'), false);

check('the basis is recorded as direct_report',
  (authorize(manager, REPORT, 'view_record') as { basis?: string }).basis, 'direct_report');

/* ==================================================== HR access */
section('HR reaches anyone');

check('HR sees any record', allowed(hr, STRANGER, 'view_record'), true);
check('HR sees any entitlements', allowed(hr, STRANGER, 'view_entitlements'), true);
check('HR requests on anyone’s behalf', allowed(hr, STRANGER, 'submit_request'), true);
check('HR sees any team’s performance', allowed(hr, STRANGER, 'view_team_performance'), true);

check('the basis is recorded as hr',
  (authorize(hr, STRANGER, 'view_entitlements') as { basis?: string }).basis, 'hr');

/* ================================================== check-ins */
section('Check-ins are filed only by the lead who observed the work');

check('a lead files for their own team', allowed(manager, SELF(manager), 'submit_team_checkin'), true);
check('a lead cannot file for another team', allowed(manager, STRANGER, 'submit_team_checkin'), false);
check('someone with no reports cannot file', allowed(employee, SELF(employee), 'submit_team_checkin'), false);

check('the no-reports refusal is specific',
  (authorize(employee, SELF(employee), 'submit_team_checkin') as { reason?: string }).reason, 'requires_manager');

// HR is deliberately NOT allowed to file a check-in on a lead's behalf.
check('even HR cannot file for a team they did not observe',
  allowed(hr, STRANGER, 'submit_team_checkin'), false);

check('HR with no reports cannot file for itself',
  allowed(hr, SELF(hr), 'submit_team_checkin'), false);

/* ================================================ capabilities */
section('Capability reporting');

check('an employee is not offered team tools',
  capabilitiesOf(employee).some((c) => c.includes('check-in')), false);

check('a manager is offered team tools',
  capabilitiesOf(manager).some((c) => c.includes('check-in')), true);

check('a manager sees their report count',
  capabilitiesOf(manager).some((c) => c.includes('2 direct reports')), true);

check('HR is told it can reach anyone',
  capabilitiesOf(hr).some((c) => c.includes('any employee')), true);

check('an employee is NOT told it can reach anyone',
  capabilitiesOf(employee).some((c) => c.includes('any employee')), false);

/* ====================================== every denial is explained */
section('Every denial carries a reason and a message');

const denialCases: Array<[Caller, { employeeId: string }, Action]> = [
  [employee, STRANGER, 'view_record'],
  [employee, STRANGER, 'view_entitlements'],
  [employee, STRANGER, 'submit_request'],
  [employee, STRANGER, 'view_team_performance'],
  [employee, SELF(employee), 'submit_team_checkin'],
  [manager, REPORT, 'view_entitlements'],
  [manager, STRANGER, 'view_record'],
  [manager, STRANGER, 'view_team_performance'],
  [manager, STRANGER, 'submit_team_checkin'],
];

let wellFormed = 0;
for (const [caller, subject, action] of denialCases) {
  const decision = authorize(caller, subject, action) as { allowed: boolean; reason?: string; message?: string };
  if (!decision.allowed && decision.reason && decision.message && decision.message.length > 20) {
    wellFormed += 1;
  }
}
check('all denials are actionable', wellFormed, denialCases.length);

/* ============================================================ result */
console.log(`\n${'-'.repeat(52)}`);
console.log(`PASS ${passed}   FAIL ${failed}`);
if (failed > 0) process.exit(1);
