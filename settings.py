import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


CREDENTIAL_FIELDS = (
    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_SIP_TRUNK_ID",
    "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NVIDIA_MODEL",
    "STT_API_KEY", "STT_MODEL", "TTS_API_KEY", "TTS_MODEL", "TTS_VOICE_ID",
)


@dataclass(frozen=True)
class Settings:
    credentials: dict[str, str] = field(repr=False)
    state_dir: Path
    agent_name: str
    persona_id: str
    max_call: int
    capacity: int
    budget: int
    silence_check: int
    silence_end: int
    disable_thinking: bool

    @classmethod
    def from_env(cls):
        def positive(name: str, default: int) -> int:
            try:
                value = int(os.environ.get(name, default))
            except ValueError:
                value = 0
            if value < 1:
                raise ValueError(f"{name} must be a positive integer")
            return value

        def flag(name: str) -> bool:
            value = os.environ.get(name, "false").strip().lower()
            if value not in {"true", "false"}:
                raise ValueError(f"{name} must be true or false")
            return value == "true"

        values = {name: os.environ.get(name, "").strip() for name in CREDENTIAL_FIELDS}
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise ValueError("Missing configuration: " + ", ".join(missing))
        for name, scheme in (("NVIDIA_BASE_URL", "https"), ("LIVEKIT_URL", "wss")):
            url = urlsplit(values[name])
            if url.scheme != scheme or not url.hostname or url.username or url.password:
                raise ValueError(f"{name} must use {scheme} and have no embedded credentials")
        if flag("TRANSCRIPT_PERSISTENCE_ENABLED"):
            raise ValueError("Configure a disclosed, retention-managed TranscriptSink first")
        persona = os.environ.get("PERSONA_ID", "margaret_v1")
        if persona != "margaret_v1":
            raise ValueError("PERSONA_ID must be margaret_v1")
        name = os.environ.get("AGENT_NAME", "decoy-persona").strip()
        if not name:
            raise ValueError("AGENT_NAME is required for explicit dispatch")
        result = cls(
            values, Path(os.environ.get("STATE_DIR", "./state")).resolve(), name, persona,
            positive("MAX_CALL_SECONDS", 600), positive("MAX_CONCURRENT_CALLS", 1),
            positive("MAX_CUMULATIVE_CALL_MINUTES", 60) * 60,
            positive("SILENCE_CHECK_SECONDS", 15), positive("SILENCE_END_SECONDS", 45),
            flag("NVIDIA_DISABLE_THINKING"),
        )
        if result.silence_check >= result.silence_end:
            raise ValueError("SILENCE_END_SECONDS must exceed SILENCE_CHECK_SECONDS")
        return result
