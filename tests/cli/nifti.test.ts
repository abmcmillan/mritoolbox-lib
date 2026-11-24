import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  DT,
  blankHeader,
  dataOffset,
  decodeNifti,
  encodeNifti,
  niftiBytes,
  parseHeader,
  readNifti,
  voxelCount,
} from '../../dist/cli/nifti.js';

const TYPES: [number, number, number[]][] = [
  [DT.UINT8, 8, [0, 1, 127, 255]],
  [DT.INT8, 8, [-128, -1, 0, 127]],
  [DT.INT16, 16, [-32768, -2, 3, 32767]],
  [DT.UINT16, 16, [0, 1, 40000, 65535]],
  [DT.INT32, 32, [-2147483648, -7, 9, 2147483647]],
  [DT.UINT32, 32, [0, 5, 3000000000, 4294967295]],
  [DT.INT64, 64, [-(2 ** 52), -1, 1, 2 ** 52]],
  [DT.UINT64, 64, [0, 1, 2 ** 40, 2 ** 53 - 1]],
  [DT.FLOAT32, 32, [-1.5, 0, 0.25, 3e38]],
  [DT.FLOAT64, 64, [-1e300, 0, Math.PI, 1e-300]],
];

function header(datatype: number, bitpix: number, littleEndian = true) {
  return { ...blankHeader([2, 2]), datatype, bitpix, littleEndian, sclSlope: 0 };
}

describe('NIfTI-1', () => {
  for (const [datatype, bitpix, values] of TYPES) {
    for (const le of [true, false]) {
      it(`round-trips datatype ${datatype} (${le ? 'little' : 'big'}-endian)`, () => {
        const bytes = encodeNifti(header(datatype, bitpix, le), values);
        expect(bytes.length).toBe(352 + (values.length * bitpix) / 8);
        const image = decodeNifti(bytes, 'test');
        expect(image.header.littleEndian).toBe(le);
        expect(image.header.dim.slice(0, 3)).toEqual([2, 2, 2]);
        const expected = datatype === DT.FLOAT32 ? values.map(Math.fround) : values;
        expect(Array.from(image.data)).toEqual(expected);
      });
    }
  }

  it('applies scl_slope and scl_inter, and ignores a zero or non-finite slope', () => {
    const h = { ...header(DT.INT16, 16), sclSlope: 0.5, sclInter: -10 };
    expect(Array.from(decodeNifti(encodeNifti(h, [0, 2, 4, 100]), 't').data)).toEqual([-10, -9, -8, 40]);
    for (const slope of [0, NaN, Infinity]) {
      const bytes = encodeNifti({ ...h, sclSlope: slope }, [0, 2, 4, 100]);
      expect(Array.from(decodeNifti(bytes, 't').data)).toEqual([0, 2, 4, 100]);
    }
  });

  it('starts the data at vox_offset, never before byte 352', () => {
    const h = { ...header(DT.UINT8, 8), voxOffset: 400 };
    const bytes = encodeNifti(h, [1, 2, 3, 4]);
    expect(bytes.length).toBe(404);
    expect(dataOffset(parseHeader(bytes, 't'))).toBe(400);
    // A smaller vox_offset in a .nii file means 352.
    new DataView(bytes.buffer).setFloat32(108, 0, true);
    bytes.set([9, 8, 7, 6], 352);
    expect(Array.from(decodeNifti(bytes, 't').data)).toEqual([9, 8, 7, 6]);
  });

  it('keeps the geometry and text fields', () => {
    const h = {
      ...blankHeader([3, 2, 1, 4]),
      pixdim: [-1, 0.9, 0.9, 2.5, 1500, 1, 1, 1],
      xyztUnits: 10,
      qformCode: 1,
      sformCode: 2,
      quatern: [0, 0, 1] as [number, number, number],
      qoffset: [10, -20, 30] as [number, number, number],
      srow: [
        [0.9, 0, 0, -1],
        [0, 0.9, 0, -2],
        [0, 0, 2.5, -3],
      ] as [number[], number[], number[]],
      descrip: 'synthetic',
      intentName: 'T2',
    };
    const back = parseHeader(encodeNifti(h, new Float32Array(24)), 't');
    expect(voxelCount(back)).toBe(24);
    expect(back.dim).toEqual([4, 3, 2, 1, 4, 1, 1, 1]);
    expect(back.pixdim.map(Math.fround)).toEqual(h.pixdim.map(Math.fround));
    expect(back.srow.flat().map(Math.fround)).toEqual(h.srow.flat().map(Math.fround));
    expect([back.qformCode, back.sformCode, back.xyztUnits]).toEqual([1, 2, 10]);
    expect(back.qoffset).toEqual([10, -20, 30]);
    expect([back.descrip, back.intentName]).toEqual(['synthetic', 'T2']);
  });

  it('reads .nii.gz by its content and writes it on request', async () => {
    const h = header(DT.FLOAT32, 32);
    const gz = await niftiBytes(h, [1, 2, 3, 4], true);
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    expect(Array.from((await readNifti(gz, 't')).data)).toEqual([1, 2, 3, 4]);
    expect(Array.from((await readNifti(gzipSync(encodeNifti(h, [5, 6, 7, 8])), 't')).data)).toEqual([5, 6, 7, 8]);
    await expect(readNifti(Uint8Array.from([0x1f, 0x8b, 1, 2, 3]), 'bad.gz')).rejects.toThrow(/gzip/);
  });

  it('refuses what it cannot read, saying why', () => {
    const good = encodeNifti(header(DT.INT16, 16), [1, 2, 3, 4]);
    const edit = (fn: (v: DataView, b: Uint8Array) => void): Uint8Array => {
      const b = good.slice();
      fn(new DataView(b.buffer), b);
      return b;
    };
    expect(() => decodeNifti(good.slice(0, 100), 't')).toThrow(/too short/);
    expect(() => decodeNifti(edit((v) => v.setInt32(0, 540, true)), 't')).toThrow(/NIfTI-2/);
    expect(() => decodeNifti(edit((v) => v.setInt32(0, 1234, true)), 't')).toThrow(/sizeof_hdr/);
    expect(() => decodeNifti(edit((_, b) => b.set([110, 105, 49, 0], 344)), 't')).toThrow(/\.hdr\/\.img/);
    expect(() => decodeNifti(edit((_, b) => b.set([0, 0, 0, 0], 344)), 't')).toThrow(/magic/);
    expect(() => decodeNifti(edit((v) => v.setInt16(40, 9, true)), 't')).toThrow(/dim\[0\]/);
    expect(() => decodeNifti(edit((v) => v.setInt16(42, 0, true)), 't')).toThrow(/dim\[1\]/);
    expect(() => decodeNifti(edit((v) => v.setInt16(70, 32, true)), 't')).toThrow(/complex64/);
    expect(() => decodeNifti(edit((v) => v.setInt16(72, 8, true)), 't')).toThrow(/bitpix/);
    expect(() => decodeNifti(good.slice(0, good.length - 1), 't')).toThrow(/header describes/);
    expect(() => encodeNifti(header(DT.UINT8, 8), [0, 1, 2, 256])).toThrow(RangeError);
    expect(() => encodeNifti(header(DT.INT16, 16), [0, 1, 2, 0.5])).toThrow(RangeError);
  });
});
