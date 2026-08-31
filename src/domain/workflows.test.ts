/**
 * workflows.test.ts — boundary assertions for the SOP request and
 * performance domains (workflows 3 and 4).
 *
 * Run with:  npx tsx src/domain/workflows.test.ts
 *
 * The cases that matter here are the working-day SLA arithmetic, which has to
 * skip a Friday-Saturday weekend, and the aggregation thresholds that decide
 * whether a person gets flagged to their manager.
 */

import {
  recurringBlockers,
  summariseTeam,
  trendOf,
  validateCheckIn,
  withinPeriod,
  daysAgo,
  type CheckIn,
} from './performance';

import {
  availableRequestTypes,
  dueDate,
  makeReference,
  slaState,
  validateRequest,
  canTransition,
  type SopRequest,
} from './sopRequests';

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

/* ============================================== check-in validation */
section('Check-in validation');

const goodRatings = [
  { employeeId: '1', name: 'Layla', rating: 4 },
  { employeeId: '2', name: 'Omar', rating: 3 },
];

check('a complete check-in is accepted',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'Shipped the valve retrofit', ratings: goodRatings }).ok, true);

check('a malformed date is refused',
  validateCheckIn({ date: '31/08/2026', accomplishments: 'x', ratings: goodRatings }).reason, 'invalid_date');

check('empty accomplishments are refused',
  validateCheckIn({ date: '2026-08-31', accomplishments: '   ', ratings: goodRatings }).reason, 'empty_accomplishments');

check('a check-in with no ratings is refused',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'x', ratings: [] }).reason, 'no_ratings');

check('a rating of 6 is refused',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'x', ratings: [{ employeeId: '1', name: 'Layla', rating: 6 }] }).reason,
  'rating_out_of_range');

check('a rating of 0 is refused',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'x', ratings: [{ employeeId: '1', name: 'Layla', rating: 0 }] }).reason,
  'rating_out_of_range');

check('the boundary values 1 and 5 are accepted',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'x', ratings: [
    { employeeId: '1', name: 'Layla', rating: 1 },
    { employeeId: '2', name: 'Omar', rating: 5 },
  ] }).ok, true);

check('rating the same person twice is refused',
  validateCheckIn({ date: '2026-08-31', accomplishments: 'x', ratings: [
    { employeeId: '1', name: 'Layla', rating: 4 },
    { employeeId: '1', name: 'Layla', rating: 2 },
  ] }).reason, 'duplicate_member');

/* =========================================================== trends */
section('Trend detection');

check('too few points is insufficient_data', trendOf([3, 4]), 'insufficient_data');
check('a rising run is improving', trendOf([2, 2, 3, 4, 5]), 'improving');
check('a falling run is declining', trendOf([5, 4, 4, 3, 2]), 'declining');
check('a flat run is steady', trendOf([3, 3, 3, 3, 3]), 'steady');
check('noise below the threshold stays steady', trendOf([3, 4, 3, 4, 3]), 'steady');

/* ========================================================= blockers */
section('Recurring blockers');

const withBlockers: CheckIn[] = [
  { id: 'a', teamLeadId: '99', teamLeadName: 'Lead', date: '2026-08-24', accomplishments: 'x', blockers: ['Spare parts delayed', 'Network outage'], ratings: [], createdAt: '' },
  { id: 'b', teamLeadId: '99', teamLeadName: 'Lead', date: '2026-08-25', accomplishments: 'x', blockers: ['spare parts delayed'], ratings: [], createdAt: '' },
  { id: 'c', teamLeadId: '99', teamLeadName: 'Lead', date: '2026-08-26', accomplishments: 'x', blockers: ['Spare Parts Delayed'], ratings: [], createdAt: '' },
];

const recurring = recurringBlockers(withBlockers);
check('a blocker seen on three days is flagged', recurring.length, 1);
check('matching is case-insensitive', recurring[0]?.days, 3);
check('a one-off blocker is not flagged', recurring.some((b) => b.blocker.includes('network')), false);

/* ====================================================== aggregation */
section('Weekly summary');

function checkIn(date: string, ratings: Array<[string, string, number]>, blockers: string[] = []): CheckIn {
  return {
    id: `chk-${date}`,
    teamLeadId: '99',
    teamLeadName: 'Ahmad Al-Rashid',
    date,
    accomplishments: 'Routine maintenance completed',
    blockers,
    ratings: ratings.map(([employeeId, name, rating]) => ({ employeeId, name, rating })),
    createdAt: '',
  };
}

const week: CheckIn[] = [
  checkIn('2026-08-24', [['1', 'Layla', 4], ['2', 'Omar', 2]]),
  checkIn('2026-08-25', [['1', 'Layla', 4], ['2', 'Omar', 2]]),
  checkIn('2026-08-26', [['1', 'Layla', 5], ['2', 'Omar', 3]]),
];

const summary = summariseTeam(week, '2026-08-24', '2026-08-28', 5)!;

check('the lead is carried through', summary.teamLeadName, 'Ahmad Al-Rashid');
check('distinct days are counted', summary.checkInsSubmitted, 3);
check('reporting rate is days over expected', summary.reportingRate, 0.6);
check('both members appear', summary.members.length, 2);
check('members sort worst-first', summary.members[0].name, 'Omar');
check('averages are correct', summary.members.find((m) => m.name === 'Layla')?.averageRating, 4.33);
check('a low average is flagged', summary.members.find((m) => m.name === 'Omar')?.needsAttention, true);
check('a healthy average is not flagged', summary.members.find((m) => m.name === 'Layla')?.needsAttention, false);
check('needingAttention lists only the flagged', summary.membersNeedingAttention.length, 1);
check('lowest and highest are tracked', summary.members.find((m) => m.name === 'Omar')?.lowest, 2);

check('an empty period returns null', summariseTeam([], '2026-08-24', '2026-08-28'), null);

/* ------------------------------------------------- the 2.5 boundary */
const atBoundary = summariseTeam(
  [checkIn('2026-08-24', [['3', 'Yusuf', 2]]), checkIn('2026-08-25', [['3', 'Yusuf', 3]])],
  '2026-08-24', '2026-08-28', 5,
)!;
check('exactly 2.5 is NOT flagged', atBoundary.members[0].needsAttention, false);

const belowBoundary = summariseTeam(
  [checkIn('2026-08-24', [['3', 'Yusuf', 2]]), checkIn('2026-08-25', [['3', 'Yusuf', 2]])],
  '2026-08-24', '2026-08-28', 5,
)!;
check('below 2.5 is flagged', belowBoundary.members[0].needsAttention, true);

/* ------------------------------------------------------ date window */
section('Period filtering');

check('withinPeriod is inclusive at both ends', withinPeriod(week, '2026-08-24', '2026-08-26').length, 3);
check('withinPeriod excludes outside dates', withinPeriod(week, '2026-08-25', '2026-08-25').length, 1);
check('daysAgo walks back correctly', daysAgo('2026-08-31', 6), '2026-08-25');
check('daysAgo crosses a month boundary', daysAgo('2026-09-02', 3), '2026-08-30');

/* ============================================ working-day SLA maths */
section('Working-day due dates');

// 2026-09-01 is a Tuesday. The Gulf weekend is Friday and Saturday.
check('two working days from Tuesday', dueDate('2026-09-01', 2), '2026-09-03');
check('two working days from Thursday skips the weekend', dueDate('2026-09-03', 2), '2026-09-07');
check('five working days spans one weekend', dueDate('2026-09-01', 5), '2026-09-08');
check('ten working days spans two weekends', dueDate('2026-09-01', 10), '2026-09-15');

/* ================================================ request validation */
section('Request validation');

check('an unknown type is refused',
  validateRequest({ type: 'sabbatical', country: 'KSA', details: {} }).reason, 'unknown_type');

check('a Saudi-only request is refused for Egypt',
  validateRequest({ type: 'exit_reentry_visa', country: 'EGY', details: {} }).reason, 'not_available_in_country');

check('a Saudi-only request is allowed in KSA',
  validateRequest({ type: 'exit_reentry_visa', country: 'KSA', details: {
    departureDate: '2026-10-01', returnDate: '2026-10-14', entryType: 'single',
  } }).ok, true);

check('missing details are reported, not guessed',
  validateRequest({ type: 'salary_certificate', country: 'UAE', details: {} }).reason, 'missing_details');

check('the exact missing fields come back',
  validateRequest({ type: 'salary_certificate', country: 'UAE', details: { addressee: 'Emirates NBD' } })
    .missing?.map((m) => m.key), ['includeAllowances']);

check('missing-field prompts carry Arabic',
  /[؀-ۿ]/.test(validateRequest({ type: 'transfer', country: 'JOR', details: {} }).missing?.[0]?.promptAr ?? ''), true);

check('a complete request passes',
  validateRequest({ type: 'salary_certificate', country: 'UAE', details: {
    addressee: 'Emirates NBD', includeAllowances: 'basic only',
  } }).ok, true);

check('whitespace does not satisfy a required field',
  validateRequest({ type: 'transfer', country: 'KSA', details: { targetRole: '  ', reason: 'growth' } }).reason,
  'missing_details');

/* ------------------------------------------------ country filtering */
check('Egypt sees no visa or Iqama request types',
  availableRequestTypes('EGY').some((s) => s.countries), false);
check('Saudi Arabia sees every type',
  availableRequestTypes('KSA').length, 7);

/* --------------------------------------------------------- references */
check('references carry a readable prefix', makeReference('salary_certificate', 1788171476995).slice(0, 4), 'SAL-');
check('visa references are distinguishable', makeReference('exit_reentry_visa', 1788171476995).slice(0, 4), 'VIS-');

/* ================================================================ SLA */
section('SLA state');

const openRequest: SopRequest = {
  reference: 'SAL-000001', type: 'salary_certificate', employeeId: '12',
  employeeName: 'Eric Asture', country: 'KSA', status: 'submitted', details: {},
  owner: 'People team', submittedAt: '2026-09-01', dueBy: '2026-09-03',
};

check('an in-flight request is not breached', slaState(openRequest, '2026-09-02').breached, false);
check('remaining working days are counted', slaState(openRequest, '2026-09-01').workingDaysRemaining, 2);
check('a request past its due date is breached', slaState(openRequest, '2026-09-08').breached, true);
check('overdue days come back negative', slaState(openRequest, '2026-09-07').workingDaysRemaining, -2);

const completedLate: SopRequest = { ...openRequest, status: 'completed', completedAt: '2026-09-09' };
check('a late completion is breached', slaState(completedLate, '2026-09-20').breached, true);

const completedOnTime: SopRequest = { ...openRequest, status: 'completed', completedAt: '2026-09-02' };
check('an on-time completion is not breached', slaState(completedOnTime, '2026-09-20').breached, false);

/* --------------------------------------------------------- transitions */
check('a completed request cannot be reopened', canTransition('completed', 'in_progress').ok, false);
check('a rejected request cannot be reopened', canTransition('rejected', 'submitted').ok, false);
check('submitted can move to in_progress', canTransition('submitted', 'in_progress').ok, true);
check('a no-op transition is refused', canTransition('submitted', 'submitted').ok, false);

/* ============================================================= result */
console.log(`\n${'-'.repeat(52)}`);
console.log(`PASS ${passed}   FAIL ${failed}`);
if (failed > 0) process.exit(1);
