// Exercise real recurrence APIs without a Host, timers, or clock replacement.
// DSH_PREFIX=<isolated patched prefix> node --test runtime/tests/rrule-weekly-first-period.test.mjs
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const prefix = process.env.DSH_PREFIX;
if (!prefix) throw Error('Set DSH_PREFIX to an isolated patched candidate, not a live Host');
const runtimeRoot = resolve(prefix);
const { RRule } = await import(pathToFileURL(join(
  runtimeRoot, 'node_modules/@deepseek-ai/dsh-util-time/lib/index.js',
)));

function parseRule(expression) {
  const parsed = RRule.parse(expression, { rejectIneffectiveSetPositions: true });
  assert.equal(parsed.kind, 'accepted', parsed.detail);
  return parsed.rule;
}

test('the first full week keeps its second weekday and the two-week phase', () => {
  const rule = parseRule(
    'DTSTART:20270302T090000Z\n' +
    'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2;COUNT=2',
  );
  const first = '2027-03-02T09:00:00.000Z';
  const second = '2027-03-16T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.deepEqual(rule.resolve(first, Date.parse(first)), {
    occurrenceAt: first, nextScheduledAt: second,
  });
  assert.equal(rule.next(Date.parse(second)), undefined);
  assert.deepEqual(rule.resolve(second, Date.parse(second)), { occurrenceAt: second });
});

test('unbounded dispatch does not invent a Wednesday occurrence in the first week', () => {
  const rule = parseRule(
    'DTSTART:20270302T090000Z\n' +
    'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2',
  );
  const first = '2027-03-02T09:00:00.000Z';
  const second = '2027-03-16T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first)), second);
  assert.deepEqual(rule.resolve(first, Date.parse('2027-03-04T09:00:00.000Z')), {
    occurrenceAt: first, nextScheduledAt: second,
  });
});

test('a Wednesday week start ranks Thursday as the second weekday', () => {
  const rule = parseRule(
    'DTSTART:20270304T090000Z\n' +
    'RRULE:FREQ=WEEKLY;WKST=WE;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2;COUNT=2',
  );
  const first = '2027-03-04T09:00:00.000Z';
  const second = '2027-03-11T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), undefined);
});

test('full-week positions retain DTSTART minute and second defaults', () => {
  const rule = parseRule(
    'DTSTART:20270302T174213Z\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,17;BYSETPOS=4;COUNT=2',
  );
  const first = '2027-03-02T17:42:13.000Z';
  const second = '2027-03-09T17:42:13.000Z';
  // Monday has the first two clock candidates; Tuesday at 17:42:13 is fourth.
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), undefined);
});

test('positive and negative positions selecting Tuesday consume one COUNT instance', () => {
  const rule = parseRule(
    'DTSTART:20270302T090000Z\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2,-4;COUNT=2',
  );
  const first = '2027-03-02T09:00:00.000Z';
  const second = '2027-03-09T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), second);
  assert.equal(rule.next(Date.parse(second)), undefined);
});

test('UNTIL includes the matching first position and then exhausts the rule', () => {
  const rule = parseRule(
    'DTSTART:20270302T090000Z\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2;UNTIL=20270302T090000Z',
  );
  const first = '2027-03-02T09:00:00.000Z';
  assert.equal(rule.next(Date.parse(first) - 1), first);
  assert.equal(rule.next(Date.parse(first)), undefined);
  assert.deepEqual(rule.resolve(first, Date.parse(first)), { occurrenceAt: first });
});
