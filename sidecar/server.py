# sidecar — 漫画翻译模型本地 HTTP 服务(契约见 docs/sidecar-api.md)
# 标准库 http.server 实现,零第三方服务依赖;推理全部在 pipeline.py(复用 BT 模块)。
# 运行: BallonsTranslator 自带 python.exe server.py (env: SIDECAR_PORT, SIDECAR_DEVICE, BT_ROOT)

import base64
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline  # noqa: E402

DEVICE = pipeline.DEVICE
PORT = int(os.environ.get("SIDECAR_PORT", "8500"))


def b64_to_img(s: str):
    import numpy as np

    try:
        buf = base64.b64decode(s)
    except Exception as e:
        raise BadRequest(f"image 不是合法 base64:{e}")
    img = cv2_imdecode(buf)
    if img is None:
        raise BadRequest("image 解码失败,需要 PNG/JPEG 字节")
    return img


def cv2_imdecode(buf: bytes):
    import cv2
    import numpy as np

    arr = np.frombuffer(buf, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)  # BGR


def boxes_of(req: dict) -> list:
    boxes = req.get("boxes", [])
    if not isinstance(boxes, list):
        raise BadRequest("boxes 必须是数组")
    for b in boxes:
        for k in ("x", "y", "w", "h"):
            if not isinstance(b.get(k), (int, float)) or b[k] < 0:
                raise BadRequest(f"boxes 项缺少非负整数 {k}")
    return boxes


class BadRequest(Exception):
    pass


class ServiceUnavailable(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write("[sidecar] " + fmt % args + "\n")

    # ---- routes -------------------------------------------------------
    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "device": DEVICE,
                    "models": pipeline.states(),
                },
            )
        else:
            self._json(404, {"error": f"未知路径 {self.path}"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length).decode("utf-8"))
            t0 = time.time()
            if self.path == "/v1/detect":
                img = b64_to_img(req.get("image"))
                out = pipeline.detect(img)
            elif self.path == "/v1/ocr":
                img = b64_to_img(req.get("image"))
                out = pipeline.ocr(img, boxes_of(req))
            elif self.path == "/v1/inpaint":
                img = b64_to_img(req.get("image"))
                out = pipeline.inpaint(img, boxes_of(req))
            else:
                self._json(404, {"error": f"未知路径 {self.path}"})
                return
            out["elapsedMs"] = int((time.time() - t0) * 1000)
            self._json(200, out)
        except ServiceUnavailable as e:
            self._json(503, {"error": str(e)})
        except BadRequest as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - 推理异常要有中文摘要,不静默
            traceback.print_exc()
            self._json(500, {"error": f"sidecar 推理异常:{e}"})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(
        f"[sidecar] listening on 127.0.0.1:{PORT} device={DEVICE} models={pipeline.MODELS_DIR}",
        flush=True,
    )
    srv.serve_forever()


if __name__ == "__main__":
    main()
