import json
import re
from collections import deque
from dataclasses import asdict, dataclass, field


PERSONA_FACTS = {
    "Mabel": r"\bmabel\b",
    "retired librarian": r"\blibrar(?:y|ian)\b",
    "pencil and paper": r"\b(?:pencil|paper)\b",
    "gardening": r"\b(?:garden|gardening)\b",
    "baking": r"\b(?:bake|baking)\b",
    "mystery novels": r"\b(?:mystery|novels?)\b",
    "age 74": r"\b(?:74|seventy[- ]four)\b",
}


def ending(text: str) -> tuple[str, str] | None:
    normalized = re.sub(r"[^a-z0-9 ]", "", text.lower().replace("’", "'")).strip()
    if re.search(r"\b(?:call (?:911|an ambulance)|send (?:help|an ambulance)|"
                 r"(?:i|we) need (?:urgent help|an ambulance)|"
                 r"(?:im|i am) having a heart attack)\b", normalized):
        return "urgent_help", "This is an automated demo line. Please call your local emergency number."
    if re.fullmatch(r"(?:(?:oh|sorry|okay|well) )*(?:i (?:have|need|got) to go|"
                    r"(?:this is (?:the )?|you have (?:the )?)?wrong number|"
                    r"(?:please )?(?:hang up|end the call)(?: please)?|"
                    r"(?:thanks )?(?:bye|goodbye)(?: bye| now)?)", normalized):
        return "caller_end", "Take care. Goodbye."
    return None


@dataclass
class CallMemory:
    claimed_organization: str = ""
    claimed_reason_for_call: str = ""
    requested_action: str = ""
    details_already_clarified: deque[str] = field(default_factory=lambda: deque(maxlen=5))
    persona_facts_already_mentioned: list[str] = field(default_factory=list)
    recent_questions: deque[str] = field(default_factory=lambda: deque(maxlen=4))
    recent_digressions: deque[str] = field(default_factory=lambda: deque(maxlen=3))
    caller_appears_impatient: bool = False
    conversation_summary: deque[str] = field(default_factory=lambda: deque(maxlen=8))

    def observe(self, speaker: str, text: str) -> None:
        if speaker == "caller":
            patterns = {
                "claimed_organization": r"\b(?:calling|speaking|reaching out) from ([^.!?]+)",
                "claimed_reason_for_call": r"\b(?:calling (?:about|because)|reason (?:is|for the call is)) ([^.!?]+)",
                "requested_action": r"\b(?:you (?:need|have) to|i need you to|please) ([^.!?]+)",
            }
            for name, pattern in patterns.items():
                if match := re.search(pattern, text, flags=re.IGNORECASE):
                    setattr(self, name, match[1][:160])
            if self.recent_questions and not text.rstrip().endswith("?"):
                if text[:150] not in self.details_already_clarified:
                    self.details_already_clarified.append(text[:150])
            if re.search(r"\b(?:hurry|already told you|get to the point|wasting my time)\b", text, re.I):
                self.caller_appears_impatient = True
        else:
            for sentence in re.findall(r"[^.!?]+\?", text):
                self.recent_questions.append(sentence.strip()[:140])
            for fact, pattern in PERSONA_FACTS.items():
                if re.search(pattern, text, re.I):
                    if fact not in self.persona_facts_already_mentioned:
                        self.persona_facts_already_mentioned.append(fact)
                    if fact not in self.recent_digressions:
                        self.recent_digressions.append(fact)

    def summarize(self, speaker: str, text: str) -> None:
        # Bounded extractive recall. Never promote caller claims to verified facts.
        label = "Caller said or claimed" if speaker == "user" else "Margaret said"
        self.conversation_summary.append(f"{label}: {text[:150]}")

    def as_context(self) -> str:
        return json.dumps(asdict(self), default=list, ensure_ascii=False)
