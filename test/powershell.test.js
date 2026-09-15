const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonOutput, wrapScript, PowerShellError } = require('../src/powershell');

test('parseJsonOutput: 空出力は0件', () => {
  assert.deepEqual(parseJsonOutput(''), []);
  assert.deepEqual(parseJsonOutput('  \r\n'), []);
});

test('parseJsonOutput: 単一オブジェクトは配列に包む', () => {
  assert.deepEqual(parseJsonOutput('{"LocalPort":3000}'), [{ LocalPort: 3000 }]);
});

test('parseJsonOutput: 配列はそのまま返す', () => {
  assert.deepEqual(parseJsonOutput('[{"LocalPort":1},{"LocalPort":2}]'), [{ LocalPort: 1 }, { LocalPort: 2 }]);
});

test('parseJsonOutput: 不正なJSONは PowerShellError を投げる', () => {
  assert.throws(() => parseJsonOutput('WARNING: something'), PowerShellError);
});

test('wrapScript: 該当なしのみ成功扱いにし、UTF-8出力を指定する', () => {
  const script = wrapScript('Get-NetTCPConnection');
  assert.match(script, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.match(script, /CmdletizationQuery_NotFound\*/);
  assert.match(script, /exit 1/);
});
