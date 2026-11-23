/**
 * Normal in vivo T1 and T2 values of human tissues from peer-reviewed
 * articles. The raw records (data/parameter-database.json) keep the values as
 * published; `DATABASE` adds parsed means and a searchable tissue path.
 */
import RAW from './database-data.generated.js';

/** One record as stored in data/parameter-database.json. */
export interface RawEntry {
  /** PubMed ID of the article. */
  PMID: string;
  /** Tissue, with "->" or "," between levels, e.g. "Brain->White matter". */
  Tissue: string;
  /** Field strength in tesla. */
  FieldStrength: string;
  /** T1 in ms as published (mean ± SD, a range, or "-"). */
  T1: string;
  /** T2 in ms as published (mean ± SD, a range, or "-"). */
  T2: string;
}

export interface Entry {
  pmid: string;
  /** Tissue path joined for display, e.g. "Brain › White matter". */
  tissue: string;
  path: string[];
  /** Field strength in tesla. */
  field: number;
  /** Mean T1 and T2 in ms, when the article reports them. */
  t1: number | undefined;
  t2: number | undefined;
  /** T1 and T2 as published (mean ± SD or a range). */
  t1Text: string;
  t2Text: string;
  /** Lower-case text the search matches against. */
  haystack: string;
}

const mean = (text: string): number | undefined => {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : undefined;
};

export function normalise(raw: RawEntry): Entry {
  const path = raw.Tissue.split(/->|,/u).map((part) => part.trim());
  return {
    pmid: raw.PMID,
    tissue: path.join(' › '),
    path,
    field: Number(raw.FieldStrength),
    t1: mean(raw.T1),
    t2: mean(raw.T2),
    t1Text: raw.T1 === '-' ? '–' : raw.T1,
    t2Text: raw.T2 === '-' ? '–' : raw.T2,
    haystack: `${path.join(' ')} ${raw.FieldStrength}t ${raw.PMID}`.toLowerCase(),
  };
}

/** Every record of the database, as published. */
export const RAW_DATABASE: readonly RawEntry[] = RAW;

/** Every record of the database, normalised. */
export const DATABASE: readonly Entry[] = RAW.map(normalise);

/**
 * Entries matching every word of `query` (tissue name, "3t", a PubMed ID) and,
 * when given, the field strength in tesla. Alphabetical, then by field strength.
 */
export function searchEntries(entries: readonly Entry[], query: string, field?: number): Entry[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return entries
    .filter((e) => terms.every((t) => e.haystack.includes(t)))
    .filter((e) => field === undefined || e.field === field)
    .sort(
      (a, b) =>
        a.tissue.localeCompare(b.tissue, 'en') ||
        a.field - b.field ||
        Number(a.pmid) - Number(b.pmid),
    );
}

/** Search the built-in database. */
export const searchDatabase = (query: string, field?: number): Entry[] =>
  searchEntries(DATABASE, query, field);
