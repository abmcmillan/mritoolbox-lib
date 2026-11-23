/** Pixel-wise fitting of many voxels with one model; runs inside the fit workers. */
import { Fitter, OUT } from './lm.js';
import type { FitOptions, ModelId } from './models.js';

export interface MapConfig {
  model: ModelId;
  x: number[];
  options: FitOptions;
}

/** Order of the values stored per voxel in a mapping result. */
export const MAP_KEYS = ['param', 'm0', 'a', 'c', 'r2'] as const;
export type MapKey = (typeof MAP_KEYS)[number];
export const MAP_CHANNELS = MAP_KEYS.length;

/**
 * Fit `count` voxels. `data` is voxel-major: voxel v occupies
 * data[v·n .. (v+1)·n). Returns MAP_CHANNELS values per voxel; voxels whose
 * fit failed are left at zero.
 */
export function fitVoxels(fitter: Fitter, data: Float32Array, count: number): Float32Array {
  const n = fitter.n;
  const result = new Float32Array(count * MAP_CHANNELS);
  const out = new Float64Array(OUT.size);
  for (let v = 0; v < count; v++) {
    if (!fitter.fit(data, v * n, out)) continue;
    const o = v * MAP_CHANNELS;
    result[o] = out[OUT.param]!;
    result[o + 1] = out[OUT.m0]!;
    result[o + 2] = out[OUT.a]!;
    result[o + 3] = out[OUT.c]!;
    result[o + 4] = out[OUT.r2]!;
  }
  return result;
}

export function createFitter(config: MapConfig): Fitter {
  return new Fitter(config.model, config.x, config.options);
}
