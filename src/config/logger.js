const { createLogger, format, transports } = require("winston");
const env = require("./env");

const logger = createLogger({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "radhika-steels-api" },
  transports: [
    new transports.File({ filename: "logs/error.log", level: "error", maxsize: 5_242_880, maxFiles: 5 }),
    new transports.File({ filename: "logs/combined.log", maxsize: 5_242_880, maxFiles: 5 }),
  ],
});

if (env.NODE_ENV !== "production") {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    })
  );
}

module.exports = logger;
