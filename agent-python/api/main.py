"""api/main.py — app FastAPI dell'harness Elysium Agent.

CORS + rotte API + static mount della UI web/.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.routes import router

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

app = FastAPI(title="Elysium Agent", version="0.15.0-harness")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tool locale single-user
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
