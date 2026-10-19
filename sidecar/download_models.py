# 模型按需下载 — 不打进安装包,管理员运行本脚本(或 setup.bat)拉到 sidecar/models/。
# 均为上游开源模型权重:HuggingFace dreMaz/mit_models、dreMaz/AnimeMangaInpainting。
import os
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("SIDECAR_MODELS", os.path.join(HERE, "models"))
HF = os.environ.get("HF_ENDPOINT", "https://huggingface.co")

FILES = [
    # (url, 保存相对路径, 是否 zip 解包)
    (f"{HF}/dreMaze/mit_models/resolve/main/comictextdetector.pt", "comictextdetector.pt", False),
    (f"{HF}/dreMaze/mit_models/resolve/main/ocr-ctc.zip", "ocr-ctc.zip", True),
    (f"{HF}/dreMaze/AnimeMangaInpainting/resolve/main/lama_large_512px.ckpt", "lama_large_512px.ckpt", False),
]


def fetch(url: str, dest: str):
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
        print(f"[skip] {os.path.basename(dest)} 已存在")
        return
    print(f"[down] {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "manga-reader-sidecar"})

    def hook(n, bs, total):
        if total > 0:
            pct = min(100, n * bs * 100 // total)
            sys.stdout.write(f"\r  {pct}%  {n * bs // 1048576} / {total // 1048576} MB")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, dest + ".part", reporthook=hook)
    print()
    os.replace(dest + ".part", dest)


def main():
    os.makedirs(MODELS, exist_ok=True)
    for url, rel, is_zip in FILES:
        dest = os.path.join(MODELS, rel)
        fetch(url, dest)
        if is_zip:
            ckpt = os.path.join(MODELS, "mit48pxctc_ocr.ckpt")
            dictf = os.path.join(MODELS, "alphabet-all-v5.txt")
            if not (os.path.exists(ckpt) and os.path.exists(dictf)):
                print("[unzip] ocr-ctc.zip")
                with zipfile.ZipFile(dest) as z:
                    for name in z.namelist():
                        base = os.path.basename(name)
                        if base == "ocr-ctc.ckpt":
                            with z.open(name) as src, open(ckpt, "wb") as dst:
                                dst.write(src.read())
                        elif base == "alphabet-all-v5.txt":
                            with z.open(name) as src, open(dictf, "wb") as dst:
                                dst.write(src.read())
            os.remove(dest)

    need = ["comictextdetector.pt", "mit48pxctc_ocr.ckpt", "alphabet-all-v5.txt", "lama_large_512px.ckpt"]
    missing = [f for f in need if not os.path.exists(os.path.join(MODELS, f))]
    if missing:
        print(f"[FAIL] 缺少 {missing}")
        sys.exit(1)
    print("[OK] 模型齐备:", MODELS)


if __name__ == "__main__":
    main()
