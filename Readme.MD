 Customer Speaks
       │
       ▼
[FireRedVAD (Audio Processing)]  ──> Detects speech onset & silence boundaries
       │
       ▼
[Web Speech API (STT)]           ──> Transcribes spoken words to text
       │
       ▼
[NLU Intent & Entity Parser]     ──> Extracts intent, item, category & quantities
       │
       ▼
[Multi-Turn State Machine]       ──> Resolves ambiguities (e.g., "Which biryani?")
       │
       ▼
[SpeechSynthesis (TTS)]          ──> Speaks response aloud with visual animations
       │
       ▼ (On Order Confirmation)
[Express Backend Server]         ──> Validates order & relays via WebSockets
       │
       ▼
[Kitchen Display System (KDS)]   ──> Real-time card update with audio chime




