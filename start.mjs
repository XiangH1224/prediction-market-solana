// Builds the panel, then runs the analysis backend (backend/, FastAPI) until Ctrl+C.
// The backend starts the Kalshi market relay (news-proxy.mjs) itself.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const backend = fileURLToPath(new URL("./backend/", import.meta.url));
const uvicorn = fileURLToPath(new URL("./backend/.venv/bin/uvicorn", import.meta.url));

if (!existsSync(uvicorn)) {
  console.error("The backend is not installed. Run:\n  cd backend && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt");
  process.exit(1);
}
if (spawnSync("npm", ["run", "build:panel"], { cwd: root, stdio: "inherit" }).status !== 0) process.exit(1);

const service = spawn(uvicorn, ["app.main:app", "--port", "8000"], { cwd: backend, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => service.kill("SIGTERM"));
service.on("exit", code => { process.exitCode = code ?? 0; });
console.log("\nPredictFlow: load this folder at chrome://extensions, or open http://localhost:8000/predictflow/\n");
