"""本地转写（faster-whisper），给 tools/transcribe.mjs 调用。

用法：
  python tools/whisper_transcribe.py --input audio.wav --out <dir> --model small --lang zh --device auto

device=auto 时优先 GPU（cuda/float16），失败自动退回 CPU（int8）。
输出：<dir>/transcript.txt、<dir>/transcript.srt、<dir>/transcript.json
"""
import argparse
import json
import os
import site
import sys

# 国内直连 huggingface.co 经常不通；走镜像（可由环境变量覆盖）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 镜像是普通 HTTP，不支持 HF 的 Xet 存储（否则 401）；关掉它走传统下载
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def register_cuda_dlls() -> bool:
    """把 pip 装的 nvidia-cublas/cudnn 的 DLL 目录挂上；返回是否找到了 cublas。"""
    found = False
    bases = {site.getusersitepackages(), *site.getsitepackages()}
    for base in bases:
        for sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
            p = os.path.join(base, *sub.split("/"))
            if not os.path.isdir(p):
                continue
            try:
                os.add_dll_directory(p)
            except OSError:
                pass
            os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
            if "cublas" in sub:
                found = True
    return found


def load_model(name: str, device: str):
    from faster_whisper import WhisperModel

    if device == "cpu":
        return WhisperModel(name, device="cpu", compute_type="int8"), "cpu/int8"
    try:
        return WhisperModel(name, device="cuda", compute_type="float16"), "cuda/float16"
    except Exception as exc:  # noqa: BLE001 - 任何 CUDA 问题都退回 CPU
        print(f"[warn] GPU 不可用（{type(exc).__name__}: {str(exc)[:160]}），退回 CPU", file=sys.stderr)
        return WhisperModel(name, device="cpu", compute_type="int8"), "cpu/int8"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = ap.parse_args()

    has_cuda = register_cuda_dlls()
    os.makedirs(args.out, exist_ok=True)

    def run_once(model_obj):
        segs, inf = model_obj.transcribe(
            args.input,
            language=None if args.lang in ("auto", "none") else args.lang,
            beam_size=args.beam,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # 不加这句 base 模型经常吐繁体/同音字；提示它用简体普通话
            initial_prompt="以下是普通话对话，请用简体中文转写。",
            condition_on_previous_text=False,
        )
        collected = []
        for seg in segs:
            collected.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
            print(f"[{int(seg.start // 60):02d}:{int(seg.start % 60):02d}] {seg.text.strip()}", flush=True)
        return collected, inf

    device = "cuda" if args.device == "auto" else args.device
    if device == "cuda" and not has_cuda:
        print("[warn] 没找到 CUDA 运行库（cublas/cudnn），直接用 CPU", file=sys.stderr)
        device = "cpu"
    model, backend = load_model(args.model, device)
    rows, info = [], None
    try:
        rows, info = run_once(model)
    except Exception as exc:  # noqa: BLE001 - CUDA 的错经常在第一次 encode 才抛（cublas/cudnn 缺失）
        if backend.startswith("cuda"):
            print(f"[warn] GPU 推理失败（{type(exc).__name__}: {str(exc)[:160]}），改用 CPU 重跑", file=sys.stderr)
            model, backend = load_model(args.model, "cpu")
            rows, info = run_once(model)
        else:
            raise
    print(f"[model] {args.model} on {backend}", file=sys.stderr)

    txt = "\n".join(r["text"] for r in rows)
    with open(os.path.join(args.out, "transcript.txt"), "w", encoding="utf-8") as f:
        f.write(txt + "\n")

    def ts(sec: float) -> str:
        ms = int(round(sec * 1000))
        h, ms = divmod(ms, 3600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with open(os.path.join(args.out, "transcript.srt"), "w", encoding="utf-8") as f:
        for i, r in enumerate(rows, 1):
            f.write(f"{i}\n{ts(r['start'])} --> {ts(r['end'])}\n{r['text']}\n\n")

    with open(os.path.join(args.out, "transcript.json"), "w", encoding="utf-8") as f:
        json.dump({"model": args.model, "language": info.language, "duration": info.duration, "segments": rows}, f, ensure_ascii=False, indent=2)

    print(f"[done] {len(rows)} segments, lang={info.language}, dur={info.duration:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
