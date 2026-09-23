import { AppError } from './errors';

/**
 * Refuses a request body larger than `maxBytes` before it is read.
 *
 * `request.formData()` buffers the whole body first; checking the parsed
 * file's size afterwards means an oversized upload has already been held in
 * memory. The declared length is checked up front (with room for multipart
 * framing). A client that omits it, or streams more than it declared, is
 * still bounded by the platform's own body limit and by the file-size check
 * after parsing.
 */
export function assertBodySize(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) {
    throw new AppError('VALIDATION', 'The file is larger than the upload limit.', 'حجم الملف أكبر من الحد المسموح به.');
  }
}
