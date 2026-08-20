"""scripts/run_server.py — launcher uvicorn per l'API Elysium Agent.

Carica config.yaml, verifica la presenza della API key (OPTIMIZE_ENGINE_API_KEY
o OPENCODE_GO_API_KEY), e avvia uvicorn su api.main:app.

Usage:
    python scripts/run_server.py
    python scripts/run_server.py --port 9000
    python scripts/run_server.py --no-reload
"""
from __future__ import annotations

import argparse
import os
import sys

import yaml
import uvicorn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)  # rende importabile il package `api`

CONFIG_PATH = os.path.join(ROOT, "config.yaml")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8137

API_KEY_ENVS = ("OPTIMIZE_ENGINE_API_KEY", "OPENCODE_GO_API_KEY")

# ASCII art "ELYSIUM AGENT" (font: big)
BANNER = r"""
 ______ _  __     _______ _____ _    _ __  __
|  ____| | \ \   / / ____|_   _| |  | |  \/  |
| |__  | |  \ \_/ / (___   | | | |  | | \  / |
|  __| | |   \   / \___ \  | | | |  | | |\/| |
| |____| |____| |  ____) |_| |_| |__| | |  | |
|______|______|_| |_____/|_____|\____/|_|  |_|

          _____ ______ _   _ _______
    /\   / ____|  ____| \ | |__   __|
   /  \ | |  __| |__  |  \| |  | |
  / /\ \| | |_ |  __| | . ` |  | |
 / ____ \ |__| | |____| |\  |  | |
/_/    \_\_____|______|_| \_|  |_|
"""

BLUE = "\033[94m"
RESET = "\033[0m"
RED = "\033[91m"
YELLOW = "\033[93m"


def enable_ansi_windows() -> None:
    """Abilita le sequenze ANSI sulla console Windows (no-op altrove)."""
    if sys.platform == "win32":
        os.system("")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run_server.py",
        description="Avvia l'API FastAPI Elysium Agent con uvicorn.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Override della porta (config.yaml: server.port, default %d)." % DEFAULT_PORT,
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Disabilita il reload automatico su modifica dei sorgenti.",
    )
    return parser.parse_args()


def load_server_config() -> tuple[str, int]:
    """Legge host/port da config.yaml, con fallback ai default."""
    host, port = DEFAULT_HOST, DEFAULT_PORT
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg = yaml.safe_load(f)
            server = (cfg or {}).get("server", {}) or {}
            host = str(server.get("host", host))
            port = int(server.get("port", port))
        except (yaml.YAMLError, ValueError, TypeError) as exc:
            print(f"{YELLOW}[warn]{RESET} config.yaml non valido ({exc}); "
                  f"uso default {DEFAULT_HOST}:{DEFAULT_PORT}")
    else:
        print(f"{YELLOW}[warn]{RESET} config.yaml non trovato in {CONFIG_PATH}; "
              f"uso default {DEFAULT_HOST}:{DEFAULT_PORT}")
    return host, port


def check_api_key() -> bool:
    """Verifica la presenza di una API key; ritorna True se presente."""
    present = [name for name in API_KEY_ENVS if os.environ.get(name)]
    if not present:
        print(f"{RED}[ERRORE]{RESET} Nessuna API key configurata. Imposta almeno una:")
        for name in API_KEY_ENVS:
            print(f"    set {name}=<your-key>")
        print("Esempio (git-bash):")
        print(f"    export OPENCODE_GO_API_KEY=<your-key> && python scripts/run_server.py")
        return False
    return True


def main() -> None:
    enable_ansi_windows()
    args = parse_args()

    print(f"{BLUE}{BANNER}{RESET}")
    print(f"{BLUE}Elysium Agent — launcher API{RESET}\n")

    if not check_api_key():
        sys.exit(1)

    host, port = load_server_config()
    if args.port is not None:
        port = args.port

    reload_dev = not args.no_reload
    print(f"{YELLOW}host   :{RESET} {host}")
    print(f"{YELLOW}port   :{RESET} {port}")
    print(f"{YELLOW}reload :{RESET} {'on' if reload_dev else 'off'}")
    print(f"{YELLOW}API key:{RESET} OK")
    print(f"{BLUE}\n→ Avvio API su http://{host}:{port} ...{RESET}\n")

    uvicorn.run("api.main:app", host=host, port=port, reload=reload_dev)


if __name__ == "__main__":
    main()
