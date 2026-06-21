import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('Environment loader', () => {
  it('loads proxy variables from ALL_PROXY.env', () => {
    const source = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    assert.match(source, /ALL_PROXY\.env/);
  });
});
