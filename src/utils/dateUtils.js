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

// "17th April, 2026" — ordinal IST date for user-facing templates
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const ordinalSuffix = (day) => {
  const n = Number(day);
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
};

const formatIstDateOrdinal = (d = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: IST_TZ,
      day: "numeric",
      month: "numeric",
      year: "numeric",
    }).formatToParts(new Date(d));
    const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const day = parseInt(lookup.day, 10);
    const month = MONTHS[parseInt(lookup.month, 10) - 1];
    return `${day}${ordinalSuffix(day)} ${month}, ${lookup.year}`;
  } catch { return ""; }
};

module.exports = {
  IST_TZ,
  IST_LOCALE,
  formatIstDate,
  formatIstTime,
  formatIstDateTime,
  formatIstDateOrdinal,
  istDateKey,
};
