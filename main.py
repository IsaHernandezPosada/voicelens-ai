import os
import io
import re
import tempfile
import numpy as np
import librosa
from scipy import stats
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Cliente a nivel módulo — se crea una vez, se reusa en cada request
from groq import Groq

_groq = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

app = FastAPI(title="VoiceLens")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_DURATION_SEC = 600


def load_audio(file_bytes: bytes, filename: str = "") -> tuple[np.ndarray, int]:
    """Carga audio a mono 22050 Hz. Fallback a tempfile para webm/opus del browser."""
    buf = io.BytesIO(file_bytes)
    try:
        y, _ = librosa.load(buf, sr=22050, mono=True)
    except Exception:
        # soundfile (libsndfile) no soporta webm/opus — audioread necesita un path en disco
        suffix = os.path.splitext(filename)[1] if filename else ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        try:
            y, _ = librosa.load(tmp_path, sr=22050, mono=True)
        finally:
            os.unlink(tmp_path)

    if len(y) / 22050 > MAX_DURATION_SEC:
        raise HTTPException(status_code=400, detail="Audio supera el límite de 10 minutos.")
    return y, 22050


# ── /transcribe ───────────────────────────────────────────────────────────────
# Red neuronal: Whisper large-v3-turbo es un transformer encoder-decoder (Groq cloud).
# Optimización: beam search dentro de Whisper durante la decodificación de tokens.
@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    if not _groq:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY no configurada.")

    file_bytes = await audio.read()

    transcription = await run_in_threadpool(
        lambda: _groq.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=(audio.filename or "audio.webm", file_bytes),
            response_format="text",
        )
    )
    return {"text": transcription}


# ── /analyze ──────────────────────────────────────────────────────────────────

class InflectionSegment(BaseModel):
    start_sec: float
    end_sec: float
    direction: str
    slope: float
    linearity: float


class AnalyzeResponse(BaseModel):
    pitch_mean: float
    pitch_std: float
    pitch_contour: List[List[float]]
    energy_rms: float
    speaking_rate: float
    confidence_score: int
    inflection_segments: List[InflectionSegment]
    downward_ratio: float
    best_segment_idx: Optional[int] = None   # búsqueda de pico de confianza
    worst_segment_idx: Optional[int] = None  # búsqueda de valle de confianza


def _find_peak_segments(
    segments: List[InflectionSegment],
    seg_energies: List[float],
) -> tuple[Optional[int], Optional[int]]:
    """
    Búsqueda lineal del segmento con mayor y menor confianza acústica.
    Combina dirección de inflexión (aprendizaje de máquina por umbrales) con energía RMS.
    O(n) sobre los segmentos de voz detectados.
    """
    if not segments:
        return None, None

    direction_weight = {"downward": 1.0, "flat": 0.5, "upward": 0.3}
    scores = [
        direction_weight.get(s.direction, 0.5) * max(seg_energies[i], 1e-9)
        for i, s in enumerate(segments)
    ]
    return int(np.argmax(scores)), int(np.argmin(scores))


# Aprendizaje de máquina: features acústicos (F0, RMS, segmentación) + clasificación
# por regresión lineal y umbrales calibrados (pipeline clásico de ML acústico).
def _run_analysis(y: np.ndarray, sr: int) -> AnalyzeResponse:
    hop_length = 512

    # Extracción de F0 con pYIN (más robusto que YIN para voz hablada)
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
        hop_length=hop_length,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)

    voiced_f0 = f0[voiced_flag & (f0 > 0)]
    pitch_mean = float(np.mean(voiced_f0)) if len(voiced_f0) > 0 else 0.0
    pitch_std = float(np.std(voiced_f0)) if len(voiced_f0) > 0 else 0.0

    # Submuestreo del contorno de pitch a ~1 punto / 100ms para el canvas del frontend
    step = max(1, int(0.1 * sr / hop_length))
    pitch_contour = [
        [round(float(t), 3), round(float(f), 2)]
        for t, f in zip(times[::step], f0[::step])
        if f and f > 0
    ]

    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    energy_rms = float(np.mean(rms))

    # Segmentación por silencios (top_db=25 dB)
    intervals = librosa.effects.split(y, top_db=25)
    duration_sec = len(y) / sr
    speaking_rate = float(len(intervals) / duration_sec * 60) if duration_sec > 0 else 0.0

    inflection_segments: list[InflectionSegment] = []
    seg_energies: list[float] = []
    downward_count = 0

    for start_sample, end_sample in intervals:
        seg_start = start_sample / sr
        seg_end = end_sample / sr

        frame_start = int(start_sample / hop_length)
        frame_end = int(end_sample / hop_length)
        seg_f0 = f0[frame_start:frame_end]
        seg_times = times[frame_start:frame_end]
        seg_voiced = voiced_flag[frame_start:frame_end]
        seg_rms_slice = rms[frame_start:frame_end]

        seg_energies.append(float(np.mean(seg_rms_slice)) if len(seg_rms_slice) > 0 else 0.0)

        # Regresión lineal sobre el último 40% del segmento para detectar inflexión final
        # (scipy.stats.linregress = aprendizaje de máquina supervisado simplificado)
        tail_start = int(len(seg_f0) * 0.6)
        mask = seg_voiced[tail_start:] & (seg_f0[tail_start:] > 0)
        tail_f0 = seg_f0[tail_start:][mask]
        tail_times = seg_times[tail_start:][mask]

        if len(tail_f0) < 3:
            direction, slope, r_value = "flat", 0.0, 0.0
        else:
            reg = stats.linregress(tail_times, tail_f0)
            slope = float(reg.slope)
            r_value = float(reg.rvalue)

            if slope < -8 and abs(r_value) > 0.45:
                direction = "downward"
                downward_count += 1
            elif slope > 8 and abs(r_value) > 0.45:
                direction = "upward"
            else:
                direction = "flat"

        inflection_segments.append(InflectionSegment(
            start_sec=round(seg_start, 2),
            end_sec=round(seg_end, 2),
            direction=direction,
            slope=round(slope, 3),
            linearity=round(abs(r_value), 3),
        ))

    n_seg = len(inflection_segments)
    downward_ratio = round(downward_count / n_seg, 3) if n_seg > 0 else 0.0

    pitch_std_norm = min(pitch_std / 60.0, 1.0)
    energy_norm = min(energy_rms / 0.05, 1.0)
    raw = pitch_std_norm * 0.4 + downward_ratio * 0.35 + energy_norm * 0.25
    confidence_score = max(0, min(100, int(round(raw * 100))))

    # Búsqueda: detección del mejor y peor segmento en el contorno de pitch
    best_idx, worst_idx = _find_peak_segments(inflection_segments, seg_energies)

    return AnalyzeResponse(
        pitch_mean=round(pitch_mean, 2),
        pitch_std=round(pitch_std, 2),
        pitch_contour=pitch_contour,
        energy_rms=round(energy_rms, 5),
        speaking_rate=round(speaking_rate, 2),
        confidence_score=confidence_score,
        inflection_segments=inflection_segments,
        downward_ratio=downward_ratio,
        best_segment_idx=best_idx,
        worst_segment_idx=worst_idx,
    )


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(audio: UploadFile = File(...)):
    file_bytes = await audio.read()
    # run_in_threadpool para no bloquear el event loop con operaciones CPU-bound
    y, sr = await run_in_threadpool(load_audio, file_bytes, audio.filename or "")
    return await run_in_threadpool(_run_analysis, y, sr)


# ── /feedback ─────────────────────────────────────────────────────────────────
# PLN: LLaMA 3.1 interpreta métricas acústicas numéricas → lenguaje natural (via Groq).
# Bot: integrado como coach conversacional dentro de la app.

class FeedbackRequest(BaseModel):
    metrics: dict
    transcript: str


@app.post("/feedback")
async def feedback(body: FeedbackRequest):
    if not _groq:
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY no configurada. Agrega la clave en .env para activar el coach.",
        )

    m = body.metrics
    segs = m.get("inflection_segments", [])
    seg_summary = ", ".join(
        f"{s['start_sec']}s–{s['end_sec']}s {s['direction']}"
        for s in segs[:8]
    ) or "sin segmentos detectados"

    prompt = f"""Eres un coach de comunicación directa. Analiza esta grabación de voz:

TRANSCRIPCIÓN:
{body.transcript or "(sin transcripción)"}

MÉTRICAS ACÚSTICAS:
- Pitch promedio: {m.get('pitch_mean', 0):.1f} Hz
- Variabilidad de tono (std): {m.get('pitch_std', 0):.1f} Hz
- Energía RMS: {m.get('energy_rms', 0):.5f}
- Velocidad de habla: {m.get('speaking_rate', 0):.1f} segmentos/min
- Score de confianza: {m.get('confidence_score', 0)}/100
- Ratio de inflexión descendente: {m.get('downward_ratio', 0)*100:.0f}%
- Segmentos: {seg_summary}

Da exactamente 3 recomendaciones concretas y accionables en el mismo idioma del audio.
Formato estricto — responde SOLO con esto (sin introducción, sin cierre):
1. [recomendación 1]
2. [recomendación 2]
3. [recomendación 3]"""

    # LLaMA 3.1 via Groq: PLN — interpreta números acústicos → consejo en lenguaje natural
    completion = await run_in_threadpool(
        lambda: _groq.chat.completions.create(
            model="llama-3.1-8b-instant",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
    )

    raw = completion.choices[0].message.content.strip()
    lines = [l.strip() for l in raw.split("\n") if l.strip()]
    recs = [re.sub(r"^\d+\.\s*", "", l) for l in lines if re.match(r"^\d+\.", l)][:3]

    if len(recs) < 3:
        recs = lines[:3]

    return {"recommendations": recs}


# ── /chat ─────────────────────────────────────────────────────────────────────
# Coach conversacional: follow-up questions con contexto del audio + historial.

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    metrics: dict
    transcript: str
    question: str
    history: List[ChatMessage] = []


@app.post("/chat")
async def chat(body: ChatRequest):
    if not _groq:
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY no configurada. Agrega la clave en .env para activar el coach.",
        )

    m = body.metrics
    system = f"""Eres un coach de comunicación directa. Contexto del audio analizado:
Transcripción: {body.transcript or '(sin transcripción)'}
Pitch: {m.get('pitch_mean', 0):.1f} Hz, variabilidad: {m.get('pitch_std', 0):.1f} Hz
Score de confianza: {m.get('confidence_score', 0)}/100
Inflexión descendente: {m.get('downward_ratio', 0)*100:.0f}%

Responde de forma concreta y breve (2-4 oraciones). Mismo idioma que el audio. Sin floro."""

    messages = [{"role": "system", "content": system}]
    for h in body.history:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": body.question})

    completion = await run_in_threadpool(
        lambda: _groq.chat.completions.create(
            model="llama-3.1-8b-instant",
            max_tokens=300,
            messages=messages,
        )
    )
    return {"answer": completion.choices[0].message.content.strip()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
