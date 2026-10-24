import { describe, it, expect, afterEach } from 'vitest';
import {
  recordRerankTimeout,
  rerankCoolingDown,
  _resetRerankCooldownForTest,
} from '../../../src/search/rerank-cooldown.js';

describe('rerank cooldown', () => {
  afterEach(() => {
    _resetRerankCooldownForTest();
  });

  it('is not cooling down before any timeout', () => {
    expect(rerankCoolingDown()).toBe(false);
  });

  it('cools down for 60s after a timeout, then expires', () => {
    recordRerankTimeout(1_000);
    expect(rerankCoolingDown(1_000)).toBe(true);
    expect(rerankCoolingDown(60_999)).toBe(true);
    expect(rerankCoolingDown(61_000)).toBe(false);
  });

  it('a later timeout restarts the window', () => {
    recordRerankTimeout(1_000);
    recordRerankTimeout(30_000);
    expect(rerankCoolingDown(61_000)).toBe(true);
    expect(rerankCoolingDown(90_000)).toBe(false);
  });
});
