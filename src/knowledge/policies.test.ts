/**
 * policies.test.ts — the knowledge base must not contradict the rules engine.
 *
 * Run with:  npx tsx src/knowledge/policies.test.ts
 *
 * This is the regression suite for the specific failure that sank the previous
 * implementation: the SOP text claimed Egypt got 15 days and Jordan 21, while
 * the rules engine applied 21 and 14. The agent quoted one set of numbers when
 * reading policy and a different set when calculating a balance.
 *
 * These assertions scan the generated policy prose for every entitlement
 * figure and check it against what the engine actually returns, so the two can
 * never drift apart again.
 */

import { POLICIES, searchTextFor, type PolicyDocument } from './policies';
import { COUNTRY_RULES, supportedCountries } from '../domain/countryRules';
import { SICK_LEAVE } from '../domain/leave';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

function policy(id: string): PolicyDocument {
  const found = POLICIES.find((p) => p.id === id);
  if (!found) throw new Error(`No policy with id ${id}`);
  return found;
}

/**
 * Policy prose is hard-wrapped, so a phrase can straddle a newline. Collapse
 * whitespace before matching — otherwise these assertions fail on line
 * breaks rather than on content, which is a test that lies.
 */
function prose(id: string): string {
  return policy(id).content.replace(/\s+/g, ' ');
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------- basic integrity */
section('Document integrity');

check('every policy has a unique id', new Set(POLICIES.map((p) => p.id)).size === POLICIES.length);
check('every policy has Arabic search terms', POLICIES.every((p) => /[؀-ۿ]/.test(p.searchText)));
check('every policy has an Arabic title', POLICIES.every((p) => /[؀-ۿ]/.test(p.titleAr)));
check('every policy has substantive content', POLICIES.every((p) => p.content.length > 500));
check('every policy names an escalation path', POLICIES.every((p) => /escalat/i.test(p.content)));
check('search text stays within a sane size', POLICIES.every((p) => searchTextFor(p).length < 12_000));

/* -------------------------------------------------- annual leave figures */
section('Annual leave: policy text vs rules engine');

const annualLeave = policy('sop-annual-leave').content;

for (const code of supportedCountries()) {
  const rule = COUNTRY_RULES[code];

  const atOneYear = rule.annualLeaveDays({ years: 1, months: 12 });
  const atSix = rule.annualLeaveDays({ years: 6, months: 72 });
  const atTwelve = rule.annualLeaveDays({ years: 12, months: 144 });

  // Pull the line for this country out of the generated table.
  const line = annualLeave
    .split('\n')
    .find((l) => l.startsWith(`- ${rule.name}:`));

  check(`${code} appears in the leave policy`, Boolean(line), `no line beginning "- ${rule.name}:"`);
  if (!line) continue;

  const quoted = (line.match(/(\d+) days/g) ?? []).map((m) => Number(m.replace(/\D/g, '')));
  const expected = [...new Set([atOneYear, atSix, atTwelve])];

  check(
    `${code} quotes exactly the engine's tiers`,
    expected.every((days) => quoted.includes(days)) && quoted.every((days) => expected.includes(days)),
    `policy says [${quoted.join(', ')}], engine gives [${expected.join(', ')}]`,
  );

  check(`${code} cites its statute`, line.includes(rule.source), `missing "${rule.source}"`);
}

// The specific numbers that were wrong before. Pinned explicitly.
check('Egypt is 21/30, not the old 15/21', /Egypt: 21 days.*30 days after 10 years/.test(annualLeave));
check('Jordan is 14/21, not the old 21/30', /Jordan: 14 days.*21 days after 5 years/.test(annualLeave));
check('no stale "15 days" claim for Egypt', !/Egypt: 15 days/.test(annualLeave));
check('no stale "30 days after 5 years" claim for Jordan', !/Jordan.*30 days after 5 years/.test(annualLeave));

/* ---------------------------------------------------- sick leave figures */
section('Sick leave: policy text vs rules engine');

const sickLeave = policy('sop-sick-leave').content;

for (const code of supportedCountries()) {
  const tiers = SICK_LEAVE[code] ?? [];
  const line = sickLeave.split('\n').find((l) => l.startsWith(`- ${COUNTRY_RULES[code].name}:`));

  check(`${code} appears in the sick leave policy`, Boolean(line));
  if (!line) continue;

  check(
    `${code} quotes every tier the engine defines`,
    tiers.every((t) => line.includes(`${t.days} days at ${t.label}`)),
    `line: ${line}`,
  );
}

check(
  'KSA sick leave is described as graduated, not a flat total',
  /30 days at full pay.*60 days at three-quarter pay.*30 days at unpaid/.test(sickLeave),
);
check('sick leave policy warns against quoting the sum', /not a single flat allowance|not the sum/i.test(sickLeave.replace(/\s+/g, ' ')));

/* ----------------------------------------------------- probation figures */
section('Probation: policy text vs rules engine');

const onboarding = policy('sop-onboarding').content;

for (const code of supportedCountries()) {
  const rule = COUNTRY_RULES[code];
  const line = onboarding.split('\n').find((l) => l.startsWith(`- ${rule.name}: maximum`));

  check(`${code} probation appears`, Boolean(line));
  if (!line) continue;

  check(
    `${code} quotes the engine's cap of ${rule.probationMaxDays}`,
    line.includes(`maximum ${rule.probationMaxDays} days`),
    `line: ${line}`,
  );

  if (rule.probationExtendableToDays) {
    check(
      `${code} mentions the extension to ${rule.probationExtendableToDays}`,
      line.includes(`${rule.probationExtendableToDays} days by written agreement`),
    );
  }
}

check('Egypt probation is 90 days, not the old 30', /Egypt: maximum 90 days/.test(onboarding));
check('Jordan probation is 90 days, not the old 30', /Jordan: maximum 90 days/.test(onboarding));
check('UAE probation is 180 days, not the old 90', /United Arab Emirates: maximum 180 days/.test(onboarding));

/* ------------------------------------------------------ gratuity content */
section('Gratuity policy');

const gratuity = prose('sop-gratuity');

check('KSA resignation tiers are stated', /nothing below two years.*one third.*two thirds.*full award at ten years/i.test(gratuity));
check('UAE resignation reduction is described as abolished', /no reduction for resignation|abolished/i.test(gratuity));
check('UAE basic-wage-only basis is called out', /basic wage only|allowances are excluded/i.test(gratuity));
check('UAE two-year cap is stated', /capped at two years/i.test(gratuity));
check('Egypt and Jordan are marked indicative', /indicative only/i.test(gratuity));
check('Egypt and Jordan route to social insurance', /social insurance.*Social Security/i.test(gratuity));
check('no invented 18-day Egyptian formula', !/18 days/.test(gratuity));
check('no invented 15-day Jordanian formula', !/15 days/.test(gratuity));

/* ------------------------------------------------- country-scoped policy */
section('Country scoping');

const exitVisa = policy('sop-exit-reentry');
const exitVisaProse = prose('sop-exit-reentry');

check('exit/re-entry visa is scoped to KSA only', Array.isArray(exitVisa.countries) && exitVisa.countries.length === 1 && exitVisa.countries[0] === 'KSA');
check('exit/re-entry says it does not apply elsewhere', /do not require an exit and re-entry visa/i.test(exitVisaProse));
check('exit/re-entry references the Iqama alert tiers', /ninety, sixty, thirty and seven days/i.test(exitVisaProse));

check(
  'onboarding warns against asking non-Saudi staff for an Iqama',
  /Never request an Iqama from an employee based outside Saudi Arabia/i.test(prose('sop-onboarding')),
);

/* --------------------------------------------------------------- brief */
section('Coverage of the SOPs the brief names');

const ids = POLICIES.map((p) => p.id);
check('transfer requests', ids.includes('sop-transfer'));
check('salary certificate issuance', ids.includes('sop-salary-certificate'));
check('exit and re-entry visa', ids.includes('sop-exit-reentry'));
check('housing allowance', ids.includes('sop-housing-allowance'));

check(
  'housing allowance explains its effect on UAE gratuity',
  /not part of basic wage|excluded from the end-of-service/i.test(policy('sop-housing-allowance').content),
);

/* --------------------------------------------------------------- result */
console.log(`\n${'-'.repeat(52)}`);
console.log(`PASS ${passed}   FAIL ${failed}   (${POLICIES.length} documents)`);
if (failed > 0) process.exit(1);
