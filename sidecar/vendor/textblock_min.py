"""最小 TextBlock 与文本框分组 —— 自 BallonsTranslator `utils/textblock.py`
与 manga-image-translator 移植的运行时子集,仅保留两条链路所需:
1) ctd 检测后处理:group_output / examine_textblk / merge_textlines / sort_regions;
2) mit48px OCR 的区域准备:get_transformed_region / collect_textblock_regions。
上游:BallonsTranslator(GPL-3.0)、manga-image-translator(GPL-3.0)。
"""

import copy
import math
from typing import Callable, List

import cv2
import numpy as np
from shapely.geometry import Polygon

from .imgproc_utils import rotate_polygons, union_area, xywh2xyxypoly

LANG_LIST = ["eng", "ja", "unknown"]


class TextBlock:
    """运行时容器:字段与 BT 版语义一致,但去掉排版/字体等阅读器侧职责。"""

    def __init__(
        self,
        xyxy=None,
        lines=None,
        language: str = "unknown",
        angle: int = 0,
        translation: str = "",
    ):
        self.xyxy: List = list(xyxy) if xyxy is not None else [0, 0, 0, 0]
        self.lines: List = lines if lines is not None else []
        self.language = language
        self.angle = angle
        self.distance: np.ndarray = None
        self.vec: List = None
        self.norm: float = -1.0
        self.merged = False
        self.text: List = []
        self.translation = translation
        self.src_is_vertical: bool = None
        self._detected_font_size: float = -1
        self.det_model: str = None
        self.font_size: float = -1
        self.vertical: bool = False
        self.fg_colors = None
        self.bg_colors = None

    def __len__(self) -> int:
        return len(self.lines)

    def lines_array(self, dtype=np.float64):
        return np.array(self.lines, dtype=dtype)

    def center(self) -> np.ndarray:
        xyxy = np.array(self.xyxy)
        return (xyxy[:2] + xyxy[2:]) / 2

    def adjust_bbox(self, with_bbox=False, x_range=None, y_range=None):
        lines = self.lines_array().astype(np.int32)
        if with_bbox:
            self.xyxy[0] = min(lines[..., 0].min(), self.xyxy[0])
            self.xyxy[1] = min(lines[..., 1].min(), self.xyxy[1])
            self.xyxy[2] = max(lines[..., 0].max(), self.xyxy[2])
            self.xyxy[3] = max(lines[..., 1].max(), self.xyxy[3])
        else:
            self.xyxy[0] = lines[..., 0].min()
            self.xyxy[1] = lines[..., 1].min()
            self.xyxy[2] = lines[..., 0].max()
            self.xyxy[3] = lines[..., 1].max()
        if x_range is not None:
            self.xyxy[0] = np.clip(self.xyxy[0], x_range[0], x_range[1])
            self.xyxy[2] = np.clip(self.xyxy[2], x_range[0], x_range[1])
        if y_range is not None:
            self.xyxy[1] = np.clip(self.xyxy[1], y_range[0], y_range[1])
            self.xyxy[3] = np.clip(self.xyxy[3], y_range[0], y_range[1])

    def sort_lines(self):
        if self.distance is not None:
            idx = np.argsort(self.distance)
            self.distance = self.distance[idx]
            lines = np.array(self.lines, dtype=np.int32)
            self.lines = lines[idx].tolist()

    def unrotated_polygons(self, ids=None) -> np.ndarray:
        angled = self.angle != 0
        center = self.center()
        polygons = self.lines_array().reshape(-1, 8)
        if ids is not None:
            polygons = polygons[ids]
        if angled:
            polygons = rotate_polygons(center, polygons, self.angle)
        return angled, center, polygons

    def min_rect(self, rotate_back=True, ids=None) -> List[int]:
        angled, center, polygons = self.unrotated_polygons(ids=ids)
        min_x = polygons[:, ::2].min()
        min_y = polygons[:, 1::2].min()
        max_x = polygons[:, ::2].max()
        max_y = polygons[:, 1::2].max()
        min_bbox = np.array([[min_x, min_y, max_x, min_y, max_x, max_y, min_x, max_y]])
        if angled and rotate_back:
            min_bbox = rotate_polygons(center, min_bbox, -self.angle)
        return min_bbox.reshape(-1, 4, 2).astype(np.int64)

    def update_font_colors(self, fg_colors=None, bg_colors=None):
        if fg_colors is not None:
            self.fg_colors = fg_colors
        if bg_colors is not None:
            self.bg_colors = bg_colors

    def get_transformed_region(self, img: np.ndarray, idx: int, textheight: int, maxwidth: int = None) -> np.ndarray:
        im_h, im_w = img.shape[:2]
        line = np.round(np.array(self.lines[idx])).astype(np.int64)
        # det_model 恒为 None:不做 ctd 横排外扩(BT 的检测器包装层才有该语义)。
        x1, y1, x2, y2 = line[:, 0].min(), line[:, 1].min(), line[:, 0].max(), line[:, 1].max()
        x1 = np.clip(x1, 0, im_w)
        y1 = np.clip(y1, 0, im_h)
        x2 = np.clip(x2, 0, im_w)
        y2 = np.clip(y2, 0, im_h)
        img_croped = img[int(y1): int(y2), int(x1): int(x2)]

        direction = "v" if self.src_is_vertical else "h"
        src_pts = line.copy()
        src_pts[:, 0] -= x1
        src_pts[:, 1] -= y1
        middle_pnt = (src_pts[[1, 2, 3, 0]] + src_pts) / 2
        vec_v = middle_pnt[2] - middle_pnt[0]
        vec_h = middle_pnt[1] - middle_pnt[3]
        norm_v = np.linalg.norm(vec_v)
        norm_h = np.linalg.norm(vec_h)

        if norm_v <= 0 or norm_h <= 0:
            return np.zeros((textheight or 48, textheight or 48, 3), dtype=np.uint8)
        ratio = norm_v / norm_h

        if direction == "h":
            h = int(textheight)
            w = int(round(textheight / ratio))
            dst_pts = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]).astype(np.float32)
            M, _ = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
            if M is None:
                return np.zeros((textheight, textheight, 3), dtype=np.uint8)
            region = cv2.warpPerspective(img_croped, M, (w, h))
        else:
            w = int(textheight)
            h = int(round(textheight * ratio))
            dst_pts = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]).astype(np.float32)
            M, _ = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
            if M is None:
                return np.zeros((textheight, textheight, 3), dtype=np.uint8)
            region = cv2.warpPerspective(img_croped, M, (w, h))
            region = cv2.rotate(region, cv2.ROTATE_90_COUNTERCLOCKWISE)

        if maxwidth is not None:
            h, w = region.shape[:2]
            if w > maxwidth:
                region = cv2.resize(region, (maxwidth, h))
        return region


def sort_pnts(pts: np.ndarray):
    """四点排序:长边结构向量判定横/竖,并输出规范顺序(BT/manga-image-translator 版)。"""
    if isinstance(pts, List):
        pts = np.array(pts)
    pairwise_vec = (pts[:, None] - pts[None]).reshape((16, -1))
    pairwise_vec_norm = np.linalg.norm(pairwise_vec, axis=1)
    vec_norm_sort_ids = np.argsort(pairwise_vec_norm)
    long_side_ids = vec_norm_sort_ids[[8, 10]]
    pairwise_vec_norm_sorted = pairwise_vec_norm[vec_norm_sort_ids]
    long_side_vecs = pairwise_vec[long_side_ids]
    inner_prod = (long_side_vecs[0] * long_side_vecs[1]).sum()
    if inner_prod < 0:
        long_side_vecs[0] = -long_side_vecs[0]
    struc_vec = np.abs(long_side_vecs.mean(axis=0))
    is_vertical = bool(struc_vec[0] * 1.2 <= struc_vec[1])
    if len(set(pairwise_vec_norm_sorted[4:12])) == 1:  # 正方形
        is_vertical = False
    if is_vertical:
        pts = pts[np.argsort(pts[:, 1])]
        pts = pts[[*np.argsort(pts[:2, 0]), *np.argsort(pts[2:, 0])[::-1] + 2]]
        return pts, is_vertical
    pts = pts[np.argsort(pts[:, 0])]
    pts_sorted = np.zeros_like(pts)
    pts_sorted[[0, 3]] = sorted(pts[[0, 1]], key=lambda x: x[1])
    pts_sorted[[1, 2]] = sorted(pts[[2, 3]], key=lambda x: x[1])
    return pts_sorted, is_vertical


def examine_textblk(blk: TextBlock, im_w: int, im_h: int, sort: bool = False) -> None:
    lines = blk.lines_array()
    middle_pnts = (lines[:, [1, 2, 3, 0]] + lines) / 2
    vec_v = middle_pnts[:, 2] - middle_pnts[:, 0]
    vec_h = middle_pnts[:, 1] - middle_pnts[:, 3]
    center_pnts = (lines[:, 0] + lines[:, 2]) / 2
    v = np.sum(vec_v, axis=0)
    h = np.sum(vec_h, axis=0)
    norm_v, norm_h = np.linalg.norm(v), np.linalg.norm(h)
    vertical = blk.src_is_vertical
    if vertical:
        primary_vec, primary_norm = v, norm_v
        distance_vectors = center_pnts - np.array([[im_w, 0]], dtype=np.float64)
        font_size = int(round(norm_h / len(lines)))
    else:
        primary_vec, primary_norm = h, norm_h
        distance_vectors = center_pnts - np.array([[0, 0]], dtype=np.float64)
        font_size = int(round(norm_v / len(lines)))

    rotation_angle = int(math.atan2(primary_vec[1], primary_vec[0]) / math.pi * 180)
    distance = np.linalg.norm(distance_vectors, axis=1)
    rad_matrix = np.arccos(
        np.einsum("ij, j->i", distance_vectors, primary_vec) / (distance * primary_norm)
    )
    distance = np.abs(np.sin(rad_matrix) * distance)
    blk.lines = lines.astype(np.int32).tolist()
    blk.distance = distance
    blk.angle = rotation_angle
    if vertical:
        blk.angle -= 90
    if abs(blk.angle) < 3:
        blk.angle = 0
    blk.font_size = font_size
    blk.vec = primary_vec
    blk.norm = primary_norm
    if sort:
        blk.sort_lines()


def try_merge_textline(blk: TextBlock, blk2: TextBlock, fntsize_tol=1.7, distance_tol=2, canvas=None) -> bool:
    if blk2.merged:
        return False
    fntsize_div = blk.font_size / blk2.font_size
    num_l1, num_l2 = len(blk), len(blk2)
    fntsz_avg = (blk.font_size * num_l1 + blk2.font_size * num_l2) / (num_l1 + num_l2)
    vec_prod = blk.vec @ blk2.vec
    vec_sum = blk.vec + blk2.vec
    cos_vec = vec_prod / blk.norm / blk2.norm
    minrect1 = blk.min_rect(ids=[-1])[0]
    xyxy1 = [*minrect1[0], *minrect1[2]]
    minrect2 = blk2.min_rect(ids=[0])[0]
    xyxy2 = [*minrect2[0], *minrect2[2]]
    distance_x = max(xyxy1[0], xyxy2[0]) - min(xyxy1[2], xyxy2[2])
    distance_y = max(xyxy1[1], xyxy2[1]) - min(xyxy1[3], xyxy2[3])
    w1 = xyxy1[2] - xyxy1[0]
    w2 = xyxy2[2] - xyxy2[0]
    h1 = xyxy1[3] - xyxy1[1]
    h2 = xyxy2[3] - xyxy2[1]

    l1 = Polygon(blk.lines[-1])
    l2 = Polygon(blk2.lines[0])
    if not l1.intersects(l2):
        if blk.vertical:
            if distance_y > 0:
                return False
            if distance_x > fntsz_avg * 0.8:
                return False
            if abs(distance_y) / min(h1, h2) < 0.4:
                return False
        else:
            if distance_x > 0:
                return False
            fntsz_thr = 0.5
            if fntsz_avg < 24:
                fntsz_thr = 0.6
            if distance_y > fntsz_avg * fntsz_thr:
                return False
            if abs(distance_x) / min(w1, w2) < 0.3:
                return False
        if fntsize_div > fntsize_tol or 1 / fntsize_div > fntsize_tol:
            return False
        if abs(cos_vec) < 0.866:  # cos30
            return False

    for line in blk2.lines:
        blk.lines.append(line)
    blk.vec = vec_sum
    blk.angle = int(round(np.rad2deg(math.atan2(vec_sum[1], vec_sum[0]))))
    if blk.vertical:
        blk.angle -= 90
    blk.norm = np.linalg.norm(vec_sum)
    blk.distance = np.append(blk.distance, blk2.distance[-1])
    blk.font_size = fntsz_avg
    blk2.merged = True
    return True


def merge_textlines(blk_list: List[TextBlock], canvas=None, fntsize_tol=1.7) -> List[TextBlock]:
    if len(blk_list) < 2:
        return blk_list
    merged_list = []
    for ii, current_blk in enumerate(blk_list):
        if current_blk.merged:
            continue
        for blk in blk_list[ii + 1:]:
            try_merge_textline(current_blk, blk, canvas=canvas, fntsize_tol=fntsize_tol)
        merged_list.append(current_blk)
    for blk in merged_list:
        blk.adjust_bbox(with_bbox=False)
    return merged_list


def sort_regions(regions: List[TextBlock], right_to_left=None) -> List[TextBlock]:
    """漫画阅读顺序:右→左、上→下(manga-image-translator 版)。"""
    nr = len(regions)
    if right_to_left is None and nr > 0:
        nv = 0
        for r in regions:
            if r.vertical:
                nv += 1
        right_to_left = nv / nr > 0

    sorted_regions = []
    for region in sorted(regions, key=lambda region: region.center()[1]):
        for i, sorted_region in enumerate(sorted_regions):
            if region.center()[1] > sorted_region.xyxy[3]:
                continue
            if region.center()[1] < sorted_region.xyxy[1]:
                sorted_regions.insert(i + 1, region)
                break
            if right_to_left and region.center()[0] > sorted_region.center()[0]:
                sorted_regions.insert(i, region)
                break
            if not right_to_left and region.center()[0] < sorted_region.center()[0]:
                sorted_regions.insert(i, region)
                break
        else:
            sorted_regions.append(region)
    return sorted_regions


def group_output(blks, lines, im_w, im_h, mask=None, sort_blklist=True, canvas=None) -> List[TextBlock]:
    blk_list: List[TextBlock] = []
    scattered_lines = {"ver": [], "hor": []}
    for bbox, cls, conf in zip(*blks):
        blk_list.append(TextBlock(bbox, language=LANG_LIST[cls]))

    # step1: 把文本行归入 yolo 检出的框
    bbox_score_thresh = 0.4
    mask_score_thresh = 0.1
    for line in lines:
        line, is_vertical = sort_pnts(line)
        bx1, bx2 = line[:, 0].min(), line[:, 0].max()
        by1, by2 = line[:, 1].min(), line[:, 1].max()
        bbox_score, bbox_idx = -1, -1
        line_area = (by2 - by1) * (bx2 - bx1)
        for jj, blk in enumerate(blk_list):
            score = union_area(blk.xyxy, [bx1, by1, bx2, by2]) / line_area
            if bbox_score < score:
                bbox_score = score
                bbox_idx = jj
        if bbox_score > bbox_score_thresh:
            blk_list[bbox_idx].lines.append(line)
            blk_list[bbox_idx].adjust_bbox(with_bbox=True)
        else:
            if mask is not None:
                mask_score = mask[by1: by2, bx1: bx2].mean() / 255
                if mask_score < mask_score_thresh:
                    continue
            blk = TextBlock([bx1, by1, bx2, by2], [line])
            blk.vertical = blk.src_is_vertical = is_vertical
            examine_textblk(blk, im_w, im_h, sort=False)
            if blk.vertical:
                scattered_lines["ver"].append(blk)
            else:
                scattered_lines["hor"].append(blk)

    # step2: 过滤空框、整理文本行
    final_blk_list = []
    for blk in blk_list:
        if len(blk.lines) == 0:
            bx1, by1, bx2, by2 = blk.xyxy
            if mask is not None:
                mask_score = mask[by1: by2, bx1: bx2].mean() / 255
                if mask_score < mask_score_thresh:
                    continue
            xywh = np.array([[bx1, by1, bx2 - bx1, by2 - by1]])
            blk.lines = xywh2xyxypoly(xywh).reshape(-1, 4, 2).tolist()
        else:
            blk.adjust_bbox(with_bbox=False)
        examine_textblk(blk, im_w, im_h, sort=True)
        final_blk_list.append(blk)

    _final_blk_list = []
    for blk in final_blk_list:
        if blk.vertical:
            scattered_lines["ver"].append(blk)
        else:
            _final_blk_list.append(blk)
    final_blk_list = _final_blk_list

    # step3: 散行合并 + 网格排序
    scattered_lines["ver"].sort(key=lambda blk: blk.center()[0], reverse=True)
    scattered_lines["hor"].sort(key=lambda blk: blk.center()[1])
    final_blk_list += merge_textlines(scattered_lines["hor"], canvas=canvas, fntsize_tol=2.0)
    final_blk_list += merge_textlines(scattered_lines["ver"])
    if sort_blklist:
        final_blk_list = sort_regions(final_blk_list)
    return final_blk_list


def collect_textblock_regions(
    img: np.ndarray,
    textblk_lst: List[TextBlock],
    text_height=48,
    maxwidth=8100,
    split_textblk=False,
    seg_func: Callable = None,
):
    """OCR 区域准备(仅非拆分行路径;split_textblk 恒为 False)。"""
    regions = []
    textblk_lst_indices = []
    for blk_idx, textblk in enumerate(textblk_lst):
        for ii in range(len(textblk)):
            textblk_lst_indices.append(blk_idx)
            region = textblk.get_transformed_region(img, ii, text_height, maxwidth=maxwidth)
            regions.append(region)
    return regions, textblk_lst_indices
