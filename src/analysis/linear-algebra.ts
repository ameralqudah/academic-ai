/**
 * The linear algebra regression needs.
 *
 * Small and purpose-built rather than a general matrix library: the only
 * problem this module solves is "fit a linear model and report how uncertain
 * each coefficient is", and every function here exists because that answer
 * requires it.
 *
 * The central decision is **Householder QR rather than the normal equations**.
 *
 * The textbook formula β = (XᵀX)⁻¹Xᵀy is correct and is what most quick
 * implementations use. Its problem is that forming XᵀX squares the condition
 * number of the design matrix: information that was merely hard to separate
 * becomes information that has been destroyed. In survey research this is not a
 * corner case. Two Likert items that correlate at .95 — two rewordings of one
 * question, which questionnaires are full of — produce a design matrix whose
 * normal equations lose most of their significant digits, and the regression
 * silently reports standard errors that are wrong by orders of magnitude.
 *
 * QR factorises X directly and never forms XᵀX, so the conditioning is not
 * squared. It costs perhaps twice the arithmetic of the normal equations, on
 * matrices this product will never see above a few thousand rows and a few
 * dozen columns. That is an irrelevant amount of time to spend on being right.
 *
 * (XᵀX)⁻¹ is still needed — the standard errors are built from its diagonal —
 * but it is recovered from R as R⁻¹R⁻ᵀ, which never forms the ill-conditioned
 * product either.
 */

export type Matrix = number[][];
export type Vector = number[];

/** Thrown when a system has no unique solution — in practice, collinear inputs. */
export class SingularMatrixError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'SingularMatrixError';
  }
}

/* -------------------------------------------------------------------------- */
/*                              Basic operations                              */
/* -------------------------------------------------------------------------- */

export function rowCount(a: Matrix): number {
  return a.length;
}

export function columnCount(a: Matrix): number {
  return a[0]?.length ?? 0;
}

export function identity(size: number): Matrix {
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
  );
}

export function transpose(a: Matrix): Matrix {
  const rows = rowCount(a);
  const columns = columnCount(a);
  const out: Matrix = Array.from({ length: columns }, () => new Array<number>(rows).fill(0));

  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < columns; j += 1) {
      out[j]![i] = a[i]![j] as number;
    }
  }

  return out;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = rowCount(a);
  const inner = columnCount(a);
  const m = columnCount(b);

  if (rowCount(b) !== inner) {
    throw new SingularMatrixError('analysis.matrix.error.shapeMismatch', {
      left: `${n}×${inner}`,
      right: `${rowCount(b)}×${m}`,
    });
  }

  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));

  for (let i = 0; i < n; i += 1) {
    const rowA = a[i] as Vector;
    const rowOut = out[i] as Vector;
    for (let k = 0; k < inner; k += 1) {
      const value = rowA[k] as number;
      if (value === 0) continue;
      const rowB = b[k] as Vector;
      for (let j = 0; j < m; j += 1) {
        rowOut[j] = (rowOut[j] as number) + value * (rowB[j] as number);
      }
    }
  }

  return out;
}

export function multiplyVector(a: Matrix, v: Vector): Vector {
  const n = rowCount(a);
  const inner = columnCount(a);

  if (v.length !== inner) {
    throw new SingularMatrixError('analysis.matrix.error.shapeMismatch', {
      left: `${n}×${inner}`,
      right: `${v.length}`,
    });
  }

  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const row = a[i] as Vector;
    let sum = 0;
    for (let j = 0; j < inner; j += 1) sum += (row[j] as number) * (v[j] as number);
    out[i] = sum;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                             Householder QR                                 */
/* -------------------------------------------------------------------------- */

export interface QRDecomposition {
  /** Upper-triangular R, of size columns × columns. */
  r: Matrix;
  /** Qᵀy for the right-hand side supplied at decomposition time. */
  qty: Vector;
  /** Diagonal magnitudes of R, used to detect rank deficiency. */
  diagonal: Vector;
}

/**
 * Reduces `X` to upper-triangular form while applying the same reflections to
 * `y`, which is all a least-squares solve needs.
 *
 * Q itself is never assembled. It is an n × n matrix — for three thousand
 * respondents that is nine million numbers whose only use would be to multiply
 * one vector. The reflections are applied to `y` as they are computed instead.
 */
export function qrDecompose(x: Matrix, y: Vector): QRDecomposition {
  const n = rowCount(x);
  const p = columnCount(x);

  if (n < p) {
    throw new SingularMatrixError('analysis.matrix.error.underdetermined', { rows: n, columns: p });
  }
  if (y.length !== n) {
    throw new SingularMatrixError('analysis.matrix.error.shapeMismatch', {
      left: `${n}`,
      right: `${y.length}`,
    });
  }

  // Working copies: the decomposition is destructive and the caller's data is not ours.
  const a: Matrix = x.map((row) => [...row]);
  const b: Vector = [...y];
  const diagonal = new Array<number>(p).fill(0);

  for (let k = 0; k < p; k += 1) {
    // Norm of the column below the diagonal.
    let norm = 0;
    for (let i = k; i < n; i += 1) norm += (a[i]![k] as number) ** 2;
    norm = Math.sqrt(norm);

    if (norm === 0) {
      diagonal[k] = 0;
      continue;
    }

    // Sign chosen away from the pivot to avoid cancellation.
    const alpha = (a[k]![k] as number) >= 0 ? -norm : norm;
    diagonal[k] = alpha;

    // Build the Householder vector in place.
    a[k]![k] = (a[k]![k] as number) - alpha;
    let vNorm = 0;
    for (let i = k; i < n; i += 1) vNorm += (a[i]![k] as number) ** 2;

    if (vNorm === 0) continue;

    // Apply the reflection to the remaining columns.
    for (let j = k + 1; j < p; j += 1) {
      let dot = 0;
      for (let i = k; i < n; i += 1) dot += (a[i]![k] as number) * (a[i]![j] as number);
      const factor = (2 * dot) / vNorm;
      for (let i = k; i < n; i += 1) {
        a[i]![j] = (a[i]![j] as number) - factor * (a[i]![k] as number);
      }
    }

    // And to the right-hand side.
    let dotY = 0;
    for (let i = k; i < n; i += 1) dotY += (a[i]![k] as number) * (b[i] as number);
    const factorY = (2 * dotY) / vNorm;
    for (let i = k; i < n; i += 1) {
      b[i] = (b[i] as number) - factorY * (a[i]![k] as number);
    }
  }

  // Assemble R: the diagonal was saved above, the rest is the upper triangle.
  const r: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    r[i]![i] = diagonal[i] as number;
    for (let j = i + 1; j < p; j += 1) r[i]![j] = a[i]![j] as number;
  }

  return { r, qty: b.slice(0, p), diagonal };
}

/**
 * Solves Rx = b for upper-triangular R, by back substitution.
 *
 * A zero on the diagonal means a column of the design matrix is an exact linear
 * combination of the others — a dummy variable coded for every category
 * including the reference, say, or the same variable entered twice. The error
 * names the column so the message can too.
 */
export function backSubstitute(r: Matrix, b: Vector, tolerance = 1e-10): Vector {
  const p = rowCount(r);
  const scale = Math.max(...r.map((row, i) => Math.abs(row[i] as number)), 1);
  const out = new Array<number>(p).fill(0);

  for (let i = p - 1; i >= 0; i -= 1) {
    const pivot = r[i]![i] as number;
    if (Math.abs(pivot) <= tolerance * scale) {
      throw new SingularMatrixError('analysis.matrix.error.singular', { column: i });
    }

    let sum = b[i] as number;
    for (let j = i + 1; j < p; j += 1) sum -= (r[i]![j] as number) * (out[j] as number);
    out[i] = sum / pivot;
  }

  return out;
}

/** Least-squares solution of Xβ ≈ y. */
export function leastSquares(x: Matrix, y: Vector): Vector {
  const { r, qty } = qrDecompose(x, y);
  return backSubstitute(r, qty);
}

/**
 * (XᵀX)⁻¹, recovered from R without ever forming XᵀX.
 *
 * Since X = QR and QᵀQ = I, XᵀX = RᵀR, so (XᵀX)⁻¹ = R⁻¹R⁻ᵀ. The diagonal of
 * this matrix scaled by the residual variance gives the squared standard errors
 * of the coefficients, which is the whole reason a regression can say anything
 * about significance.
 */
export function inverseFromR(r: Matrix, tolerance = 1e-10): Matrix {
  const p = rowCount(r);
  const scale = Math.max(...r.map((row, i) => Math.abs(row[i] as number)), 1);

  // R⁻¹ by back substitution against the identity, column by column.
  const rInverse: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));

  for (let column = 0; column < p; column += 1) {
    for (let i = column; i >= 0; i -= 1) {
      const pivot = r[i]![i] as number;
      if (Math.abs(pivot) <= tolerance * scale) {
        throw new SingularMatrixError('analysis.matrix.error.singular', { column: i });
      }

      let sum = i === column ? 1 : 0;
      for (let j = i + 1; j <= column; j += 1) {
        sum -= (r[i]![j] as number) * (rInverse[j]![column] as number);
      }
      rInverse[i]![column] = sum / pivot;
    }
  }

  // R⁻¹ · R⁻ᵀ
  const out: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < p; j += 1) {
      let sum = 0;
      for (let k = Math.max(i, j); k < p; k += 1) {
        sum += (rInverse[i]![k] as number) * (rInverse[j]![k] as number);
      }
      out[i]![j] = sum;
    }
  }

  return out;
}
