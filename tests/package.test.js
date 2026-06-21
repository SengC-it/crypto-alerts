import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('Package scripts', () => {
  it('runs JavaScript test files explicitly on current Node versions', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --test tests/*.js');
  });
});
