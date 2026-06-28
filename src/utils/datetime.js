// src/utils/datetime.js
// Pre-configured dayjs with UTC and timezone plugins.
// Use `fmt()` to format any date in the user's configured timezone.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TZ = process.env.TIMEZONE || 'UTC';

/**
 * Format a date in the configured timezone.
 * @param {Date|string|number} date
 * @param {string} formatStr - dayjs format string
 * @param {string} [tz] - timezone, defaults to process.env.TIMEZONE or 'UTC'
 * @returns {string}
 */
function fmt(date, formatStr, tz) {
  return dayjs(date).tz(tz || DEFAULT_TZ).format(formatStr);
}

module.exports = { dayjs, fmt };
