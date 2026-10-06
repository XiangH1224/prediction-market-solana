import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, HTMLResponse
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    http = httpx.AsyncClient()
    hub = PanelHub()
    orchestrator = Orchestrator(settings, http, hub, AuditLog(settings.audit_log_path))
    app.state.settings, app.state.hub, app.state.orchestrator = settings, hub, orchestrator

    log.info("panel: http://localhost:8000/panel%s", " (PANEL_TOKEN required)" if settings.panel_token else "")
    task = asyncio.create_task(orchestrator.run())
    try:
        yield
    finally:
        task.cancel()
        await http.aclose()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return app.state.orchestrator.status()["data"]


# The built side panel, also served as a plain page at /panel for use without the extension.
PANEL_DIST = Path(__file__).resolve().parents[2] / "extension" / "dist"
if (PANEL_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=PANEL_DIST / "assets"), name="assets")


@app.get("/panel")
async def panel_page():
    index = PANEL_DIST / "index.html"
    if not index.is_file():
        return HTMLResponse("Panel is not built. Run `npm run build` in extension/.", status_code=404)
    return FileResponse(index)


@app.get("/wallet", response_class=HTMLResponse)
async def wallet_page():
    return WALLET_PAGE


@app.websocket("/ws")
async def panel_socket(ws: WebSocket):
    await serve_panel(ws, app.state.hub, app.state.orchestrator, app.state.settings.panel_token)
