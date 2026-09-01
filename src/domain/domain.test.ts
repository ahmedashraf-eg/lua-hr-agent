/**
 * domain.test.ts — boundary assertions for the ported domain logic.
 *
 * Run with:  npx tsx src/domain/domain.test.ts
 *
 * These are the cases most likely to be probed in a live walkthrough: the
 * exact year at which each entitlement tier flips, the resignation cliffs,
 * the UAE cap, and the Iqama tier edges.
 */

import { completedYears, inclusiveDays, tenureYears } from './tenure';
import { annualLeaveDays, validateProbation } from './countryRules';
import { calculateGratuity } from './gratuity';
import { balance, validateLeaveRequest, type LeaveRecord } from './leave';
import { checkIqama, sweepIqamaExpiry } from './iqama';

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

function near(label: string, actual: number | null, expected: number, tolerance = 0.5): void {
  if (actual !== null && Math.abs(actual - expected) <= tolerance) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}\n          expected ~${expected}\n          received ${actual}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------------ dates */
section('Date and tenure helpers');

check('inclusive single day', inclusiveDays('2026-03-01', '2026-03-01'), 1);
check('inclusive range', inclusiveDays('2026-03-01', '2026-03-05'), 5);
check('leap day spans correctly', inclusiveDays('2028-02-28', '2028-03-01'), 3);
check('completed years, day before anniversary', completedYears('2021-03-01', '2026-02-28'), 4);
check('completed years, on anniversary', completedYears('2021-03-01', '2026-03-01'), 5);
near('fractional tenure', tenureYears('2021-03-01', '2026-09-01'), 5.5, 0.02);

/* --------------------------------------------------------- annual leave */
section('Annual leave entitlement');

check('KSA under 5 years', annualLeaveDays('KSA', '2023-01-01', '2026-01-01')?.days, 21);
check('KSA at exactly 5 years', annualLeaveDays('KSA', '2021-01-01', '2026-01-01')?.days, 30);
check('UAE after 1 year', annualLeaveDays('UAE', '2024-01-01', '2026-01-01')?.days, 30);
check('UAE at 8 months', annualLeaveDays('UAE', '2025-05-01', '2026-01-01')?.days, 16);
check('UAE at 3 months', annualLeaveDays('UAE', '2025-10-01', '2026-01-01')?.days, 0);
check('Egypt under 10 years', annualLeaveDays('EGY', '2020-01-01', '2026-01-01')?.days, 21);
check('Egypt at 10 years', annualLeaveDays('EGY', '2016-01-01', '2026-01-01')?.days, 30);
check('Egypt at 8 months', annualLeaveDays('EGY', '2025-05-01', '2026-01-01')?.days, 15);
check('Jordan under 5 years', annualLeaveDays('JOR', '2023-01-01', '2026-01-01')?.days, 14);
check('Jordan at 5 years', annualLeaveDays('JOR', '2021-01-01', '2026-01-01')?.days, 21);
check('unknown country', annualLeaveDays('QAT', '2021-01-01'), null);

/* ------------------------------------------------------------ probation */
section('Probation caps');

check('KSA 90 days valid', validateProbation('KSA', 90)?.valid, true);
check('KSA 180 days valid by agreement', validateProbation('KSA', 180)?.valid, true);
check('KSA 181 days invalid', validateProbation('KSA', 181)?.valid, false);
check('UAE 180 days valid', validateProbation('UAE', 180)?.valid, true);
check('Egypt 90 days valid (was 30 in the old code)', validateProbation('EGY', 90)?.valid, true);
check('Jordan 91 days invalid', validateProbation('JOR', 91)?.valid, false);

/* ------------------------------------------------------------- gratuity */
section('Gratuity — KSA');

// 10,000/month, exactly 5 years, terminated: 5 x 0.5 month = 2.5 months.
near(
  'KSA 5 years terminated',
  calculateGratuity({ country: 'KSA', hireDate: '2021-01-01', endDate: '2026-01-01', monthlyWage: 10000 })!.amount,
  25000,
);

// 10 years: 5 x 0.5 + 5 x 1.0 = 7.5 months.
near(
  'KSA 10 years terminated',
  calculateGratuity({ country: 'KSA', hireDate: '2016-01-01', endDate: '2026-01-01', monthlyWage: 10000 })!.amount,
  75000,
);

check(
  'KSA resignation under 2 years pays nothing',
  calculateGratuity({
    country: 'KSA', hireDate: '2025-01-01', endDate: '2026-01-01',
    monthlyWage: 10000, reason: 'resignation',
  })!.amount,
  0,
);

near(
  'KSA resignation at 3 years pays one third',
  calculateGratuity({
    country: 'KSA', hireDate: '2023-01-01', endDate: '2026-01-01',
    monthlyWage: 10000, reason: 'resignation',
  })!.amount,
  5000,
);

near(
  'KSA resignation at 7 years pays two thirds',
  calculateGratuity({
    country: 'KSA', hireDate: '2019-01-01', endDate: '2026-01-01',
    monthlyWage: 10000, reason: 'resignation',
  })!.amount,
  30000,
);

near(
  'KSA resignation at 10 years pays full',
  calculateGratuity({
    country: 'KSA', hireDate: '2016-01-01', endDate: '2026-01-01',
    monthlyWage: 10000, reason: 'resignation',
  })!.amount,
  75000,
);

near(
  'KSA pays partial years pro rata',
  calculateGratuity({ country: 'KSA', hireDate: '2023-07-01', endDate: '2026-01-01', monthlyWage: 10000 })!.amount,
  12500,
  200,
);

section('Gratuity — UAE');

check(
  'UAE under 1 year pays nothing',
  calculateGratuity({ country: 'UAE', hireDate: '2025-06-01', endDate: '2026-01-01', monthlyWage: 8000 })!.amount,
  0,
);

// 3 years x 21 days = 63 days = 2.1 months of basic wage.
near(
  'UAE 3 years',
  calculateGratuity({ country: 'UAE', hireDate: '2023-01-01', endDate: '2026-01-01', basicMonthlyWage: 8000, monthlyWage: 12000 })!.amount,
  16800,
  100,
);

check(
  'UAE resignation is not reduced under the 2021 law',
  calculateGratuity({
    country: 'UAE', hireDate: '2023-01-01', endDate: '2026-01-01',
    basicMonthlyWage: 8000, monthlyWage: 8000, reason: 'resignation',
  })!.reductionFactor,
  1,
);

check(
  'UAE caps at two years of wage',
  calculateGratuity({ country: 'UAE', hireDate: '1990-01-01', endDate: '2026-01-01', basicMonthlyWage: 8000, monthlyWage: 8000 })!.capApplied,
  true,
);

section('Gratuity — Egypt and Jordan');

check(
  'Egypt returns conditional, not a hard number',
  calculateGratuity({ country: 'EGY', hireDate: '2020-01-01', endDate: '2026-01-01', monthlyWage: 20000 })!.amount,
  null,
);
check(
  'Egypt is flagged conditional',
  calculateGratuity({ country: 'EGY', hireDate: '2020-01-01', endDate: '2026-01-01', monthlyWage: 20000 })!.conditional,
  true,
);
check(
  'Jordan returns conditional',
  calculateGratuity({ country: 'JOR', hireDate: '2020-01-01', endDate: '2026-01-01', monthlyWage: 700 })!.amount,
  null,
);

/* ---------------------------------------------------------------- leave */
section('Leave balance and validation');

const noRecords: LeaveRecord[] = [];
const pending: LeaveRecord[] = [{
  id: 'lv-001', employeeId: 'e1', type: 'annual',
  startDate: '2026-04-01', endDate: '2026-04-10', days: 10,
  status: 'pending', createdAt: '2026-03-01',
}];

check('KSA senior balance is 30', balance('KSA', '2018-01-01', 'annual', noRecords, '2026-01-01')?.remaining, 30);
check('pending days are reserved', balance('KSA', '2018-01-01', 'annual', pending, '2026-01-01')?.remaining, 20);

/* --------------------------------------------- the leave year window */
// Regression: reservedDays summed every record ever, so an employee with
// years of history showed zero remaining against a 30-day entitlement.
const priorYears: LeaveRecord[] = [
  { id: 'lv-2019', employeeId: 'e1', type: 'annual', startDate: '2019-04-01', endDate: '2019-04-28', days: 28, status: 'approved', createdAt: '2019-03-01' },
  { id: 'lv-2020', employeeId: 'e1', type: 'annual', startDate: '2020-04-01', endDate: '2020-04-28', days: 28, status: 'approved', createdAt: '2020-03-01' },
  { id: 'lv-2026', employeeId: 'e1', type: 'annual', startDate: '2026-03-01', endDate: '2026-03-05', days: 5, status: 'approved', createdAt: '2026-02-01' },
];

check('earlier years do not count against this year',
  balance('KSA', '2018-01-01', 'annual', priorYears, '2026-06-01')?.remaining, 25);
check('this year’s leave does count',
  balance('KSA', '2018-01-01', 'annual', priorYears, '2026-06-01')?.reserved, 5);
check('the balance names the year it describes',
  balance('KSA', '2018-01-01', 'annual', priorYears, '2026-06-01')?.period.label, '2026');
check('a different year sees a different total',
  balance('KSA', '2018-01-01', 'annual', priorYears, '2019-06-01')?.reserved, 28);

// A request for next January is checked against next year's balance.
check('leave booked into the new year uses the new year’s balance',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'annual',
    startDate: '2027-01-05', endDate: '2027-01-09',
    records: priorYears, asOf: '2026-12-20',
  }).ok, true);

check(
  'request within balance is accepted',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'annual',
    startDate: '2026-05-01', endDate: '2026-05-05', records: noRecords, asOf: '2026-04-01',
  }).ok,
  true,
);

check(
  'request beyond balance is refused',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'annual',
    startDate: '2026-05-01', endDate: '2026-07-01', records: noRecords, asOf: '2026-04-01',
  }).reason,
  'insufficient_balance',
);

check(
  'reversed dates are refused',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'annual',
    startDate: '2026-05-10', endDate: '2026-05-01', records: noRecords, asOf: '2026-04-01',
  }).reason,
  'end_before_start',
);

check(
  'malformed dates are refused',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'annual',
    startDate: 'next tuesday', endDate: '2026-05-01', records: noRecords, asOf: '2026-04-01',
  }).reason,
  'invalid_dates',
);

check(
  'unknown leave type is refused',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'sabbatical',
    startDate: '2026-05-01', endDate: '2026-05-05', records: noRecords, asOf: '2026-04-01',
  }).reason,
  'invalid_type',
);

check(
  'unpaid leave always needs approval',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2018-01-01', type: 'unpaid',
    startDate: '2026-05-01', endDate: '2026-06-01', records: noRecords, asOf: '2026-04-01',
  }).requiresApproval,
  true,
);

check(
  'new joiner below minimum service is refused',
  validateLeaveRequest({
    country: 'KSA', hireDate: '2025-11-01', type: 'annual',
    startDate: '2026-05-01', endDate: '2026-05-05', records: noRecords, asOf: '2026-04-01',
  }).reason,
  'below_minimum_service',
);

// Regression: measuring service as completedYears x 12 rounded this to zero
// months and wrongly refused a UAE employee their accrued 16 days.
check(
  'UAE employee at 8 months may take accrued leave',
  validateLeaveRequest({
    country: 'UAE', hireDate: '2025-05-01', type: 'annual',
    startDate: '2026-01-05', endDate: '2026-01-09', records: noRecords, asOf: '2026-01-01',
  }).ok,
  true,
);

/* ---------------------------------------------------------------- iqama */
section('Iqama alerts');

const saudi = { id: 'e1', country: 'KSA', iqamaExpiry: '2026-09-20' };
const emirati = { id: 'e2', country: 'UAE', iqamaExpiry: '2026-09-20' };

check('UAE employee is not applicable', checkIqama(emirati, '2026-08-31').applicable, false);
check(
  'UAE employee is told about the Emirates ID',
  (checkIqama(emirati, '2026-08-31') as { reason: string }).reason,
  'not_saudi',
);
check('missing expiry is not applicable', checkIqama({ id: 'e3', country: 'KSA' }, '2026-08-31').applicable, false);

const at20 = checkIqama(saudi, '2026-08-31');
check('20 days out is urgent', at20.applicable && at20.alert?.severity, 'urgent');

const at5 = checkIqama({ id: 'e1', country: 'KSA', iqamaExpiry: '2026-09-05' }, '2026-08-31');
check('5 days out is critical', at5.applicable && at5.alert?.severity, 'critical');

const at75 = checkIqama({ id: 'e1', country: 'KSA', iqamaExpiry: '2026-11-14' }, '2026-08-31');
check('75 days out is a warning', at75.applicable && at75.alert?.severity, 'warning');

const far = checkIqama({ id: 'e1', country: 'KSA', iqamaExpiry: '2027-06-01' }, '2026-08-31');
check('beyond 90 days raises nothing', far.applicable && far.alert, null);

const expired = checkIqama({ id: 'e1', country: 'KSA', iqamaExpiry: '2026-08-01' }, '2026-08-31');
check('already expired is caught', expired.applicable && expired.alert?.severity, 'expired');

const sweep = sweepIqamaExpiry(
  [
    { id: 'a', country: 'KSA', iqamaExpiry: '2026-11-01' },
    { id: 'b', country: 'KSA', iqamaExpiry: '2026-08-15' },
    { id: 'c', country: 'UAE', iqamaExpiry: '2026-09-01' },
    { id: 'd', country: 'KSA', iqamaExpiry: '2026-09-10' },
  ],
  '2026-08-31',
);
check('sweep skips non-Saudi staff', sweep.length, 3);
check('sweep puts the most urgent first', sweep[0].employeeId, 'b');
check('sweep orders by urgency', sweep.map((a) => a.employeeId), ['b', 'd', 'a']);

/* --------------------------------------------------------------- result */
console.log(`\n${'-'.repeat(52)}`);
console.log(`PASS ${passed}   FAIL ${failed}`);
if (failed > 0) process.exit(1);
