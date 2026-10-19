"""Minimal stdlib-only NDJSON worker for the Zotero Subprocess prototype."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any


PROTOCOL_VERSION = 1


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def handle(message: dict[str, Any]) -> bool:
    request_id = message.get("id")
    command = message.get("command")
    if command == "hello":
        emit(
            {
                "id": request_id,
                "ok": True,
                "protocolVersion": PROTOCOL_VERSION,
                "pid": os.getpid(),
                "python": sys.version.split()[0],
            }
        )
        return True
    if command == "echo":
        emit({"id": request_id, "ok": True, "payload": message.get("payload")})
        return True
    if command == "sleep":
        time.sleep(max(0.0, min(float(message.get("seconds", 0)), 5.0)))
        emit({"id": request_id, "ok": True})
        return True
    if command == "crash":
        sys.stderr.write("intentional phase0 crash\n")
        sys.stderr.flush()
        os._exit(17)
    if command == "shutdown":
        emit({"id": request_id, "ok": True, "shutdown": True})
        return False
    emit(
        {
            "id": request_id,
            "ok": False,
            "error": {"code": "unknown-command", "message": str(command)},
        }
    )
    return True


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise TypeError("NDJSON message must be an object")
            if not handle(message):
                return 0
        except Exception as error:  # The protocol must return structured failures.
            emit(
                {
                    "id": None,
                    "ok": False,
                    "error": {
                        "code": "invalid-message",
                        "message": f"{type(error).__name__}: {error}",
                    },
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

