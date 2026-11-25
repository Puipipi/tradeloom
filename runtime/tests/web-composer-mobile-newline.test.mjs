// Execute the shipped Lexical core, plain-text plugin and composer keymap in Node.
// Only the mobile classifier and view callbacks are injected; editor text, selection,
// command priorities and line-break insertion are real. This is not a browser/IME test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const modulePath = process.env.DSH_UI_CONVERSATION_MODULE
  ?? (prefix && join(prefix, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'));
if (!modulePath) throw Error('Set DSH_TEST_PREFIX or DSH_UI_CONVERSATION_MODULE to the installed client bundle');
const source = readFileSync(modulePath, 'utf8');
function region(marker) {
  const start = source.indexOf(marker);
  const end = source.indexOf('//#endregion', start);
  assert(start >= 0 && end > start, `Missing shipped region: ${marker}`);
  return source.slice(start, end);
}
const program = [
  region('//#region ../../../node_modules/.pnpm/lexical@0.49.0_'),
  region('//#region ../../../node_modules/.pnpm/@lexical+plain-text@0.49.0_'),
  region('//#region lib/types/client/input/editor/keymap.js'),
  '({createEditor:ys, root:nl, plain:O$1, keymap:registerComposerKeymap, enter:cn$1})',
].join('\n');

function fixture(t, {mobile = true, text = 'hello', arbitrate = 'pass', canSubmit = true} = {}) {
  const api = new vm.Script(program, {filename: modulePath}).runInNewContext({
    URL, URLSearchParams, console, setTimeout, clearTimeout, queueMicrotask,
    _deepseek_ai_dsh_client_ui_primitives: {isMobileDevice: () => mobile},
  });
  const editor = api.createEditor({namespace: 'synthetic-newline', onError(error) { throw error; }});
  const state = {root: {children: [{
    children: text ? [{detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1}] : [],
    direction: null, format: '', indent: 0, type: 'paragraph', version: 1, textFormat: 0, textStyle: '',
  }], direction: null, format: '', indent: 0, type: 'root', version: 1}};
  editor.setEditorState(editor.parseEditorState(JSON.stringify(state)));
  editor.update(() => api.root().selectEnd(), {discrete: true});
  const plain = api.plain(editor);
  const submissions = [];
  const keymap = api.keymap(editor, {
    arbitrate: () => arbitrate, canSubmit: () => canSubmit,
    submit: accelerated => submissions.push(accelerated), dismissPopup() {}, space: () => false,
  });
  t.after(() => { keymap(); plain(); });
  return {
    submissions,
    text: () => editor.getEditorState().read(() => api.root().getTextContent()),
    caret(offset) {
      editor.update(() => api.root().getFirstDescendant().select(offset, offset), {discrete: true});
    },
    enter(flags = {}) {
      let prevented = 0;
      const event = flags === null ? null : {
        key: 'Enter', keyCode: 13, ctrlKey: false, metaKey: false,
        shiftKey: false, altKey: false, isComposing: false, repeat: false,
        getModifierState: name => name === 'AltGraph' && flags.altGraph === true,
        preventDefault() { prevented++; }, ...flags,
      };
      let handled;
      editor.update(() => { handled = editor.dispatchCommand(api.enter, event); }, {discrete: true});
      return {handled, prevented};
    },
  };
}

for (const [label, event] of [['keydown payload', {}], ['null input payload', null]]) {
  test(`mobile ${label} inserts a line break without submitting`, t => {
    const f = fixture(t);
    assert.equal(f.enter(event).handled, true);
    assert.equal(f.text(), 'hello\n');
    assert.deepEqual(f.submissions, []);
  });
}
test('mobile newline preserves text on both sides of the caret', t => {
  const f = fixture(t); f.caret(2); f.enter();
  assert.equal(f.text(), 'he\nllo'); assert.deepEqual(f.submissions, []);
});
test('mobile held Enter remains line breaks instead of repeated submissions', t => {
  const f = fixture(t); f.enter(); f.enter({repeat: true});
  assert.equal(f.text(), 'hello\n\n'); assert.deepEqual(f.submissions, []);
});
test('desktop ordinary and null Enter keep the existing submit behavior', t => {
  const f = fixture(t, {mobile: false}); f.enter(); f.enter(null);
  assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, [false, false]);
});
test('desktop held Enter submits only once', t => {
  const f = fixture(t, {mobile: false}); f.enter(); f.enter({repeat: true});
  assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, [false]);
});
for (const mobile of [true, false]) {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    test(`${mobile ? 'mobile' : 'desktop'} ${modifier}+Enter keeps accelerated submission`, t => {
      const f = fixture(t, {mobile}); f.enter({[modifier]: true});
      assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, [true]);
    });
  }
  test(`${mobile ? 'mobile' : 'desktop'} Shift+Enter remains a line break`, t => {
    const f = fixture(t, {mobile}); f.enter({shiftKey: true});
    assert.equal(f.text(), 'hello\n'); assert.deepEqual(f.submissions, []);
  });
  test(`${mobile ? 'mobile' : 'desktop'} composition and keyCode 229 cannot submit`, t => {
    const f = fixture(t, {mobile});
    f.enter({isComposing: true}); f.enter({keyCode: 229});
    assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, []);
  });
  test(`${mobile ? 'mobile' : 'desktop'} popup arbitration consumes Enter first`, t => {
    const f = fixture(t, {mobile, arbitrate: 'consumed'});
    assert.deepEqual(f.enter(), {handled: true, prevented: 1});
    assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, []);
  });
  test(`${mobile ? 'mobile' : 'desktop'} unavailable accelerated submission stays blocked`, t => {
    const f = fixture(t, {mobile, canSubmit: false}); f.enter({ctrlKey: true});
    assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, []);
  });
}
test('unsupported modifier combinations remain consumed without insertion or submission', t => {
  for (const mobile of [true, false]) {
    const f = fixture(t, {mobile});
    for (const flags of [{altKey: true}, {altGraph: true}, {ctrlKey: true, metaKey: true}, {shiftKey: true, ctrlKey: true}]) f.enter(flags);
    assert.equal(f.text(), 'hello'); assert.deepEqual(f.submissions, []);
  }
});
test('a mobile empty paragraph can start with a newline', t => {
  const f = fixture(t, {text: ''}); f.enter();
  assert.equal(f.text(), '\n'); assert.deepEqual(f.submissions, []);
});
