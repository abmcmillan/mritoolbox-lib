/**
 * mritoolbox: the calculations behind https://www.mritoolbox.com.
 *
 * Times are in milliseconds, field strengths in tesla and signals are
 * fractions of M0. Angles are in degrees, except in the low-level signal
 * equations that say radians (multiply degrees by DEG). Nothing here
 * touches the DOM or the network, so it runs in Node, Deno, Bun, browsers and
 * workers alike.
 */
export {
  DEG,
  ernstAngleDeg,
  inversionRecoverySignal,
  linspace,
  spgrSignal,
  spinEchoSignal,
  type Tissue,
} from './signal.js';
export {
  maximise,
  optimiseContrast,
  type ContrastInput,
  type ContrastMode,
  type ContrastResult,
} from './contrast.js';
export {
  simulateMprage,
  simulateMprageImage,
  type EpgResult,
  type MprageImageResult,
  type MprageSequence,
  type MprageTissue,
} from './epg.js';
export {
  DEFAULT_MODEL,
  MODELS,
  MODEL_ORDER,
  type FitOptions,
  type ModelDef,
  type ModelId,
  type ModelKind,
  type XKey,
} from './fit/models.js';
export { Fitter, OUT, evaluateModel, type InitialGuess } from './fit/lm.js';
export { fitCurve, type CurveFit, type CurveInput } from './fit/curve.js';
export {
  MAP_CHANNELS,
  MAP_KEYS,
  createFitter,
  fitVoxels,
  type MapConfig,
  type MapKey,
} from './fit/map.js';
export {
  InvalidInputError,
  assertValid,
  checkContrast,
  checkFit,
  checkMprage,
  type Check,
} from './validate.js';
export {
  DATABASE,
  RAW_DATABASE,
  normalise,
  searchDatabase,
  searchEntries,
  type Entry,
  type RawEntry,
} from './database.js';
