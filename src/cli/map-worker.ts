/**
 * Worker thread for `mritoolbox map`: one Fitter per worker (the library's
 * createFitter), then fitVoxels on each chunk of voxels it is sent.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createFitter, fitVoxels, type MapConfig } from 'mritoolbox';

export interface ChunkMessage {
  id: number;
  /** Voxel-major: voxel v occupies data[v·n .. (v+1)·n). */
  data: Float32Array;
  count: number;
}

export interface ResultMessage {
  id: number;
  /** MAP_CHANNELS values per voxel. */
  result: Float32Array;
}

const port = parentPort;
if (!port) throw new Error('map-worker.js runs as a worker thread of `mritoolbox map`.');
const fitter = createFitter((workerData as { config: MapConfig }).config);
port.on('message', ({ id, data, count }: ChunkMessage) => {
  const result = fitVoxels(fitter, data, count);
  // fitVoxels allocates a fresh buffer per call, so it can be transferred.
  port.postMessage({ id, result } satisfies ResultMessage, [result.buffer as ArrayBuffer]);
});
