export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function str(value, field, { max, required = false, fallback = '' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required.`);
  if (max && trimmed.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function int(value, field, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) throw new ValidationError(`${field} is required.`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new ValidationError(`${field} must be a whole number.`);
  if (min !== undefined && parsed < min) throw new ValidationError(`${field} must be at least ${min}.`);
  if (max !== undefined && parsed > max) throw new ValidationError(`${field} must be at most ${max}.`);
  return parsed;
}

export function date(value, field) {
  const raw = str(value, field, { required: true, max: 10 });
  if (!DATE_RE.test(raw)) throw new ValidationError(`${field} must look like YYYY-MM-DD.`);
  const [y, m, d] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  const isReal =
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  if (!isReal) throw new ValidationError(`${field} is not a real date.`);
  return raw;
}

export function time(value, field) {
  const raw = str(value, field, { max: 5 });
  if (!raw) return '';
  if (!TIME_RE.test(raw)) throw new ValidationError(`${field} must look like HH:MM.`);
  return raw;
}
