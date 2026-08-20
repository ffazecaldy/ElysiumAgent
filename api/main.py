"""api/main.py — app FastAPI: CORS + static mount + router."""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.routes import router

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

app = FastAPI(title="Optimize Engine", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tool locale single-user
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
