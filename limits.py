import math
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class CallLedger:
    """Shared admission and lifetime usage across worker processes on one host."""

    def __init__(self, state_dir: Path):
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = state_dir / "calls.sqlite3"
        self.stop_file = state_dir / "STOP"
        with self.transaction() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS calls (
                    room TEXT PRIMARY KEY,
                    lease_until REAL NOT NULL,
                    charged_seconds INTEGER NOT NULL
                )
            """)

    @property
    def stopped(self) -> bool:
        return self.stop_file.exists()

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=1)
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                yield db
        finally:
            db.close()

    def claim(self, room: str, *, seconds: int, capacity: int, budget: int) -> str | None:
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM calls WHERE room = ?", (room,)).fetchone():
                return "duplicate"
            now = time.time()
            active, used = db.execute("""
                SELECT COALESCE(SUM(lease_until > ?), 0),
                       COALESCE(SUM(charged_seconds), 0) FROM calls
            """, (now,)).fetchone()
            reason = None
            if self.stopped:
                reason = "operator_stop"
            elif active >= capacity:
                reason = "capacity"
            elif used + seconds > budget:
                reason = "budget"
            # Keep a tombstone even for rejected calls so another job cannot
            # admit a room already being torn down by this job.
            lease = now + seconds + 30 if reason is None else 0
            db.execute("INSERT INTO calls VALUES (?, ?, ?)",
                       (room, lease, seconds if reason is None else 0))
            return reason

    def finish(self, room: str, elapsed: float) -> None:
        with self.transaction() as db:
            db.execute("""
                UPDATE calls SET lease_until = 0,
                    charged_seconds = MIN(charged_seconds, ?)
                WHERE room = ? AND lease_until > 0
            """, (math.ceil(elapsed), room))


class Silence:
    def __init__(self, now: float, check: int, end: int):
        self.last_activity = now
        self.check = check
        self.end = end
        self.prompted = False

    def activity(self, now: float, *, caller: bool = False):
        self.last_activity = now
        if caller:
            self.prompted = False

    def action(self, now: float) -> str | None:
        idle = now - self.last_activity
        if idle >= self.end:
            return "end"
        if idle >= self.check and not self.prompted:
            self.prompted = True
            return "check"
        return None
