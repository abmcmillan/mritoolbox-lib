/** One-call curve fitting with plain inputs and outputs. */
import { Fitter, OUT, evaluateModel, type InitialGuess } from './lm.js';
import { MODELS, type ModelId } from './models.js';

export interface CurveInput {
  /** Signal model: "t2" (also T2*), "dwi", "t1ir", "t1ir-a" (imperfect inversion) or "t1vfa". */
  model: ModelId;
  /** Echo times (ms), b-values (s/mm²), inversion times (ms) or flip angles (°), by model. */
  x: readonly number[];
  /** One measurement per x. */
  y: readonly number[];
  /** Repetition time in ms. Required for "t1vfa"; optional for inversion recovery (default: fully relaxed). */
  tr?: number;
  /** Inversion recovery only: fit the magnitude of the signal; the sign of each measurement is ignored. */
  magnitude?: boolean;
  /** Add a constant offset C to the model. */
  fitConstant?: boolean;
  /** Search range of the fitted parameter, in its own unit (default: the model's range). */
  range?: readonly [number, number];
  /** Starting values. Without them the fit starts from a search over the whole range. */
  initial?: InitialGuess;
}

export interface CurveFit {
  model: ModelId;
  /** Name and unit of the fitted parameter, e.g. "T2" and "ms". */
  parameter: { name: string; unit: string };
  /** The fitted parameter (T1, T2 or T2* in ms; ADC in mm²/s). */
  value: number;
  m0: number;
  /** Inversion efficiency (1 unless the model fits it). */
  a: number;
  /** Constant offset (0 unless fitted). */
  c: number;
  /** Standard errors from the fit covariance; NaN where not estimated. */
  standardError: { value: number; m0: number; a: number; c: number };
  r2: number;
  rmse: number;
  iterations: number;
  /** Model signal at each x. */
  predicted: number[];
  /** Inputs that were fitted but look unintended; pass them on with the result. */
  warnings: string[];
}

/** Fit one curve. Throws when the inputs are inconsistent or the fit does not converge. */
export function fitCurve(input: CurveInput): CurveFit {
  const model = MODELS[input.model];
  if (!model) throw new Error(`Unknown model "${String(input.model)}".`);
  if (input.x.length !== input.y.length)
    throw new Error(`x has ${input.x.length} values but y has ${input.y.length}.`);
  if (Array.prototype.some.call(input.y, (value: number) => !Number.isFinite(value)))
    throw new Error('Every measurement in y must be a number.');
  const options = {
    ...(input.tr !== undefined ? { tr: input.tr } : {}),
    ...(input.magnitude !== undefined ? { magnitude: input.magnitude } : {}),
    ...(input.fitConstant !== undefined ? { fitConstant: input.fitConstant } : {}),
    ...(input.range ? { range: [input.range[0], input.range[1]] as [number, number] } : {}),
  };
  const fitter = new Fitter(input.model, input.x, options);
  const out = new Float64Array(OUT.size);
  if (!fitter.fit(input.y, 0, out, 0, input.initial))
    throw new Error('The fit did not converge. Check the data or give initial values.');
  const fitted = { param: out[OUT.param]!, m0: out[OUT.m0]!, a: out[OUT.a]!, c: out[OUT.c]! };
  const sse = out[OUT.sse]!;
  const [seValue, seM0, seA, seC] = fitter.standardErrors(sse);
  return {
    model: input.model,
    parameter: { name: model.param.name, unit: model.param.unit },
    value: fitted.param,
    m0: fitted.m0,
    a: fitted.a,
    c: fitted.c,
    standardError: { value: seValue!, m0: seM0!, a: seA!, c: seC! },
    r2: out[OUT.r2]!,
    rmse: Math.sqrt(sse / input.x.length),
    iterations: out[OUT.iterations]!,
    predicted: Array.from(evaluateModel(input.model, input.x, fitted, options)),
    warnings: fitter.warnings,
  };
}
