import { describe, expect, it } from 'vitest';
import { authPhaseAfterBootstrap } from './bootstrap-policy.js';

describe('authPhaseAfterBootstrap', () => {
  it('continues into device flow when the optional client secret is empty', () => {
    expect(authPhaseAfterBootstrap('')).toBe('device');
    expect(authPhaseAfterBootstrap('   ')).toBe('device');
  });

  it('continues into browser authorization when a client secret was saved', () => {
    expect(authPhaseAfterBootstrap('secret')).toBe('access');
  });
});
