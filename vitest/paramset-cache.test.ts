/**
 * Unit tests for the paramset description cache.
 *
 * @file vitest/paramset-cache.test.ts
 */

import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildParamsetKey, ParamsetCache } from '../src/ccu/paramset-cache.js';
import type { CcuLogger } from '../src/ccu/types.js';

function makeLogger(): CcuLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('buildParamsetKey', () => {
  test('should return a slash-separated key string when all components are known', () => {
    const key = buildParamsetKey('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(key).toBe('HmIP-RF/HmIP-WRC2/1.4.2/0/MAINTENANCE/VALUES');
  });

  test('should use empty string for firmware when firmware is undefined', () => {
    const key = buildParamsetKey('HmIP-RF', 'HmIP-WRC2', undefined, 0, 'MAINTENANCE', 'VALUES');
    expect(key).toBe('HmIP-RF/HmIP-WRC2//0/MAINTENANCE/VALUES');
  });

  test('should return undefined when deviceType is undefined', () => {
    const key = buildParamsetKey('HmIP-RF', undefined, '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(key).toBeUndefined();
  });

  test('should include the paramset key suffix correctly', () => {
    const master = buildParamsetKey('BidCos-RF', 'HM-LC-Sw1-FM', '2.5', 0, 'MAINTENANCE', 'MASTER');
    expect(master).toBe('BidCos-RF/HM-LC-Sw1-FM/2.5/0/MAINTENANCE/MASTER');
  });
});

describe('ParamsetCache', () => {
  const cacheDir = path.join('.cache', 'vitest', 'paramset-cache');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any overlay written during tests
    const { promises: fs } = await import('node:fs');
    const overlayPath = path.join(cacheDir, 'matterbridge-homematic-paramset.cache.json');
    await fs.rm(overlayPath, { force: true });
  });

  test('should return undefined on lookup when neither seed nor overlay contains the key', async () => {
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load('/nonexistent/paramsets.json');

    const result = cache.lookup('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(result).toBeUndefined();
  });

  test('should return undefined when deviceType is undefined', async () => {
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load('/nonexistent/paramsets.json');

    const result = cache.lookup('HmIP-RF', undefined, '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(result).toBeUndefined();
  });

  test('should store and retrieve a description from the overlay', async () => {
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load('/nonexistent/paramsets.json');

    const desc = { LOW_BAT: { TYPE: 'BOOL' } };
    cache.store('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES', desc);

    const result = cache.lookup('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(result).toEqual(desc);
  });

  test('should not store entries when deviceType is undefined', async () => {
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load('/nonexistent/paramsets.json');

    cache.store('HmIP-RF', undefined, '1.4.2', 0, 'MAINTENANCE', 'VALUES', { LOW_BAT: { TYPE: 'BOOL' } });

    const result = cache.lookup('HmIP-RF', undefined, '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(result).toBeUndefined();
  });

  test('should persist overlay to disk and load it on next instantiation', async () => {
    const logger = makeLogger();
    const { promises: fs } = await import('node:fs');
    await fs.mkdir(cacheDir, { recursive: true });

    const cache1 = new ParamsetCache(logger, cacheDir);
    await cache1.load('/nonexistent/paramsets.json');

    const desc = { LOW_BAT: { TYPE: 'BOOL' } };
    cache1.store('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES', desc);
    await cache1.save();

    // New instance should load the overlay from disk
    const cache2 = new ParamsetCache(logger, cacheDir);
    await cache2.load('/nonexistent/paramsets.json');

    const result = cache2.lookup('HmIP-RF', 'HmIP-WRC2', '1.4.2', 0, 'MAINTENANCE', 'VALUES');
    expect(result).toEqual(desc);
  });

  test('should not write when save is called with no stored entries', async () => {
    const { promises: fs } = await import('node:fs');
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load('/nonexistent/paramsets.json');

    await cache.save();

    const overlayPath = path.join(cacheDir, 'matterbridge-homematic-paramset.cache.json');
    await expect(fs.access(overlayPath)).rejects.toThrow();
  });

  test('should load real paramsets from the bundled seed file', async () => {
    const cache = new ParamsetCache(makeLogger(), cacheDir);
    // Load with default seed path (project-root paramsets.json)
    await cache.load();

    // The seed has HmIP-RF/HmIP-SMI/1.0.3/1/MAINTENANCE/VALUES — channel index 1
    const result = cache.lookup('HmIP-RF', 'HmIP-SMI', '1.0.3', 1, 'MAINTENANCE', 'VALUES');
    expect(result).toBeDefined();
    expect(result).toHaveProperty('LOW_BAT');
  });

  test('should prefer overlay over seed when both have the same key', async () => {
    const { promises: fs } = await import('node:fs');
    await fs.mkdir(cacheDir, { recursive: true });

    // Pre-write an overlay entry for a key that also exists in the seed
    const overlayPath = path.join(cacheDir, 'matterbridge-homematic-paramset.cache.json');
    const overlayEntry = { CUSTOM_MARKER: { TYPE: 'BOOL' } };
    await fs.writeFile(overlayPath, JSON.stringify({ 'HmIP-RF/HmIP-SMI/1.0.3/1/MAINTENANCE/VALUES': overlayEntry }), 'utf-8');

    const cache = new ParamsetCache(makeLogger(), cacheDir);
    await cache.load();

    const result = cache.lookup('HmIP-RF', 'HmIP-SMI', '1.0.3', 1, 'MAINTENANCE', 'VALUES');
    // Overlay wins over seed
    expect(result).toEqual(overlayEntry);
  });
});
