// Exercise the real recurrence API without a Host, timers, or clock replacement.
// DSH_PREFIX=<isolated patched prefix> node --test runtime/tests/rrule-negative-position.test.mjs
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const prefix = process.env.DSH_PREFIX;
if (!prefix) throw Error('Set DSH_PREFIX to an isolated patched candidate, not a live Host');
const { RRule } = await import(pathToFileURL(join(
  resolve(prefix), 'node_modules/@deepseek-ai/dsh-util-time/lib/index.js',
)));

function parseRule(expression) {
  const parsed = RRule.parse(expression, { rejectIneffectiveSetPositions: true });
  assert.equal(parsed.kind, 'accepted', parsed.detail);
  return parsed.rule;
}

test('COUNT skips a month with fewer occurrences than the negative position', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-5;COUNT=2',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const second = '2027-05-03T09:00:00.000Z';
  // March and May have five Mondays; April has only four.
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.deepEqual(rule.resolve(first, Date.parse(first)), {
    occurrenceAt: first, nextScheduledAt: second,
  });
  assert.equal(rule.next(Date.parse(second)), undefined);
  assert.deepEqual(rule.resolve(second, Date.parse(second)), { occurrenceAt: second });
});

test('an unbounded rule does not treat the first Monday of April as due', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-5',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const next = '2027-05-03T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first)), next);
  assert.deepEqual(rule.resolve(first, Date.parse('2027-04-05T09:00:00.000Z')), {
    occurrenceAt: first, nextScheduledAt: next,
  });
});

test('a valid negative last position still selects from a four-Monday month', () => {
  const rule = parseRule(
    'DTSTART:20270329T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;COUNT=2',
  );
  assert.equal(rule.next(Date.parse('2027-03-29T09:00:00.000Z')), '2027-04-26T09:00:00.000Z');
  assert.equal(rule.next(Date.parse('2027-04-26T09:00:00.000Z')), undefined);
});

test('a positive fifth position also skips the four-Monday month', () => {
  const rule = parseRule(
    'DTSTART:20270329T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5;COUNT=2',
  );
  assert.equal(rule.next(Date.parse('2027-03-29T09:00:00.000Z')), '2027-05-31T09:00:00.000Z');
  assert.equal(rule.next(Date.parse('2027-05-31T09:00:00.000Z')), undefined);
});

test('a negative position skips an empty filtered month', () => {
  const rule = parseRule(
    'DTSTART:20270329T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=29,30,31;BYSETPOS=-1;COUNT=2',
  );
  const first = '2027-03-29T09:00:00.000Z';
  const next = '2027-05-31T09:00:00.000Z';
  // No April date is both a Monday and one of 29, 30, 31.
  assert.equal(rule.next(Date.parse(first)), next);
  assert.deepEqual(rule.resolve(first, Date.parse('2027-04-30T23:59:59.999Z')), {
    occurrenceAt: first, nextScheduledAt: next,
  });
});

test('negative positions count every time of day before checking the period bound', () => {
  const rule = parseRule(
    'DTSTART:20270301T170000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYHOUR=9,17;BYSETPOS=-9;COUNT=2',
  );
  const first = '2027-03-01T17:00:00.000Z';
  const second = '2027-05-03T17:00:00.000Z';
  // Ten March/May candidates make -9 the second; April has only eight.
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.deepEqual(rule.resolve(first, Date.parse(first)), {
    occurrenceAt: first, nextScheduledAt: second,
  });
  assert.equal(rule.next(Date.parse(second)), undefined);
});
