"""Location Spoofer — local HTTP API + static frontend.

Run:  python -m backend.server   (or scripts/run.sh)
Binds 127.0.0.1 only. There is no auth because the API can only be reached from this Mac.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __author__, __version__
from .device import discover
from .geo import Point, align_gpx_to_now, gpx_playback_pauses, parse_gpx, parse_gpx_timed
from .spoof import SpoofError, SpoofSession

log = logging.getLogger("locationspoofer")

def _frontend_dir() -> Path:
    # PyInstaller bundles the frontend next to the executable payload.
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled) / "frontend"
    return Path(__file__).resolve().parent.parent / "frontend"


FRONTEND = _frontend_dir()
HOST = os.environ.get("LS_HOST", "127.0.0.1")
PORT = int(os.environ.get("LS_PORT", "8420"))

session = SpoofSession()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await session.disconnect()


app = FastAPI(title="Location Spoofer", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)


@app.exception_handler(SpoofError)
async def _spoof_error(_: Request, exc: SpoofError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"error": exc.message, "steps": exc.steps, "code": exc.code})


@app.exception_handler(ValueError)
async def _value_error(_: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": str(exc), "steps": [], "code": "invalid"})


# ----------------------------------------------------------------------------- models
class Coordinate(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class ConnectBody(BaseModel):
    udid: str


class RouteBody(BaseModel):
    points: list[Coordinate] = Field(min_length=2)
    speed_mps: float = Field(default=1.4, gt=0, le=300)
    loop: bool = False


class GpxBody(BaseModel):
    gpx: str
    speed_mps: float = Field(default=1.4, gt=0, le=300)
    loop: bool = False
    use_gpx_times: bool = True
    time_scale: float = Field(default=1.0, gt=0, le=500)


class PauseBody(BaseModel):
    paused: bool


class OffsetBody(BaseModel):
    side: str
    meters: float = Field(default=100, gt=0, le=500)


class PaceBody(BaseModel):
    factor: float


# ----------------------------------------------------------------------------- routes
@app.get("/api/meta")
async def meta() -> dict[str, Any]:
    return {"name": "Location Spoofer", "version": __version__, "author": __author__}


@app.get("/api/devices")
async def devices() -> dict[str, Any]:
    try:
        found, adb_status = await asyncio.wait_for(discover(), timeout=8)
    except asyncio.TimeoutError:
        found, adb_status = [], {"available": False, "message": "Device scan timed out."}
    return {"devices": [d.to_dict() for d in found], "adb": adb_status}


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return session.snapshot()


@app.post("/api/connect")
async def connect(body: ConnectBody) -> dict[str, Any]:
    return await session.connect(body.udid)


@app.post("/api/disconnect")
async def disconnect() -> dict[str, Any]:
    await session.disconnect()
    return session.snapshot()


@app.post("/api/mount")
async def mount(body: ConnectBody) -> dict[str, Any]:
    return await session.mount_ddi(body.udid)


@app.post("/api/location")
async def set_location(body: Coordinate) -> dict[str, Any]:
    return await session.set_location(body.lat, body.lon)


@app.delete("/api/location")
async def clear_location() -> dict[str, Any]:
    return await session.clear_location()


@app.post("/api/route")
async def play_route(body: RouteBody) -> dict[str, Any]:
    pts = [Point(p.lat, p.lon) for p in body.points]
    return await session.play_route(pts, body.speed_mps, body.loop)


@app.post("/api/route/gpx")
async def play_gpx(body: GpxBody) -> dict[str, Any]:
    if body.use_gpx_times:
        try:
            timed = parse_gpx_timed(body.gpx)
            pts, pauses, legs, start = align_gpx_to_now(timed, body.time_scale)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return await session.play_route(
            pts, body.speed_mps, body.loop, gpx_pauses=pauses, legs=legs, start_index=start
        )
    pts = parse_gpx(body.gpx)
    return await session.play_route(pts, body.speed_mps, body.loop)


@app.post("/api/route/pause")
async def pause_route(body: PauseBody) -> dict[str, Any]:
    return await session.pause_route(body.paused)


@app.post("/api/route/offset")
async def route_offset(body: OffsetBody) -> dict[str, Any]:
    if body.side not in ("left", "right", "none"):
        raise HTTPException(status_code=422, detail="side must be left, right, or none")
    return await session.set_offset(body.side, body.meters)


@app.post("/api/route/pace")
async def route_pace(body: PaceBody) -> dict[str, Any]:
    if body.factor not in (0.5, 1.0, 2.0):
        raise HTTPException(status_code=422, detail="factor must be 0.5, 1, or 2")
    return await session.set_pace(body.factor)


@app.delete("/api/route")
async def stop_route() -> dict[str, Any]:
    return await session.stop_route()


@app.post("/api/quit")
async def quit_app() -> dict[str, Any]:
    """Shut the server down (used by the Quit button when running as a bundled app)."""
    await session.disconnect()
    threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
    return {"ok": True}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=str(FRONTEND)), name="static")


def main(open_browser: Optional[bool] = None) -> None:
    logging.basicConfig(level=os.environ.get("LS_LOG", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("pymobiledevice3").setLevel(logging.WARNING)
    if open_browser is None:
        open_browser = os.environ.get("LS_NO_BROWSER") != "1"
    url = f"http://{HOST}:{PORT}"
    if open_browser:
        # Open once the loop is running; uvicorn blocks the thread below.
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    log.info("Location Spoofer %s by %s → %s", __version__, __author__, url)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
