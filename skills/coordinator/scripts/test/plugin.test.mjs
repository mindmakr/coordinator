// The plugin's listing icon: a square PNG of 512 to 2048 px, under 2 MB (claude plugin validate, ICON_MISSING).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the plugin icon is a square PNG of 512-2048 px under 2 MB', () => {
  const b = readFileSync(new URL('../../../../.claude-plugin/icon.png', import.meta.url));
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const w = b.readUInt32BE(16); const h = b.readUInt32BE(20);
  assert.equal(w, h, 'square');
  assert.ok(w >= 512 && w <= 2048, `${w} px`);
  assert.ok(b.length < 2 * 1024 * 1024);
});
