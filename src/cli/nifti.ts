/**
 * NIfTI-1 single files (.nii, and .nii.gz through node:zlib), after the
 * NIfTI-1 header specification (nifti1.h, https://nifti.nimh.nih.gov/nifti-1):
 *
 * - The 348-byte header is little- or big-endian; sizeof_hdr (348) tells
 *   which, and dim[0] (1 to 7) must agree. Voxel data share the header's
 *   byte order.
 * - Voxel data start at (int)vox_offset, never before byte 352. Bytes 348 to
 *   351 are the extension flag; any extensions sit before vox_offset and are
 *   skipped.
 * - When scl_slope is nonzero, a stored value x means scl_slope * x + scl_inter.
 * - dim[1..dim[0]] are the array sizes, x fastest. Integer types up to 64
 *   bits and float32/float64 are read; complex, RGB, float128 and 1-bit data
 *   are refused. ".hdr/.img" pairs (magic "ni1") and NIfTI-2 are refused.
 */
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { InputError } from './errors.js';
import { isGzip } from './files.js';

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

export const HEADER_SIZE = 348;
/** Header plus the 4-byte extension flag: where data start in a file without extensions. */
export const MIN_VOX_OFFSET = 352;

/** NIfTI-1 datatype codes (nifti1.h, DT_*). */
export const DT = {
  UINT8: 2,
  INT16: 4,
  INT32: 8,
  FLOAT32: 16,
  FLOAT64: 64,
  INT8: 256,
  UINT16: 512,
  UINT32: 768,
  INT64: 1024,
  UINT64: 1280,
} as const;

interface TypeInfo {
  name: string;
  bytes: number;
  get: (view: DataView, offset: number, le: boolean) => number;
  set: (view: DataView, offset: number, value: number, le: boolean) => void;
  /** Integer types: the representable range. */
  range?: [number, number];
}

const TYPES: Record<number, TypeInfo> = {
  [DT.UINT8]: {
    name: 'uint8',
    bytes: 1,
    get: (v, o) => v.getUint8(o),
    set: (v, o, x) => v.setUint8(o, x),
    range: [0, 255],
  },
  [DT.INT8]: {
    name: 'int8',
    bytes: 1,
    get: (v, o) => v.getInt8(o),
    set: (v, o, x) => v.setInt8(o, x),
    range: [-128, 127],
  },
  [DT.INT16]: {
    name: 'int16',
    bytes: 2,
    get: (v, o, le) => v.getInt16(o, le),
    set: (v, o, x, le) => v.setInt16(o, x, le),
    range: [-32768, 32767],
  },
  [DT.UINT16]: {
    name: 'uint16',
    bytes: 2,
    get: (v, o, le) => v.getUint16(o, le),
    set: (v, o, x, le) => v.setUint16(o, x, le),
    range: [0, 65535],
  },
  [DT.INT32]: {
    name: 'int32',
    bytes: 4,
    get: (v, o, le) => v.getInt32(o, le),
    set: (v, o, x, le) => v.setInt32(o, x, le),
    range: [-2147483648, 2147483647],
  },
  [DT.UINT32]: {
    name: 'uint32',
    bytes: 4,
    get: (v, o, le) => v.getUint32(o, le),
    set: (v, o, x, le) => v.setUint32(o, x, le),
    range: [0, 4294967295],
  },
  [DT.INT64]: {
    name: 'int64',
    bytes: 8,
    get: (v, o, le) => Number(v.getBigInt64(o, le)),
    set: (v, o, x, le) => v.setBigInt64(o, BigInt(x), le),
    range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  },
  [DT.UINT64]: {
    name: 'uint64',
    bytes: 8,
    get: (v, o, le) => Number(v.getBigUint64(o, le)),
    set: (v, o, x, le) => v.setBigUint64(o, BigInt(x), le),
    range: [0, Number.MAX_SAFE_INTEGER],
  },
  [DT.FLOAT32]: {
    name: 'float32',
    bytes: 4,
    get: (v, o, le) => v.getFloat32(o, le),
    set: (v, o, x, le) => v.setFloat32(o, x, le),
  },
  [DT.FLOAT64]: {
    name: 'float64',
    bytes: 8,
    get: (v, o, le) => v.getFloat64(o, le),
    set: (v, o, x, le) => v.setFloat64(o, x, le),
  },
};

const UNSUPPORTED: Record<number, string> = {
  0: 'unknown',
  1: 'binary',
  32: 'complex64',
  128: 'RGB24',
  1536: 'float128',
  1792: 'complex128',
  2048: 'complex256',
  2304: 'RGBA32',
};

export interface NiftiHeader {
  /** Byte order of the header and the data. */
  littleEndian: boolean;
  dimInfo: number;
  /** dim[0] is the number of dimensions, dim[1..7] their sizes. */
  dim: number[];
  intentP: [number, number, number];
  intentCode: number;
  datatype: number;
  bitpix: number;
  sliceStart: number;
  /** pixdim[0] is qfac; pixdim[1..7] the voxel spacing. */
  pixdim: number[];
  voxOffset: number;
  sclSlope: number;
  sclInter: number;
  sliceEnd: number;
  sliceCode: number;
  xyztUnits: number;
  calMax: number;
  calMin: number;
  sliceDuration: number;
  toffset: number;
  descrip: string;
  auxFile: string;
  qformCode: number;
  sformCode: number;
  /** quatern_b, quatern_c, quatern_d. */
  quatern: [number, number, number];
  /** qoffset_x, qoffset_y, qoffset_z. */
  qoffset: [number, number, number];
  /** srow_x, srow_y, srow_z. */
  srow: [number[], number[], number[]];
  intentName: string;
}

export interface NiftiImage {
  header: NiftiHeader;
  /** Voxel values after scl_slope and scl_inter, in file order (x fastest). */
  data: Float32Array | Float64Array;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = offset; i < offset + length && bytes[i] !== 0; i++)
    text += String.fromCharCode(bytes[i]!);
  return text;
}

function writeAscii(bytes: Uint8Array, offset: number, length: number, text: string): void {
  for (let i = 0; i < length - 1 && i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[offset + i] = code < 128 ? code : 63; // "?"
  }
}

/** Number of voxels: dim[1] × … × dim[dim[0]]. */
export function voxelCount(header: NiftiHeader): number {
  let n = 1;
  for (let i = 1; i <= header.dim[0]!; i++) n *= header.dim[i]!;
  return n;
}

/** Read and check the header of a NIfTI-1 single file (already decompressed). */
export function parseHeader(bytes: Uint8Array, source: string): NiftiHeader {
  if (bytes.length < HEADER_SIZE)
    throw new InputError(`${source} is too short to be a NIfTI-1 file (${bytes.length} bytes).`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let le: boolean;
  if (view.getInt32(0, true) === HEADER_SIZE) le = true;
  else if (view.getInt32(0, false) === HEADER_SIZE) le = false;
  else if (view.getInt32(0, true) === 540 || view.getInt32(0, false) === 540)
    throw new InputError(`${source} is a NIfTI-2 file; only NIfTI-1 is supported.`);
  else throw new InputError(`${source} is not a NIfTI-1 file (sizeof_hdr is not 348).`);

  const magic = ascii(bytes, 344, 4);
  if (magic === 'ni1')
    throw new InputError(
      `${source} is the header of a .hdr/.img pair; only single .nii files (magic "n+1") are supported.`,
    );
  if (magic !== 'n+1')
    throw new InputError(`${source} has no NIfTI-1 magic "n+1" (an ANALYZE 7.5 file?).`);

  const i16 = (o: number): number => view.getInt16(o, le);
  const f32 = (o: number): number => view.getFloat32(o, le);
  const dim = Array.from({ length: 8 }, (_, i) => i16(40 + 2 * i));
  if (dim[0]! < 1 || dim[0]! > 7)
    throw new InputError(`${source}: dim[0] is ${dim[0]}, but must be 1 to 7.`);
  for (let i = 1; i <= dim[0]!; i++)
    if (dim[i]! < 1) throw new InputError(`${source}: dim[${i}] is ${dim[i]}; sizes must be positive.`);

  return {
    littleEndian: le,
    dimInfo: view.getUint8(39),
    dim,
    intentP: [f32(56), f32(60), f32(64)],
    intentCode: i16(68),
    datatype: i16(70),
    bitpix: i16(72),
    sliceStart: i16(74),
    pixdim: Array.from({ length: 8 }, (_, i) => f32(76 + 4 * i)),
    voxOffset: f32(108),
    sclSlope: f32(112),
    sclInter: f32(116),
    sliceEnd: i16(120),
    sliceCode: view.getUint8(122),
    xyztUnits: view.getUint8(123),
    calMax: f32(124),
    calMin: f32(128),
    sliceDuration: f32(132),
    toffset: f32(136),
    descrip: ascii(bytes, 148, 80),
    auxFile: ascii(bytes, 228, 24),
    qformCode: i16(252),
    sformCode: i16(254),
    quatern: [f32(256), f32(260), f32(264)],
    qoffset: [f32(268), f32(272), f32(276)],
    srow: [0, 1, 2].map((r) => Array.from({ length: 4 }, (_, c) => f32(280 + 16 * r + 4 * c))) as [
      number[],
      number[],
      number[],
    ],
    intentName: ascii(bytes, 328, 16),
  };
}

function typeOf(header: NiftiHeader, source: string): TypeInfo {
  const type = TYPES[header.datatype];
  if (!type) {
    const name = UNSUPPORTED[header.datatype];
    throw new InputError(
      `${source}: datatype ${header.datatype}${name ? ` (${name})` : ''} is not supported; use an integer type, float32 or float64.`,
    );
  }
  if (header.bitpix !== type.bytes * 8)
    throw new InputError(
      `${source}: bitpix is ${header.bitpix}, but datatype ${type.name} has ${type.bytes * 8} bits.`,
    );
  return type;
}

/** Where the voxel data start: (int)vox_offset, and never before byte 352. */
export const dataOffset = (header: NiftiHeader): number =>
  Math.max(MIN_VOX_OFFSET, Math.floor(header.voxOffset));

/** The scaling to apply, or none when scl_slope is zero (or not a finite number). */
export function scaling(header: NiftiHeader): { slope: number; inter: number } | undefined {
  if (header.sclSlope === 0 || !Number.isFinite(header.sclSlope)) return undefined;
  return { slope: header.sclSlope, inter: Number.isFinite(header.sclInter) ? header.sclInter : 0 };
}

/** Decode a NIfTI-1 single file (already decompressed) into scaled values. */
export function decodeNifti(
  bytes: Uint8Array,
  source: string,
  precision: 'float32' | 'float64' = 'float64',
): NiftiImage {
  const header = parseHeader(bytes, source);
  const type = typeOf(header, source);
  const offset = dataOffset(header);
  const n = voxelCount(header);
  const end = offset + n * type.bytes;
  if (bytes.length < end)
    throw new InputError(
      `${source} has ${bytes.length} bytes, but its header describes ${end} (${n} ${type.name} voxels from byte ${offset}).`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = precision === 'float32' ? new Float32Array(n) : new Float64Array(n);
  const scale = scaling(header);
  const le = header.littleEndian;
  for (let i = 0, o = offset; i < n; i++, o += type.bytes) {
    const x = type.get(view, o, le);
    data[i] = scale ? scale.slope * x + scale.inter : x;
  }
  return { header, data };
}

/** Read a .nii or .nii.gz file's bytes (compression is detected from the content). */
export async function readNifti(
  bytes: Uint8Array,
  source: string,
  precision: 'float32' | 'float64' = 'float64',
): Promise<NiftiImage> {
  let raw = bytes;
  if (isGzip(bytes)) {
    try {
      raw = await gunzipAsync(bytes);
    } catch (error) {
      throw new InputError(`${source} is not a valid gzip file: ${(error as Error).message}`);
    }
  }
  return decodeNifti(raw, source, precision);
}

/** A float32, little-endian header with identity scaling and nothing else set. */
export function blankHeader(dim: readonly number[]): NiftiHeader {
  const sizes = [dim.length, ...dim, ...Array(7 - dim.length).fill(1)];
  return {
    littleEndian: true,
    dimInfo: 0,
    dim: sizes,
    intentP: [0, 0, 0],
    intentCode: 0,
    datatype: DT.FLOAT32,
    bitpix: 32,
    sliceStart: 0,
    pixdim: [1, 1, 1, 1, 1, 1, 1, 1],
    voxOffset: MIN_VOX_OFFSET,
    sclSlope: 1,
    sclInter: 0,
    sliceEnd: 0,
    sliceCode: 0,
    xyztUnits: 0,
    calMax: 0,
    calMin: 0,
    sliceDuration: 0,
    toffset: 0,
    descrip: '',
    auxFile: '',
    qformCode: 0,
    sformCode: 0,
    quatern: [0, 0, 0],
    qoffset: [0, 0, 0],
    srow: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    intentName: '',
  };
}

/**
 * Encode a NIfTI-1 single file. `stored` holds the values as stored, in file
 * order; with a nonzero scl_slope they mean scl_slope * x + scl_inter.
 */
export function encodeNifti(header: NiftiHeader, stored: ArrayLike<number>): Uint8Array {
  const type = typeOf(header, 'the output');
  const n = voxelCount(header);
  if (stored.length !== n)
    throw new RangeError(`The header describes ${n} voxels but ${stored.length} values were given.`);
  const offset = dataOffset(header);
  if (offset % 16 !== 0) throw new RangeError('vox_offset must be a multiple of 16.');
  const bytes = new Uint8Array(offset + n * type.bytes);
  const view = new DataView(bytes.buffer);
  const le = header.littleEndian;
  const i16 = (o: number, v: number): void => view.setInt16(o, v, le);
  const f32 = (o: number, v: number): void => view.setFloat32(o, v, le);
  view.setInt32(0, HEADER_SIZE, le);
  view.setUint8(38, 'r'.charCodeAt(0)); // "regular", as ANALYZE readers expect
  view.setUint8(39, header.dimInfo);
  header.dim.forEach((d, i) => i16(40 + 2 * i, d));
  header.intentP.forEach((p, i) => f32(56 + 4 * i, p));
  i16(68, header.intentCode);
  i16(70, header.datatype);
  i16(72, header.bitpix);
  i16(74, header.sliceStart);
  header.pixdim.forEach((p, i) => f32(76 + 4 * i, p));
  f32(108, offset);
  f32(112, header.sclSlope);
  f32(116, header.sclInter);
  i16(120, header.sliceEnd);
  view.setUint8(122, header.sliceCode);
  view.setUint8(123, header.xyztUnits);
  f32(124, header.calMax);
  f32(128, header.calMin);
  f32(132, header.sliceDuration);
  f32(136, header.toffset);
  writeAscii(bytes, 148, 80, header.descrip);
  writeAscii(bytes, 228, 24, header.auxFile);
  i16(252, header.qformCode);
  i16(254, header.sformCode);
  header.quatern.forEach((q, i) => f32(256 + 4 * i, q));
  header.qoffset.forEach((q, i) => f32(268 + 4 * i, q));
  header.srow.forEach((row, r) => row.forEach((v, c) => f32(280 + 16 * r + 4 * c, v)));
  writeAscii(bytes, 328, 16, header.intentName);
  writeAscii(bytes, 344, 4, 'n+1');
  // Bytes 348..351: extension flag, all zero (no extensions).
  for (let i = 0, o = offset; i < n; i++, o += type.bytes) {
    const x = stored[i]!;
    if (type.range) {
      if (!Number.isInteger(x) || x < type.range[0] || x > type.range[1])
        throw new RangeError(`Voxel ${i}: ${x} cannot be stored as ${type.name}.`);
    }
    type.set(view, o, x, le);
  }
  return bytes;
}

/** Encode, and gzip when asked. */
export async function niftiBytes(
  header: NiftiHeader,
  stored: ArrayLike<number>,
  compress: boolean,
): Promise<Uint8Array> {
  const bytes = encodeNifti(header, stored);
  return compress ? gzipAsync(bytes) : bytes;
}
