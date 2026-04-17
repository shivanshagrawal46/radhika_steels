/**
 * Date/time utilities — ALL formatting uses Asia/Kolkata (IST).
 *
 * IMPORTANT:
 *   - MongoDB stores every Date in UTC (standard, never changed).
 *   - We send ISO strings to the frontend — also UTC (standard).
 *   - Only DISPLAY formatting uses IST.
 *   - Frontend must also convert ISO → IST when rendering.
 */

const IST_TZ = "Asia/Kolkata";
const IST_LOCALE = "en-IN";

const DATE_OPTS = { day: "2-digit", month: "short", year: "numeric", timeZone: IST_TZ };
const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: IST_TZ };
const DATETIME_OPTS = { ...DATE_OPTS, ...TIME_OPTS };

// "16 Apr 2026"
const formatIstDate = (d) => {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString(IST_LOCALE, DATE_OPTS); } catch { return ""; }
};

// "09:37 AM"
const formatIstTime = (d) => {
  if (!d) return "";
  try { return new Date(d).toLocaleTimeString(IST_LOCALE, TIME_OPTS); } catch { return ""; }
};

// "16 Apr 2026, 09:37 AM"
const formatIstDateTime = (d) => {
  if (!d) return "";
  try { return new Date(d).toLocaleString(IST_LOCALE, DATETIME_OPTS); } catch { return ""; }
};

// "2026-04-16" — ISO-like date in IST (useful for grouping)
const istDateKey = (d) => {
  if (!d) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: IST_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(d));
    const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
  } catch { return ""; }
};

module.exports = {
  IST_TZ,
  IST_LOCALE,
  formatIstDate,
  formatIstTime,
  formatIstDateTime,
  istDateKey,
};
