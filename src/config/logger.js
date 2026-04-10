const { createLogger, format, transports } = require("winston");
const env = require("./env");

const isProd = env.NODE_ENV === "production";

const logger = createLogger({
  level: isProd ? "info" : "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "radhika-steels-api" },
  transports: [
    new transports.File({ filename: "logs/error.log", level: "error", maxsize: 5_242_880, maxFiles: 5 }),
    new transports.File({ filename: "logs/combined.log", maxsize: 5_242_880, maxFiles: 5 }),
    new transports.Console({
      format: isProd
        ? format.combine(format.timestamp({ format: "HH:mm:ss" }), format.printf(({ timestamp, level, message, stack }) => {
            return `${timestamp} [${level.toUpperCase()}] ${message}${stack ? "\n" + stack : ""}`;
          }))
        : format.combine(format.colorize(), format.simple()),
    }),
  ],
});

module.exports = logger;
