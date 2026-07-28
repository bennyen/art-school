import path from "node:path";
import fs from "node:fs";

const required = (value: string | undefined, fallback: string): string =>
  value && value.trim() !== "" ? value : fallback;

export const config = {
  port: Number(required(process.env.PORT, "3000")),
  coursesPath: path.resolve(required(process.env.COURSES_PATH, "./courses")),
  dataPath: path.resolve(required(process.env.DATA_PATH, "./data"))
};

// Make sure the data directory (database + thumbnail cache) exists
fs.mkdirSync(path.join(config.dataPath, "thumbs"), { recursive: true });
