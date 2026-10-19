# 无头推理管线 — ctd(检测)/ mit48pxctc(OCR)/ lama_large_512px(擦除)
# 全部通过 vendor/ 内联的模型代码推理,自包含:不依赖任何外部安装(BallonsTranslator 等)。
# 模型文件在 models/ 下,由 download_models.py 按需下载(或手动放置)。

import base64
import os
import threading

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.environ.get("SIDECAR_MODELS", os.path.join(HERE, "models"))
DEVICE = os.environ.get("SIDECAR_DEVICE", "cpu").lower()

CTD_PATH = os.path.join(MODELS_DIR, "comictextdetector.pt")  # torch 后端,CPU 可用
OCR_PATH = os.path.join(MODELS_DIR, "mit48pxctc_ocr.ckpt")
OCR_DICT = os.path.join(MODELS_DIR, "alphabet-all-v5.txt")
LAMA_PATH = os.path.join(MODELS_DIR, "lama_large_512px.ckpt")

INPAINT_SIZE = 1024

_lock = threading.Lock()
_models = {}  # name -> loaded model


def _get(name: str, loader):
    model = _models.get(name)
    if model is None:
        with _lock:
            model = _models.get(name)
            if model is None:
                _models[name] = loader()
                model = _models[name]
    return model


def _require(path: str):
    if not os.path.exists(path):
        raise FileNotFoundError(f"模型缺失:{path}(运行 download_models.py 下载)")


def _load_detector():
    from vendor.ctd.inference import TextDetector as CTDModel

    _require(CTD_PATH)
    # .pt = torch 后端,CPU 可用(不依赖 onnxruntime)。
    return CTDModel(CTD_PATH, detect_size=1024, device=DEVICE)


def _load_ocr():
    from vendor.mit48px_ctc import OCR48pxCTC

    _require(OCR_PATH)
    _require(OCR_DICT)
    return OCR48pxCTC(OCR_PATH, DEVICE, dict_path=OCR_DICT)


def _load_inpaint():
    from vendor.lama import load_lama_mpe

    _require(LAMA_PATH)
    return load_lama_mpe(LAMA_PATH, device=DEVICE, use_mpe=False, large_arch=True)


# ---- 模型状态(/health) ------------------------------------------------
def states() -> dict:
    files = {"detector": CTD_PATH, "ocr": OCR_PATH, "inpaint": LAMA_PATH}
    return {
        name: ("ready" if name in _models else ("missing" if not os.path.exists(rel) else "not_loaded"))
        for name, rel in files.items()
    }


# ---- /v1/detect ----------------------------------------------------------
def detect(img_bgr: np.ndarray) -> dict:
    model = _get("detector", _load_detector)
    _, _, blk_list = model(img_bgr)
    boxes = []
    for blk in blk_list:
        x1, y1, x2, y2 = blk.xyxy
        boxes.append(
            {
                "x": int(round(x1)),
                "y": int(round(y1)),
                "w": max(1, int(round(x2 - x1))),
                "h": max(1, int(round(y2 - y1))),
                "score": 1.0,
                "vertical": bool(getattr(blk, "vertical", False)),
            }
        )
    return {"boxes": boxes}


# ---- /v1/ocr ---------------------------------------------------------------
def _blk_from_box(box: dict, im_h: int, im_w: int):
    from vendor.textblock_min import TextBlock

    x1 = float(np.clip(box["x"], 0, im_w - 1))
    y1 = float(np.clip(box["y"], 0, im_h - 1))
    x2 = float(np.clip(box["x"] + box["w"], x1 + 1, im_w))
    y2 = float(np.clip(box["y"] + box["h"], y1 + 1, im_h))
    blk = TextBlock(xyxy=[x1, y1, x2, y2])
    # 轴对齐四边形(左上→右上→右下→左下);get_transformed_region 据此做透视矫正。
    blk.lines = [np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32)]
    blk.src_is_vertical = bool(box.get("vertical", (y2 - y1) > (x2 - x1)))
    return blk


def ocr(img_bgr: np.ndarray, boxes: list) -> dict:
    if not boxes:
        return {"results": []}
    model = _get("ocr", _load_ocr)
    from vendor.textblock_min import collect_textblock_regions

    im_h, im_w = img_bgr.shape[:2]
    blocks = [_blk_from_box(b, im_h, im_w) for b in boxes]
    regions, indices = collect_textblock_regions(
        img_bgr, blocks, model.text_height, model.maxwidth
    )
    model(blocks, regions, indices, chunk_size=16)
    results = [
        {
            "x": int(b["x"]),
            "y": int(b["y"]),
            "w": int(b["w"]),
            "h": int(b["h"]),
            "text": "".join(blk.text).strip(),
        }
        for b, blk in zip(boxes, blocks)
    ]
    return {"results": results}


# ---- /v1/inpaint -----------------------------------------------------------
def _inpaint_preprocess(model, img: np.ndarray, mask: np.ndarray):
    """移植自 BT LamaLarge.inpaint_preprocess:限边 + 64 对齐反射填充 + 白区置零。"""
    import torch

    from vendor.imgproc_utils import resize_keepasp

    mask_original = np.copy(mask)
    mask_original[mask_original < 127] = 0
    mask_original[mask_original >= 127] = 1
    mask_original = mask_original[:, :, None]

    new_shape = INPAINT_SIZE if max(img.shape[0:2]) > INPAINT_SIZE else None
    img_r = resize_keepasp(img, new_shape, stride=None)
    mask_r = resize_keepasp(mask, new_shape, stride=None)

    im_h, im_w = img_r.shape[:2]
    longer = (max(im_h, im_w) + 63) // 64 * 64
    pad_bottom = longer - im_h
    pad_right = longer - im_w
    mask_p = cv2.copyMakeBorder(mask_r, 0, pad_bottom, 0, pad_right, cv2.BORDER_REFLECT)
    img_p = cv2.copyMakeBorder(img_r, 0, pad_bottom, 0, pad_right, cv2.BORDER_REFLECT)

    img_torch = torch.from_numpy(img_p).permute(2, 0, 1).unsqueeze_(0).float() / 255.0
    mask_torch = torch.from_numpy(mask_p).unsqueeze_(0).unsqueeze_(0).float() / 255.0
    mask_torch[mask_torch < 0.5] = 0
    mask_torch[mask_torch >= 0.5] = 1
    rel_pos, _, direct = model.load_masked_position_encoding(mask_torch[0][0].numpy())
    rel_pos = torch.LongTensor(rel_pos).unsqueeze_(0)
    direct = torch.LongTensor(direct).unsqueeze_(0)

    if DEVICE != "cpu":
        img_torch = img_torch.to(DEVICE)
        mask_torch = mask_torch.to(DEVICE)
        rel_pos = rel_pos.to(DEVICE)
        direct = direct.to(DEVICE)
    img_torch *= 1 - mask_torch
    return img_torch, mask_torch, rel_pos, direct, img_r, mask_original, pad_bottom, pad_right


def inpaint(img_bgr: np.ndarray, boxes: list) -> dict:
    if not boxes:
        return {"image": _encode(img_bgr)}
    import torch

    model = _get("inpaint", _load_inpaint)
    mask = np.zeros(img_bgr.shape[:2], dtype=np.uint8)
    for b in boxes:
        x1 = int(np.clip(b["x"], 0, img_bgr.shape[1] - 1))
        y1 = int(np.clip(b["y"], 0, img_bgr.shape[0] - 1))
        x2 = int(np.clip(b["x"] + b["w"], x1 + 1, img_bgr.shape[1]))
        y2 = int(np.clip(b["y"] + b["h"], y1 + 1, img_bgr.shape[0]))
        mask[y1:y2, x1:x2] = 255

    img_torch, mask_torch, rel_pos, direct, img_r, mask_original, pad_bottom, pad_right = (
        _inpaint_preprocess(model, img_bgr, mask)
    )
    with torch.no_grad():
        out = model(img_torch, mask_torch, rel_pos, direct)
    img_inpainted = out.to(device="cpu", dtype=torch.float32).squeeze_(0).permute(1, 2, 0).numpy() * 255
    img_inpainted = (np.clip(np.round(img_inpainted), 0, 255)).astype(np.uint8)
    if pad_bottom > 0:
        img_inpainted = img_inpainted[:-pad_bottom]
    if pad_right > 0:
        img_inpainted = img_inpainted[:, :-pad_right]
    im_h0, im_w0 = img_bgr.shape[:2]
    if img_inpainted.shape[0] != im_h0 or img_inpainted.shape[1] != im_w0:
        img_inpainted = cv2.resize(img_inpainted, (im_w0, im_h0), interpolation=cv2.INTER_LINEAR)
    # 掩膜外保持原图像素。
    m = mask_original.astype(np.float32)
    out = img_inpainted.astype(np.float32) * m + img_bgr.astype(np.float32) * (1 - m)
    return {"image": _encode(out.astype(np.uint8))}


def _encode(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("结果图 PNG 编码失败")
    return base64.b64encode(buf.tobytes()).decode("ascii")
