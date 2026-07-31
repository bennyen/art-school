import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { api } from "./api.js";
import { scanLibrary } from "./scanner.js";
import { fillMissingDurations, generateMissingTrickplay } from "./ffmpeg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use("/api", api);

// In production, serve the compiled SPA (web/dist)
const webDist = path.resolve(__dirname, "..", "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    const html = fs.readFileSync(path.join(webDist, "index.html"), "utf-8");
    const injected = html.replace(
      "</head>",
      `<script>window.__RUNTIME_CONFIG__ = ${JSON.stringify({ defaultLang: process.env.DEFAULT_LANG || "en" })}</script></head>`
    );
    res.type("html").send(injected);
  });
}

app.listen(config.port, () => {
  console.log(`🎨 Art School running at http://localhost:${config.port}`);
  console.log(`   Courses: ${config.coursesPath}`);
  console.log(`   Data:    ${config.dataPath}`);
  scanLibrary();
  void fillMissingDurations().then(() => generateMissingTrickplay());
});
