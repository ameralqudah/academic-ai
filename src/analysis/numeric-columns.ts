/**
 * Every column of a loaded table as numbers, with missing cells as `NaN`.
 *
 * The SEM and chart paths used `Number(value)` on raw cells, and `Number(null)`
 * is `0`: a blank Likert answer became a real zero, entered every covariance,
 * and was never excluded by listwise deletion because it was not missing any
 * more. The same call turned "1,234" and Arabic-Indic digits into NaN. This
 * goes through `toNumber`, the parser the classical tests already use, and
 * leaves anything that is not a number as `NaN` — which the estimators drop.
 */

import { toNumber } from './stats-core';

export function numericColumns(data: { columns: string[]; rows: unknown[][] }): Map<string, number[]> {
  const result = new Map<string, number[]>();

  data.columns.forEach((name, index) => {
    result.set(
      name,
      data.rows.map((row) => toNumber(row[index]) ?? Number.NaN),
    );
  });

  return result;
}
