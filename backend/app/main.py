import asyncio
import logging
import shutil
import socket
import subprocess
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from .audit import AuditLog
from .config import Settings
from .orchestrator import Orchestrator
from .ws_api import PanelHub, serve_panel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("orchestrator")

# Wallet extensions inject into web pages, not into another extension's side panel.
# The panel opens this page in a tab and talks to the wallet through it.
WALLET_PAGE = """<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Prediction Side Panel wallet bridge</title></head>
  <body style="font-family: system-ui; margin: 3rem; max-width: 36rem">
    <h3>Wallet bridge</h3>
    <p>Keep this tab open. The side panel uses it to reach your wallet extension.
    Wallet prompts for connecting and signing will name this page.</p>
  </body>
</html>"""


RELAY_PORT = 4178


def start_relay() -> subprocess.Popen | None:
    """Run the Kalshi market relay beside the backend, unless one is already listening."""
    with socket.socket() as probe:
        probe.settimeout(0.3)
        if probe.connect_ex(("127.0.0.1", RELAY_PORT)) == 0:
            return None
    node, script = shutil.which("node"), PREDICTFLOW_ROOT / "news-proxy.mjs"
    if not node or not script.is_file():
        log.warning("Kalshi relay not started (node or news-proxy.mjs missing); the panel cannot list markets")
        return None
    return subprocess.Popen([node, str(script)], cwd=PREDICTFLOW_ROOT)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    relay = start_relay() if settings.start_relay else None
    http = httpx.AsyncClient()
    hub = PanelHub()
    orchestrator = Orchestrator(settings, http, hub, AuditLog(settings.audit_log_path))
    app.state.settings, app.state.hub, app.state.orchestrator = settings, hub, orchestrator

    log.info("panel: http://localhost:8000/predictflow/%s", " (PANEL_TOKEN required)" if settings.panel_token else "")
    task = asyncio.create_task(orchestrator.run())
    try:
        yield
    finally:
        task.cancel()
        await http.aclose()
        if relay:
            relay.terminate()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return app.state.orchestrator.status()["data"]


# The built side panel, also served as a plain page at /panel for use without the extension.
PANEL_DIST = Path(__file__).resolve().parents[2] / "extension" / "dist"
# /assets is the built script; /gdelt holds the GDELT interface's stylesheets and icon fonts.
for folder in ("assets", "gdelt"):
    if (PANEL_DIST / folder).is_dir():
        app.mount(f"/{folder}", StaticFiles(directory=PANEL_DIST / folder), name=folder)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(PANEL_DIST / "favicon.ico")


@app.get("/fieldnote/")
@app.get("/panel")
async def panel_page():
    # The PredictFlow panel replaced the earlier React page; old links land on it.
    return RedirectResponse("/predictflow/")


@app.get("/panel-legacy")
async def legacy_panel_page():
    index = PANEL_DIST / "index.html"
    if not index.is_file():
        return HTMLResponse("Panel is not built. Run `npm run build` in extension/.", status_code=404)
    return FileResponse(index)


# PredictFlow, the side-panel UI at the repo root, as a page for use without loading the extension.
# Named files only: the repo root also holds the relay's .env.
PREDICTFLOW_ROOT = Path(__file__).resolve().parents[2]
PREDICTFLOW_FILES = {"": "sidepanel.html", "sidepanel.css": "sidepanel.css", "panel.bundle.js": "panel.bundle.js"}


@app.get("/predictflow/{name:path}")
async def predictflow_page(name: str = ""):
    file = PREDICTFLOW_ROOT / PREDICTFLOW_FILES.get(name, "missing")
    if name not in PREDICTFLOW_FILES or not file.is_file():
        return HTMLResponse("Not found. If the panel is not built, run `npm run build:panel` in the repo root.", status_code=404)
    return FileResponse(file)


@app.get("/wallet", response_class=HTMLResponse)
async def wallet_page():
    return WALLET_PAGE


@app.websocket("/ws")
async def panel_socket(ws: WebSocket):
    await serve_panel(ws, app.state.hub, app.state.orchestrator, app.state.settings.panel_token)
