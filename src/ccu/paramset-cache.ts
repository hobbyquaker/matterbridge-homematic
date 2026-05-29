/**
 * Paramset description cache for Homematic CCU RPC calls.
 *
 * Provides a two-layer cache — a read-only bundled seed database (vendored from
 * node-red-contrib-ccu) and a writable runtime overlay — so that repeated
 * `getParamsetDescription` calls for the same device type and firmware version are
 * served from disk on every startup after the first live RPC call.
 *
 * Cache key format (compatible with node-red-contrib-ccu's paramsets.json):
 *   `{interface}/{deviceType}/{firmware}/{deviceVersion}/{channelType}/{paramsetKey}`
 *
 * @example
 *   `HmIP-RF/HmIP-WRC2/1.4.2/0/MAINTENANCE/VALUES`
 *   `BidCos-RF/HM-LC-Sw1-Pl-2/2.5/0/MAINTENANCE/VALUES`
 *
 * @file paramset-cache.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CcuLogger } from './types.js';

/**
 * A flat map of cache key → raw paramset description object as returned by the CCU.
 * Each key is built with {@link ParamsetCache.buildKey}.
 */
export type ParamsetDb = Record<string, Record<string, unknown>>;

/** Paramset key selector as used by the Homematic RPC `getParamsetDescription` method. */
export type ParamsetKey = 'VALUES' | 'MASTER';

/**
 * Build a paramset cache key from the components that identify a unique paramset.
 *
 * Returns `undefined` when `deviceType` is not known, since a key without device type
 * cannot produce a meaningful cache hit.
 *
 * @param {string} iface RPC interface name (e.g. `'HmIP-RF'`).
 * @param {string | undefined} deviceType Homematic device model string (e.g. `'HmIP-WRC2'`).
 * @param {string | undefined} firmware Firmware version string (e.g. `'1.4.2'`). Use empty string when not known.
 * @param {number | undefined} deviceVersion `VERSION` integer of the root device as reported by `listDevices`. This is the 4th segment of the key (matches node-red-contrib-ccu's `paramsetName` format). Use `undefined` when not known.
 * @param {string} channelType Homematic channel type string (e.g. `'MAINTENANCE'`).
 * @param {ParamsetKey} paramsetKey Paramset selector: `'VALUES'` or `'MASTER'`.
 * @returns {string | undefined} Cache key string, or `undefined` when `deviceType` is missing.
 */
export function buildParamsetKey(
  iface: string,
  deviceType: string | undefined,
  firmware: string | undefined,
  deviceVersion: number | undefined,
  channelType: string,
  paramsetKey: ParamsetKey,
): string | undefined {
  if (!deviceType) return undefined;
  return `${iface}/${deviceType}/${firmware ?? ''}/${deviceVersion ?? ''}/${channelType}/${paramsetKey}`;
}

/**
 * Absolute path to the bundled seed paramsets database shipped with the npm package.
 *
 * When running from compiled output (`dist/ccu/paramset-cache.js`) the path resolves two
 * directories up to the package root. When running from source in tests it resolves the same
 * way since the source file is at `src/ccu/paramset-cache.ts`.
 */
const DEFAULT_SEED_PATH: string = fileURLToPath(new URL('../../paramsets.json', import.meta.url));

/**
 * Two-layer paramset description cache.
 *
 * On startup:
 *  1. The bundled seed database (`paramsets.json`) is loaded read-only.
 *  2. The writable runtime overlay is loaded from `<cacheDir>/matterbridge-homematic-paramset.cache.json`.
 *
 * Lookups check the overlay first (more recent data wins), then fall back to the seed.
 *
 * When a live RPC call returns a result it should be stored via {@link ParamsetCache.store} and
 * then flushed to disk with {@link ParamsetCache.save} so subsequent startups skip the RPC call.
 */
export class ParamsetCache {
  private seed: ParamsetDb = {};

  private overlay: ParamsetDb = {};

  private overlayDirty = false;

  private readonly overlayPath: string;

  /**
   * Create a paramset cache.
   *
   * @param {CcuLogger} log Logger for diagnostic output.
   * @param {string} cacheDir Directory where the writable overlay file is stored.
   */
  constructor(
    private readonly log: CcuLogger,
    cacheDir: string,
  ) {
    this.overlayPath = path.join(cacheDir, 'matterbridge-homematic-paramset.cache.json');
  }

  /**
   * Load the bundled seed and the writable overlay from disk.
   *
   * Missing or invalid files are treated as empty databases and logged at debug level.
   *
   * @param {string} [seedPath] Path to the bundled seed JSON. Defaults to the file shipped with the package.
   * @returns {Promise<void>} Resolves when both databases are loaded.
   */
  async load(seedPath: string = DEFAULT_SEED_PATH): Promise<void> {
    await Promise.all([this.loadSeed(seedPath), this.loadOverlay()]);
    this.log.debug(`Paramset cache loaded: seed=${Object.keys(this.seed).length} overlay=${Object.keys(this.overlay).length}`);
  }

  /**
   * Look up a paramset description by cache key components.
   *
   * The overlay is checked first; if not found the seed is consulted.
   *
   * @param {string} iface RPC interface name.
   * @param {string | undefined} deviceType Homematic device model string.
   * @param {string | undefined} firmware Firmware version string.
   * @param {number | undefined} deviceVersion `VERSION` integer of the root device.
   * @param {string} channelType Homematic channel type string.
   * @param {ParamsetKey} paramsetKey Paramset selector.
   * @returns {Record<string, unknown> | undefined} Cached description, or `undefined` on cache miss.
   */
  lookup(
    iface: string,
    deviceType: string | undefined,
    firmware: string | undefined,
    deviceVersion: number | undefined,
    channelType: string,
    paramsetKey: ParamsetKey,
  ): Record<string, unknown> | undefined {
    const key = buildParamsetKey(iface, deviceType, firmware, deviceVersion, channelType, paramsetKey);
    if (!key) return undefined;

    const hit = this.overlay[key] ?? this.seed[key];
    return hit;
  }

  /**
   * Store a paramset description in the runtime overlay.
   *
   * The overlay is not flushed to disk automatically; call {@link ParamsetCache.save} when ready.
   * Entries with unknown `deviceType` are silently ignored since they cannot be re-looked-up.
   *
   * @param {string} iface RPC interface name.
   * @param {string | undefined} deviceType Homematic device model string.
   * @param {string | undefined} firmware Firmware version string.
   * @param {number | undefined} deviceVersion `VERSION` integer of the root device.
   * @param {string} channelType Homematic channel type string.
   * @param {ParamsetKey} paramsetKey Paramset selector.
   * @param {Record<string, unknown>} description Raw paramset description from the CCU.
   */
  store(
    iface: string,
    deviceType: string | undefined,
    firmware: string | undefined,
    deviceVersion: number | undefined,
    channelType: string,
    paramsetKey: ParamsetKey,
    description: Record<string, unknown>,
  ): void {
    const key = buildParamsetKey(iface, deviceType, firmware, deviceVersion, channelType, paramsetKey);
    if (!key) return;

    this.overlay[key] = description;
    this.overlayDirty = true;
    this.log.debug(`Paramset cache store <- key=${key}`);
  }

  /**
   * Persist the runtime overlay to disk if it has been modified since the last save.
   *
   * @returns {Promise<void>} Resolves when the overlay is flushed (or there was nothing to flush).
   */
  async save(): Promise<void> {
    if (!this.overlayDirty) return;

    try {
      await fs.writeFile(this.overlayPath, JSON.stringify(this.overlay, null, 2), 'utf-8');
      this.overlayDirty = false;
      this.log.debug(`Paramset cache overlay saved: ${Object.keys(this.overlay).length} entries`);
    } catch (err) {
      this.log.warn(`Paramset cache overlay save failed: ${String(err)}`);
    }
  }

  private async loadSeed(seedPath: string): Promise<void> {
    try {
      const content = await fs.readFile(seedPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.seed = parsed as ParamsetDb;
        this.log.debug(`Paramset seed loaded: ${Object.keys(this.seed).length} entries from ${seedPath}`);
      } else {
        this.log.warn(`Paramset seed at ${seedPath} is not a JSON object; ignoring`);
      }
    } catch {
      this.log.debug(`Paramset seed not found or invalid at ${seedPath}; starting with empty seed`);
    }
  }

  private async loadOverlay(): Promise<void> {
    try {
      const content = await fs.readFile(this.overlayPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.overlay = parsed as ParamsetDb;
        this.log.debug(`Paramset overlay loaded: ${Object.keys(this.overlay).length} entries from ${this.overlayPath}`);
      } else {
        this.log.warn(`Paramset overlay at ${this.overlayPath} is not a JSON object; ignoring`);
      }
    } catch {
      this.log.debug(`Paramset overlay not found or invalid at ${this.overlayPath}; starting with empty overlay`);
    }
  }
}
