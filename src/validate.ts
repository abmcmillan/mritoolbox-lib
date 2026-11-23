/**
 * Input checks shared by every calculation.
 *
 * `errors` are inputs that cannot be computed or cannot occur (TE longer than
 * TR, a negative relaxation time): the calculation functions throw them.
 * `warnings` are inputs that compute but probably are not what was meant; the
 * results carry them so they can be shown next to the numbers.
 */
import type { ContrastInput } from './contrast.js';
import type { MprageSequence, MprageTissue } from './epg.js';
import { MODELS, type FitOptions, type ModelId } from './fit/models.js';
import type { Tissue } from './signal.js';

export interface Check {
  errors: string[];
  warnings: string[];
}

/** Thrown by the calculation functions when a {@link Check} has errors. */
export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
  }
}

/** Throw when the check found errors; otherwise hand back its warnings. */
export function assertValid(check: Check): string[] {
  if (check.errors.length > 0) throw new InvalidInputError(check.errors);
  return check.warnings;
}

const ms = (value: number): string => `${Number(value.toPrecision(6))} ms`;
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

function checkTissue(
  tissue: Tissue | MprageTissue,
  name: string,
  t2Name: string,
  into: Check,
): void {
  if (!(Number.isFinite(tissue.pd) && tissue.pd >= 0 && tissue.pd <= 1))
    into.errors.push(`PD of ${name} must be between 0 and 1.`);
  if (!positive(tissue.t1)) into.errors.push(`T1 of ${name} must be greater than zero.`);
  if (!positive(tissue.t2)) into.errors.push(`${t2Name} of ${name} must be greater than zero.`);
}

/** T2 cannot exceed T1 in tissue; a much larger value is usually a typing or unit mistake. */
function warnT2OverT1(tissue: Tissue | MprageTissue, name: string, into: Check): void {
  if (positive(tissue.t1) && positive(tissue.t2) && tissue.t2 > tissue.t1)
    into.warnings.push(
      `T2 of ${name} (${ms(tissue.t2)}) is longer than its T1 (${ms(tissue.t1)}), which does not occur in tissue.`,
    );
}

export function checkContrast(input: ContrastInput): Check {
  const check: Check = { errors: [], warnings: [] };
  const gre = input.mode === 'gre';
  input.tissues.forEach((tissue, n) => {
    checkTissue(tissue, `tissue ${n + 1}`, gre ? 'T2*' : 'T2', check);
    // In gradient-echo mode a very large T2* is the documented way to ignore T2* decay.
    if (!gre) warnT2OverT1(tissue, `tissue ${n + 1}`, check);
  });
  const { te, tr } = input;
  if (input.mode !== 'se-t2') {
    if (te === undefined || !Number.isFinite(te)) check.errors.push('TE is required.');
    else if (te < 0) check.errors.push('TE cannot be negative.');
  }
  if (input.mode !== 'se-t1') {
    if (tr === undefined || !positive(tr)) check.errors.push('TR must be greater than zero.');
  }
  if (gre && te !== undefined && tr !== undefined && positive(tr) && te >= tr)
    check.errors.push(`TE (${ms(te)}) must be shorter than TR (${ms(tr)}).`);
  return check;
}

export function checkMprage(
  tissues: readonly MprageTissue[],
  seq: MprageSequence,
  /** The two-tissue image simulation needs an even number of pulses, at least 8. */
  image = false,
): Check {
  const check: Check = { errors: [], warnings: [] };
  tissues.forEach((tissue, n) => {
    const name = tissues.length === 1 ? 'the tissue' : `tissue ${'AB'[n] ?? n + 1}`;
    checkTissue(tissue, name, 'T2', check);
    warnT2OverT1(tissue, name, check);
  });
  if (!(Number.isFinite(seq.flipAngle) && seq.flipAngle > 0 && seq.flipAngle <= 180))
    check.errors.push('The flip angle must be greater than 0° and at most 180°.');
  else if (seq.flipAngle > 30)
    check.warnings.push(
      `A readout flip angle of ${seq.flipAngle}° is far above what MP-RAGE uses (typically 5° to 12°).`,
    );
  if (!Number.isFinite(seq.spoilIncrement))
    check.errors.push('The RF spoiling increment must be a number of degrees.');
  if (!positive(seq.tr)) check.errors.push('TR must be greater than zero.');
  if (!(Number.isFinite(seq.td1) && seq.td1 >= 0) || !(Number.isFinite(seq.td2) && seq.td2 >= 0))
    check.errors.push('The delays TD1 and TD2 cannot be negative.');
  const np = seq.np;
  if (image) {
    if (!Number.isInteger(np) || np < 8 || np > 1024 || np % 2 !== 0)
      check.errors.push('The number of pulses must be an even whole number between 8 and 1024.');
  } else if (!Number.isInteger(np) || np < 1 || np > 4096) {
    check.errors.push('The number of pulses must be a whole number between 1 and 4096.');
  }
  return check;
}

export function checkFit(modelId: ModelId, x: ArrayLike<number>, options: FitOptions = {}): Check {
  const check: Check = { errors: [], warnings: [] };
  const model = MODELS[modelId];
  if (!model) return { errors: [`Unknown model "${String(modelId)}".`], warnings: [] };
  const label = model.x.label;
  const lower = label.toLowerCase();
  const values = Array.from(x);
  if (values.some((v) => !Number.isFinite(v))) {
    check.errors.push(`${label} must all be numbers.`);
    return check;
  }
  const parameters = 2 + (model.fitA ? 1 : 0) + (options.fitConstant ? 1 : 0);
  const distinct = new Set(values).size;
  if (values.length >= parameters && distinct < parameters)
    check.errors.push(
      `This model has ${parameters} free parameters and needs at least ${parameters} different ${lower}; the data have ${distinct}.`,
    );

  const { tr } = options;
  const finiteTr = tr !== undefined && Number.isFinite(tr);
  if (tr !== undefined && !Number.isNaN(tr) && tr <= 0)
    check.errors.push('TR must be greater than zero.');

  const min = Math.min(...values);
  const max = Math.max(...values);
  switch (model.kind) {
    case 'exp':
      if (min < 0) check.errors.push(`${label} cannot be negative.`);
      break;
    case 'ir':
      if (min < 0) check.errors.push(`${label} cannot be negative.`);
      if (finiteTr && tr > 0 && max >= tr)
        check.errors.push(
          `Every inversion time must be shorter than TR: the longest is ${ms(max)} and TR is ${ms(tr)}.`,
        );
      break;
    case 'vfa':
      if (min <= 0 || max >= 180)
        check.errors.push('Flip angles must be greater than 0° and less than 180°.');
      else if (max > 90)
        check.warnings.push(
          `A flip angle of ${max}° is above 90°, which is unusual for variable flip angle T1 mapping. Check that the angles are in degrees.`,
        );
      break;
  }
  return check;
}
