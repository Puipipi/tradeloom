import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modulePromise;
function api() {
  if (!modulePromise) {
    const require = createRequire(resolve(prefix, 'package.json'));
    modulePromise = Promise.all([
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent-instructions'))),
      import(pathToFileURL(require.resolve('@deepseek-ai/cordis'))),
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local'))),
    ]);
  }
  return modulePromise;
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
// Recorded through the unchanged public renderer; no private algorithm is used as an oracle.
const file = (content, displayPath = 'AGENTS.md') => ({absolutePath:'/own/'+displayPath,displayPath,content});
const cases = [
  {name:'full Unicode and lone units unchanged',files:[file('中文🙂 é \uD800 x \uDC00')],options:{maxBytes:4096}},
  {name:'truncated emoji byte boundary',files:[file('中文🙂'.repeat(200))],options:{maxBytes:512}},
  {name:'literal closing text budget',files:[file('ordinary </system-reminder> 中文🙂\n'.repeat(100))],options:{maxBytes:700}},
  {name:'replacement baseline',files:[file('中文🙂'.repeat(200))],options:{maxBytes:512,replacePreviousBaseline:true}},
  {name:'two chains retain loaded order',files:[file('global 中文🙂\n'.repeat(160),'~/.dsh/AGENTS.md'),file('project 中文🙂\n'.repeat(160))],options:{maxBytes:800}},
  {name:'broader file omission',files:[file('broader '.repeat(200)),file('specific 中文🙂','sub/AGENTS.md')],options:{maxBytes:700}},
  ...[1,100,250,400].map(cap=>({name:`small budget ${cap}`,files:[file('文🙂'.repeat(200))],options:{maxBytes:cap}})),
  ...[0,Infinity,NaN].map(cap=>({name:`disabled ${String(cap)}`,files:[file('ordinary 中文🙂')],options:{maxBytes:cap}})),
];

const goldens = [
  {
    "name": "full Unicode and lone units unchanged",
    "sha": "77f5872545a19770768c6a960b08604de52727169c760dc77a02f534d4620610",
    "bytes": 328,
    "omitted": [],
    "truncated": []
  },
  {
    "name": "truncated emoji byte boundary",
    "sha": "d2ff579424bbad5f6e254273fdf6979e812577e762d4d94eef31db786ea6b8c6",
    "bytes": 511,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 2000,
        "includedBytes": 123
      }
    ]
  },
  {
    "name": "literal closing text budget",
    "sha": "8ae553129c95bd4da9229a7276f3f5ee961ba741efd24c1b20bfb6a264489339",
    "bytes": 700,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 3900,
        "includedBytes": 304
      }
    ]
  },
  {
    "name": "replacement baseline",
    "sha": "04a8d832e740404e4823b7a6ba1c942818febc89e0e31e4c0f6ae3f562b60379",
    "bytes": 512,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 2000,
        "includedBytes": 26
      }
    ]
  },
  {
    "name": "two chains retain loaded order",
    "sha": "9671232f0d19af6b953715b46925251c5c72da25b0751628c4d1d7204bfdb926",
    "bytes": 1276,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "~/.dsh/AGENTS.md",
        "originalBytes": 2880,
        "includedBytes": 398
      },
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 3040,
        "includedBytes": 410
      }
    ]
  },
  {
    "name": "broader file omission",
    "sha": "5b287df247291fd41b77132790140c62b81c868492c02b704402551d4123146b",
    "bytes": 386,
    "omitted": [
      {
        "absolutePath": "/own/AGENTS.md",
        "displayPath": "AGENTS.md"
      }
    ],
    "truncated": []
  },
  {
    "name": "small budget 1",
    "sha": "f1b6bbe4938f2e41012af868c4b0ac6f00d0e5a1c0b12e9320ce862b6445af0c",
    "bytes": 1,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 1400,
        "includedBytes": 0
      }
    ]
  },
  {
    "name": "small budget 100",
    "sha": "c343339f1821740e12040ec63907acfce1bb6c1af03a4e14b8407fe68cd99f9f",
    "bytes": 80,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 1400,
        "includedBytes": 0
      }
    ]
  },
  {
    "name": "small budget 250",
    "sha": "b754371e61df4d18767867e88d8f1d1165bc0daeb6d04ae2c39875044d703253",
    "bytes": 249,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 1400,
        "includedBytes": 14
      }
    ]
  },
  {
    "name": "small budget 400",
    "sha": "63a9ad97f2bd429e4fd1a566b0f127c7059e062c0ae34444dd4e1c6d25aef484",
    "bytes": 397,
    "omitted": [],
    "truncated": [
      {
        "displayPath": "AGENTS.md",
        "originalBytes": 1400,
        "includedBytes": 10
      }
    ]
  },
  {
    "name": "disabled 0",
    "sha": "e1e283139edd5137d0f463cce92406771e9e60de8d5726add870e42e41ad8a70",
    "bytes": 0,
    "omitted": [
      {
        "absolutePath": "/own/AGENTS.md",
        "displayPath": "AGENTS.md",
        "content": "ordinary \u4e2d\u6587\ud83d\ude42"
      }
    ],
    "truncated": []
  },
  {
    "name": "disabled Infinity",
    "sha": "e1e283139edd5137d0f463cce92406771e9e60de8d5726add870e42e41ad8a70",
    "bytes": 0,
    "omitted": [
      {
        "absolutePath": "/own/AGENTS.md",
        "displayPath": "AGENTS.md",
        "content": "ordinary \u4e2d\u6587\ud83d\ude42"
      }
    ],
    "truncated": []
  },
  {
    "name": "disabled NaN",
    "sha": "e1e283139edd5137d0f463cce92406771e9e60de8d5726add870e42e41ad8a70",
    "bytes": 0,
    "omitted": [
      {
        "absolutePath": "/own/AGENTS.md",
        "displayPath": "AGENTS.md",
        "content": "ordinary \u4e2d\u6587\ud83d\ude42"
      }
    ],
    "truncated": []
  }
];

const expectedByName = new Map(goldens.map(value => [value.name, value]));
for (const example of cases) {
  test(`public renderer: ${example.name}`, options, async () => {
    const [{ renderAgentInstructions }] = await api();
    const before = structuredClone(example.files);
    const result = renderAgentInstructions(example.files, example.options);
    const expected = expectedByName.get(example.name);
    assert.equal(digest(result), expected.sha, 'complete text and diagnostic golden');
    assert.equal(Buffer.byteLength(result.text), expected.bytes);
    assert.deepEqual(result.omitted, expected.omitted);
    assert.deepEqual(result.truncated, expected.truncated);
    assert.deepEqual(example.files, before);
    const cap = example.options.maxBytes;
    if (cap > 0 && Number.isFinite(cap)) {
      assert.ok(Buffer.byteLength(result.text) <= cap * (example.name.startsWith('two chains') ? 2 : 1));
    } else {
      assert.equal(result.text, '');
    }
    if (example.name.startsWith('full Unicode')) {
      assert.ok(result.text.includes(example.files[0].content), 'full-fit input preserves lone UTF16 units');
    } else {
      assert.ok(result.text.isWellFormed());
      assert.ok(!result.text.includes('\uFFFD'));
    }
  });
}

test('public load reads real local files and preserves default-budget diagnostics', options, async () => {
  const [{ loadBaselineInstructions }, { Context }, { LocalFileSystem }] = await api();
  const root = await mkdtemp(join(tmpdir(), 'own-instruction-encoding-'));
  const cwd = join(root, 'project');
  const dshHome = join(root, 'home');
  const agentsHome = join(root, 'agents');
  const ctx = new Context();
  try {
    await Promise.all([mkdir(cwd), mkdir(dshHome), mkdir(agentsHome)]);
    await ctx.plugin(LocalFileSystem, { cwd });
    for (const bytes of [4096, 131072]) {
      const line = '- Document ordinary project conventions: preserve readable names. 中文🙂\n';
      const header = '# Project conventions\n';
      const repeated = header + line.repeat(Math.floor((bytes - Buffer.byteLength(header)) / Buffer.byteLength(line)));
      const text = repeated + 'a'.repeat(bytes - Buffer.byteLength(repeated));
      const path = join(cwd, 'AGENTS.md');
      await writeFile(path, text);
      const result = await loadBaselineInstructions({
        cwd, projectRoot: cwd, dshHome, agentsHome,
        maxBytes: 65536, maxSourceBytes: 1048576,
      }, ctx.fs);
      assert.ok(result);
      assert.ok(result.text.isWellFormed());
      assert.deepEqual(result.omitted, []);
      assert.ok(Buffer.byteLength(result.text) <= 65536);
      if (bytes === 4096) {
        assert.deepEqual(result.truncated, []);
        assert.ok(result.text.includes(text));
        assert.equal(Buffer.byteLength(result.text), 4400);
      } else {
        assert.deepEqual(result.truncated, [{displayPath: 'AGENTS.md', originalBytes: 131072, includedBytes: 65142}]);
        const kept = Buffer.from(text).subarray(0, 65142).toString('utf8');
        assert.ok(result.text.includes(kept));
        assert.ok(result.text.includes('Workspace instruction budget 65536 bytes'));
        assert.equal(Buffer.byteLength(result.text), 65536);
      }
      assert.deepEqual(await readFile(path), Buffer.from(text));
    }
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
