#!/usr/bin/env python3
"""
Faster-Whisper CLI for ConvoSync call recordings.
Supports English + Indian languages (hi, bn, ta, te, mr, gu, kn, ml, pa, ur, …).

Usage:
  python transcribe.py <audio> [--model medium] [--language auto|hi|en|…]
                         [--prefer-language hi] [--initial-prompt "…"]
                         [--device cpu] [--compute-type int8]
"""

from __future__ import annotations

import argparse
import json
import sys

# Whisper language codes commonly used in India
INDIC_LANGS = frozenset(
    {"hi", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "ur", "ne", "si", "as", "or"}
)

DEFAULT_PROMPTS: dict[str, str] = {
    "hi": (
        "यह एक कस्टमर सपोर्ट कॉल है। Hindi और English दोनों हो सकते हैं। "
        "This is a customer support call in Hindi or Hinglish."
    ),
    "bn": "এটি একটি কাস্টমার সাপোর্ট কল। বাংলা এবং ইংরেজি মিশ্রিত হতে পারে।",
    "ta": "இது ஒரு வாடிக்கையாளர் ஆதரவு அழைப்பு. தமிழ் மற்றும் ஆங்கிலம் கலந்திருக்கலாம்.",
    "te": "ఇది కస్టమర్ సపోర్ట్ కాల్. తెలుగు మరియు ఇంగ్లీష్ కలిసి ఉండవచ్చు.",
    "mr": "ही एक कस्टमर सपोर्ट कॉल आहे. मराठी आणि इंग्रजी मिसळलेले असू शकतात.",
    "gu": "આ એક કસ્ટમર સપોર્ટ કૉલ છે. ગુજરાતી અને અંગ્રેજી મિશ્રિત હોઈ શકે.",
    "kn": "ಇದು ಕಸ್ಟಮರ್ ಸಪೋರ್ಟ್ ಕರೆ. ಕನ್ನಡ ಮತ್ತು ಇಂಗ್ಲಿಷ್ ಮಿಶ್ರಿತವಾಗಿರಬಹುದು.",
    "ml": "ഇതൊരു കസ്റ്റമർ സപ്പോർട്ട് കോളാണ്. മലയാളവും ഇംഗ്ലീഷും കലർന്നിരിക്കാം.",
    "pa": "ਇਹ ਇੱਕ ਕਸਟਮਰ ਸਪੋਰਟ ਕਾਲ ਹੈ। ਪੰਜਾਬੀ ਅਤੇ ਅੰਗਰੇਜ਼ੀ ਮਿਲੀ ਹੋ ਸਕਦੀ ਹੈ।",
    "ur": "یہ ایک کسٹمر سپورٹ کال ہے۔ اردو اور انگریزی دونوں ہو سکتے ہیں۔",
}


def _transcribe(model, audio_path: str, language: str | None, initial_prompt: str | None):
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        beam_size=5,
        best_of=5,
        # Helps Hinglish / short Indian-language turns
        condition_on_previous_text=True,
        initial_prompt=initial_prompt or None,
        # Without this, Whisper may transliterate Hindi into Latin script oddly
        word_timestamps=False,
    )
    segments = []
    parts = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            }
        )
        parts.append(text)
    return {
        "text": " ".join(parts).strip(),
        "language": getattr(info, "language", None),
        "languageProbability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "segments": segments,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--language", default="auto")
    parser.add_argument(
        "--prefer-language",
        default="",
        help="If auto detects poorly, retry with this code (e.g. hi)",
    )
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "faster_whisper_not_installed",
                    "message": "pip install -r scripts/stt/requirements.txt",
                }
            ),
            file=sys.stderr,
        )
        return 2

    device = args.device
    compute_type = args.compute_type
    if device == "auto":
        device = "cpu"
        if compute_type == "default":
            compute_type = "int8"
    elif compute_type == "default":
        compute_type = "float16" if device == "cuda" else "int8"

    lang_arg = (args.language or "auto").strip().lower()
    prefer = (args.prefer_language or "").strip().lower()
    prompt = (args.initial_prompt or "").strip()
    if not prompt:
        prompt_key = lang_arg if lang_arg not in ("", "auto", "null") else prefer or "hi"
        prompt = DEFAULT_PROMPTS.get(prompt_key, DEFAULT_PROMPTS["hi"])

    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)

        if lang_arg in ("", "auto", "null"):
            # Pass 1: detect
            out = _transcribe(model, args.audio_path, None, prompt)
            detected = (out.get("language") or "").lower()
            prob = float(out.get("languageProbability") or 0)

            # Retry in preferred Indic language when detection is weak / English-biased
            # (common for Hinglish customer calls)
            should_retry = False
            if prefer:
                if detected != prefer and (prob < 0.72 or detected == "en"):
                    should_retry = True
                if prefer in INDIC_LANGS and detected not in INDIC_LANGS and detected != prefer:
                    should_retry = True

            if should_retry and prefer:
                retry = _transcribe(model, args.audio_path, prefer, prompt)
                # Keep retry if it produced more Devanagari / longer text, else keep detect
                def score(o: dict) -> tuple:
                    text = o.get("text") or ""
                    indic_chars = sum(1 for c in text if "\u0900" <= c <= "\u097f")
                    return (indic_chars, len(text))

                if score(retry) >= score(out):
                    out = retry
                    out["languageSource"] = f"prefer:{prefer}"
                else:
                    out["languageSource"] = "auto"
            else:
                out["languageSource"] = "auto"
        else:
            out = _transcribe(model, args.audio_path, lang_arg, prompt)
            out["languageSource"] = "forced"

        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": "transcribe_failed", "message": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
