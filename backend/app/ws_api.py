import logging
import secrets

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

# Sent in place of the generic 1008 so the panel can tell a bad token from a dropped socket.
WS_UNAUTHORIZED = 4401


class PanelHub:
    """The side panel connections and the operator wallet they report."""

    def __init__(self):
        self.connections: set[WebSocket] = set()
        self.wallet: str | None = None

    async def broadcast(self, message: dict) -> None:
        for ws in list(self.connections):
            try:
                await ws.send_json(message)
            except Exception:
                self.connections.discard(ws)


ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "http://localhost:", "http://127.0.0.1:")


def authorized(ws: WebSocket, token: str) -> bool:
    """The panel must come from the extension or a page on this machine. Browsers always send
    the origin, so other websites are refused. If PANEL_TOKEN is set it must match as well."""
    origin = ws.headers.get("origin")
    if origin and not origin.startswith(ALLOWED_ORIGIN_PREFIXES):
        return False
    if not token:
        return True
    return secrets.compare_digest(ws.query_params.get("token", ""), token)


async def serve_panel(ws: WebSocket, hub: PanelHub, orchestrator, token: str) -> None:
    if not authorized(ws, token):
        await ws.accept()
        await ws.close(code=WS_UNAUTHORIZED)
        return
    await ws.accept()
    hub.connections.add(ws)
    try:
        for message in orchestrator.snapshot():
            await ws.send_json(message)
        while True:
            await orchestrator.handle_panel_message(await ws.receive_json())
    except WebSocketDisconnect:
        pass
    finally:
        hub.connections.discard(ws)
        if not hub.connections:
            hub.wallet = None
