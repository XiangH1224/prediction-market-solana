import json
import time


class AuditLog:
    """Append-only JSONL record of every staged, discarded, approved and rejected trade."""

    def __init__(self, path: str):
        self.path = path

    def write(self, event: str, **fields) -> None:
        record = {"ts": time.time(), "event": event, **fields}
        with open(self.path, "a") as f:
            f.write(json.dumps(record, default=str) + "\n")
