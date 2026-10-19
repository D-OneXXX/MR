# 端到端烟测:合成漫画风图 → detect → ocr → inpaint(直接调 pipeline,验证模型接线)。
# 运行: "%BT_ROOT%\ballontrans_pylibs_win\python.exe" sidecar\smoke_test.py
import os
import sys

import numpy as np

BT_ROOT = os.environ.get(
    "BT_ROOT", r"D:\BallonsTranslator\Ballonstranslator_win_minium"
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline  # noqa: E402

import cv2  # noqa: E402


def make_sample() -> np.ndarray:
    """640x640 灰底 + 白气泡 + 日文台词(風体横排两行)。"""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (640, 640), (120, 120, 130))
    d = ImageDraw.Draw(img)
    d.ellipse([80, 80, 560, 340], fill=(255, 255, 255), outline=(40, 40, 40), width=4)
    font = None
    for name in ("msgothic.ttc", "YuGothM.ttc", "meiryo.ttc", "YuGothR.ttc"):
        p = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(p):
            font = ImageFont.truetype(p, 44)
            break
    if font is None:
        raise SystemExit("找不到日文字体,无法合成样图")
    d.text((150, 140), "テスト読み取り", font=font, fill=(10, 10, 10))
    d.text((150, 220), "英語ではありません", font=font, fill=(10, 10, 10))
    return np.array(img)[:, :, ::-1].copy()  # RGB→BGR


def main():
    img = make_sample()
    print("[1/3] detect(ctd) 推理中…(首次加载模型较慢)")
    det = pipeline.detect(img)
    boxes = det["boxes"]
    print(f"  boxes={len(boxes)}", [f"({b['x']},{b['y']},{b['w']}x{b['h']},v={b['vertical']})" for b in boxes[:6]])

    # OCR 框:mit48px 是单行模型,按行喂框(两步工作流里由人工确认/拆分)。
    use = [
        {"x": 140, "y": 130, "w": 380, "h": 70, "vertical": False},
        {"x": 140, "y": 205, "w": 380, "h": 70, "vertical": False},
    ]
    print("[2/3] ocr(mit48pxctc) 推理中…")
    ocr = pipeline.ocr(img, use)
    for r in ocr["results"]:
        print(f"  ({r['x']},{r['y']}) -> {r['text']!r}")

    print("[3/3] inpaint(lama_large_512px) 推理中…")
    inp = pipeline.inpaint(img, use)
    import base64

    out_img = cv2.imdecode(
        np.frombuffer(base64.b64decode(inp["image"]), dtype=np.uint8), cv2.IMREAD_COLOR
    )
    assert out_img.shape == img.shape, f"擦除图尺寸不符 {out_img.shape}"
    diff = float(np.abs(out_img.astype(int) - img.astype(int)).mean())
    print(f"  尺寸 {out_img.shape} 平均像素差 {diff:.2f}(>0 说明确实涂改了)")

    print("\nSMOKE OK")


if __name__ == "__main__":
    main()
