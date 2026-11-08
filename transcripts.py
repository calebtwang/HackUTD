import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol
from uuid import NAMESPACE_OID, uuid5


log = logging.getLogger("margaret")


@dataclass(frozen=True)
class Segment:
    call_id: str
    segment_id: str
    sequence: int
    speaker: str
    started_at: str
    ended_at: str
    text: str
    interrupted: bool


@dataclass(frozen=True)
class CallSummary:
    call_id: str
    reason: str
    duration_seconds: float
    segment_count: int
    transcript_failures: int
    response_latency_samples: int
    median_response_start_seconds: float | None
    room_deleted: bool


class TranscriptSink(Protocol):
    async def write_segment(self, segment: Segment) -> None: ...
    async def finish_call(self, summary: CallSummary) -> None: ...


class InMemoryTranscriptSink:
    def __init__(self):
        self.segments: dict[str, Segment] = {}
        self.calls: dict[str, CallSummary] = {}

    async def write_segment(self, segment: Segment) -> None:
        self.segments.setdefault(segment.segment_id, segment)

    async def finish_call(self, summary: CallSummary) -> None:
        self.calls.setdefault(summary.call_id, summary)


class TranscriptQueue:
    def __init__(self, call_id: str, sink: TranscriptSink):
        self.call_id = call_id
        self.sink = sink
        self.queue: asyncio.Queue[Segment] = asyncio.Queue(maxsize=512)
        self.seen: set[str] = set()
        self.sequence = 0
        self.failures = 0
        self.consumer = asyncio.create_task(self.consume())

    def add(self, event_id: str, speaker: str, start: str, end: str,
            text: str, interrupted: bool) -> bool:
        if event_id in self.seen:
            return False
        self.seen.add(event_id)
        self.sequence += 1
        segment = Segment(
            self.call_id, str(uuid5(NAMESPACE_OID, f"{self.call_id}:{event_id}")),
            self.sequence, speaker, start, end, text, interrupted,
        )
        try:
            self.queue.put_nowait(segment)
        except asyncio.QueueFull:
            self.failures += 1
            log.error("transcript queue full call_id=%s", self.call_id)
        return True

    async def consume(self):
        while True:
            segment = await self.queue.get()
            try:
                await asyncio.wait_for(self.sink.write_segment(segment), timeout=2)
            except Exception:
                self.failures += 1
                log.error("transcript segment write failed call_id=%s sequence=%d",
                          self.call_id, segment.sequence)
            finally:
                self.queue.task_done()

    async def drain(self) -> None:
        try:
            await asyncio.wait_for(self.queue.join(), timeout=3)
        except TimeoutError:
            self.failures += self.queue.qsize() + 1
            log.error("transcript drain timed out call_id=%s", self.call_id)
        finally:
            self.consumer.cancel()
            await asyncio.gather(self.consumer, return_exceptions=True)

    async def finish(self, summary: CallSummary) -> None:
        try:
            await asyncio.wait_for(self.sink.finish_call(summary), timeout=2)
        except Exception:
            log.error("transcript summary write failed call_id=%s", self.call_id)
