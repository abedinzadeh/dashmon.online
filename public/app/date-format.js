// Date formatting helper: store/transport UTC, display in user-selected timezone.
// UMD export: works in browser + Node tests.
function formatDateTime(value, options) {
  const opts = options || {};
  const timeZone = opts.timeZone || null;

  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return fmt.format(d);
}

function isValidIanaTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatDateTime, isValidIanaTimeZone };
} else {
  window.formatDateTime = formatDateTime;
  window.isValidIanaTimeZone = isValidIanaTimeZone;
}
