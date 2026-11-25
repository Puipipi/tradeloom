// Exercise the real recurrence API without a Host, timers, or clock replacement.
// DSH_PREFIX=<isolated patched prefix> node --test runtime/tests/rrule-mixed-byday.test.mjs
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

test('COUNT includes the first Monday and ordinary Tuesdays in one BYDAY list', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,TU;COUNT=3',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const second = '2027-03-02T09:00:00.000Z';
  const third = '2027-03-09T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), third);
  assert.equal(rule.next(Date.parse(third)), undefined);
  assert.deepEqual(rule.resolve(first, Date.parse(second)), {
    occurrenceAt: second, nextScheduledAt: third,
  });
});

test('unbounded dispatch resolves the latest ordinary weekday in a mixed list', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,TU',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const decision = Date.parse('2027-03-10T09:00:00.000Z');
  const next = '2027-03-16T09:00:00.000Z';
  assert.equal(rule.next(decision), next);
  assert.deepEqual(rule.resolve(first, decision), {
    occurrenceAt: '2027-03-09T09:00:00.000Z', nextScheduledAt: next,
  });
});

test('an ordinary weekday overlapping its ordinal consumes COUNT once', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO,1MO;COUNT=3',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const second = '2027-03-08T09:00:00.000Z';
  const third = '2027-03-15T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), third);
  assert.equal(rule.next(Date.parse(third)), undefined);
});

test('a negative ordinal joins ordinary weekdays in chronological order', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=MO,-1FR;COUNT=6',
  );
  const expected = [
    '2027-03-01T09:00:00.000Z',
    '2027-03-08T09:00:00.000Z',
    '2027-03-15T09:00:00.000Z',
    '2027-03-22T09:00:00.000Z',
    '2027-03-26T09:00:00.000Z',
    '2027-03-29T09:00:00.000Z',
  ];
  assert.equal(rule.next(Date.parse(expected[0]) - 1), expected[0]);
  for (let index = 1; index < expected.length; index += 1) {
    assert.equal(rule.next(Date.parse(expected[index - 1])), expected[index]);
  }
  assert.equal(rule.next(Date.parse(expected.at(-1))), undefined);
});

test('an absent fifth Monday does not remove ordinary Tuesdays from February', () => {
  const rule = parseRule(
    'DTSTART:20270202T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=5MO,TU;COUNT=3',
  );
  const first = '2027-02-02T09:00:00.000Z';
  const second = '2027-02-09T09:00:00.000Z';
  const third = '2027-02-16T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), third);
  assert.equal(rule.next(Date.parse(third)), undefined);
});

test('YEARLY mixed weekdays preserve selected months and the two-year phase', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=3,9;BYDAY=1MO,TU',
  );
  const first = '2027-03-01T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse('2027-03-30T09:00:00.000Z')), '2027-09-06T09:00:00.000Z');
  assert.equal(rule.next(Date.parse('2027-09-28T09:00:00.000Z')), '2029-03-05T09:00:00.000Z');
});

test('other BY parts still intersect mixed weekdays and UNTIL ends enumeration', () => {
  const rule = parseRule(
    'DTSTART:20270301T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,TU;BYMONTHDAY=1,2,8,9;UNTIL=20270331T090000Z',
  );
  const first = '2027-03-01T09:00:00.000Z';
  const second = '2027-03-02T09:00:00.000Z';
  const third = '2027-03-09T09:00:00.000Z';
  // March 8 matches BYMONTHDAY but is neither the first Monday nor a Tuesday.
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), third);
  assert.equal(rule.next(Date.parse(third)), undefined);
});

test('BYSETPOS ranks the union before applying the DTSTART cutoff', () => {
  const rule = parseRule(
    'DTSTART:20270302T090000Z\n' +
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,TU;BYSETPOS=2;COUNT=2',
  );
  const first = '2027-03-02T09:00:00.000Z';
  const second = '2027-04-06T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), undefined);
});

test('absent, ordinary-only, and ordinal-only BYDAY retain their behavior', () => {
  const cases = [
    {
      name: 'no BYDAY keeps the first day of each month',
      expression: 'DTSTART:20270301T090000Z\nRRULE:FREQ=MONTHLY;COUNT=2',
      first: '2027-03-01T09:00:00.000Z',
      second: '2027-04-01T09:00:00.000Z',
    },
    {
      name: 'ordinary Tuesdays',
      expression: 'DTSTART:20270302T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=TU;COUNT=2',
      first: '2027-03-02T09:00:00.000Z',
      second: '2027-03-09T09:00:00.000Z',
    },
    {
      name: 'ordinal first Mondays',
      expression: 'DTSTART:20270301T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=2',
      first: '2027-03-01T09:00:00.000Z',
      second: '2027-04-05T09:00:00.000Z',
    },
  ];
  for (const { name, expression, first, second } of cases) {
    const rule = parseRule(expression);
    assert.equal(rule.next(Date.parse(first) - 1), first, name);
    assert.equal(rule.next(Date.parse(first)), second, name);
    assert.equal(rule.next(Date.parse(second)), undefined, name);
  }
});
