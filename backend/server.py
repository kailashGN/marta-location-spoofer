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
import time
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __author__, __version__
from .demo_driver import DEMO_UDID, demo_device, demo_enabled, set_practice
from .device import discover
from .sample_trip import sample_gpx
from .geo import Point, align_gpx_to_now, parse_gpx, parse_gpx_timed, walk_ahead
from .spoof import JITTER_MAX_M, OFFSET_MAX_M, PACE_MAX, PACE_MIN, RAMP_MAX_S, SpoofError, SpoofSession

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
    # Timed GPX only: walk the opening walking leg now, then wait at the stop for the departure.
    walk_ahead: bool = False


class PauseBody(BaseModel):
    paused: bool


class OffsetBody(BaseModel):
    side: Literal["left", "right", "none"]
    meters: float = Field(default=100, ge=0, le=OFFSET_MAX_M)
    # 0 = jump there at once; otherwise drift there linearly over this many seconds.
    ramp_s: float = Field(default=0, ge=0, le=RAMP_MAX_S)


class PaceBody(BaseModel):
    factor: float = Field(ge=PACE_MIN, le=PACE_MAX)


class DemoBody(BaseModel):
    enabled: bool


class GpsBody(BaseModel):
    mode: Literal["normal", "frozen", "lost"] = "normal"
    jitter_m: float = Field(default=0, ge=0, le=JITTER_MAX_M)


# ----------------------------------------------------------------------------- routes
@app.get("/api/meta")
async def meta() -> dict[str, Any]:
    return {"name": "Location Spoofer", "version": __version__, "author": __author__, "practice": demo_enabled()}


@app.post("/api/demo")
async def practice(body: DemoBody) -> dict[str, Any]:
    """Practice mode: list a pretend phone that accepts everything and sends nothing."""
    if not body.enabled and session.snapshot().get("udid") == DEMO_UDID:
        await session.disconnect()
    set_practice(body.enabled)
    return {"practice": demo_enabled(), "status": session.snapshot()}


@app.get("/api/demo/sample.gpx")
async def sample_trip() -> Response:
    return Response(sample_gpx(), media_type="application/gpx+xml")


@app.get("/api/devices")
async def devices() -> dict[str, Any]:
    try:
        found, adb_status = await asyncio.wait_for(discover(), timeout=8)
    except asyncio.TimeoutError:
        found, adb_status = [], {"available": False, "message": "Device scan timed out."}
    listed = [d.to_dict() for d in found]
    if demo_enabled():
        listed.insert(0, demo_device())
    return {"devices": listed, "adb": adb_status}


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
            now = time.time()
            pts, pauses, legs, start = align_gpx_to_now(timed, body.time_scale, now)
            holds = None
            if body.walk_ahead:
                pauses, holds = walk_ahead(timed, pts, pauses, legs, start, body.time_scale, now)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        parts = ["Trip started · GPX schedule"]
        if body.time_scale != 1:
            parts.append(f"{body.time_scale:g}× speed")
        if body.walk_ahead:
            parts.append("walking to the stop now")
        return await session.play_route(
            pts, body.speed_mps, body.loop, gpx_pauses=pauses, legs=legs, start_index=start, holds=holds,
            label=" · ".join(parts),
        )
    pts = parse_gpx(body.gpx)
    return await session.play_route(pts, body.speed_mps, body.loop, label="Route started · GPX path")


@app.post("/api/route/pause")
async def pause_route(body: PauseBody) -> dict[str, Any]:
    return await session.pause_route(body.paused)


@app.post("/api/offset")
@app.post("/api/route/offset")
async def route_offset(body: OffsetBody) -> dict[str, Any]:
    return await session.set_offset(body.side, body.meters, body.ramp_s)


@app.post("/api/route/pace")
async def route_pace(body: PaceBody) -> dict[str, Any]:
    return await session.set_pace(body.factor)


@app.post("/api/gps")
async def gps(body: GpsBody) -> dict[str, Any]:
    return await session.set_gps(body.mode, body.jitter_m)


@app.get("/api/log")
async def get_log() -> dict[str, Any]:
    return {"seq": session.log_seq, "entries": list(session.log)}


@app.delete("/api/log")
async def clear_log() -> dict[str, Any]:
    session.clear_log()
    return {"seq": session.log_seq, "entries": []}


@app.delete("/api/route")
async def stop_route() -> dict[str, Any]:
    return await session.stop_route()


@app.post("/api/quit")
async def quit_app() -> dict[str, Any]:
    """Shut the server down (used by the Quit button when running as a bundled app)."""
    await session.disconnect()
    threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
    return {"ok": True}


@app.middleware("http")
async def revalidate_frontend(request, call_next):
    # Without this, browsers reuse old page files after an upgrade.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
