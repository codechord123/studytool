"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Point,
  Shape,
  cloneShapes,
  detectShapeKind,
  flipPoints,
  makeCircle,
  makeCross,
  makeHexagon,
  makeLShape,
  makeParallelogram,
  makeRectangle,
  makeRhombus,
  makeRightTriangle,
  makeTrapezoid,
  makeTriangle,
  mergePolygons,
  polygonArea,
  polygonCentroid,
  pointInPolygon,
  reconstructDefShape,
  rotatePoints,
  scalePoints,
  splitPolygonByLine,
  translatePoints,
  uid,
} from "@/lib/geometry";

type Tool = "draw" | "select" | "cut" | "delete" | "merge" | "measure" | "guide" | "text";
type TextNote = { id: string; x: number; y: number; text: string; color: string; scale?: number };

// 1cm = 80 world px. 카메라(scale)로 화면 크기를 자유 조절한다.
const GRID = 80;
const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
const HISTORY_LIMIT = 50;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 길이/넓이 표기 (정수 ≒ → 정수, 반정수 ≒ → x.5, 그 외 → 약 X)
function fmtLen(cm: number): string {
  const r = Math.round(cm);
  if (Math.abs(cm - r) < 0.05) return `${r}cm`;
  const h = Math.round(cm * 2) / 2;
  if (Math.abs(cm - h) < 0.05) return `${h}cm`;
  // 대각선처럼 무리수 길이 → 소수 첫째자리로 정확히 표기 ('약 6cm' 대신 '약 5.7cm')
  return `약 ${cm.toFixed(1)}cm`;
}
function fmtArea(cm2: number): string {
  const r = Math.round(cm2);
  if (Math.abs(cm2 - r) < 0.05) return `${r}cm²`;
  const h = Math.round(cm2 * 2) / 2;
  if (Math.abs(cm2 - h) < 0.05) return `${h}cm²`;
  return `약 ${cm2.toFixed(1)}cm²`;
}
// 넓이가 딱 떨어지는지(정수 또는 반정수) 판정
function isAreaNice(cm2: number): boolean {
  return Math.abs(cm2 * 2 - Math.round(cm2 * 2)) < 0.03;
}
// 🎯 슈퍼 알파(딱맞춤) 알고리즘 — 초등 학습 우선순위:
//   1순위) 모든 꼭짓점을 격자 교차점(정수 cm) 위에 올림   → 칸을 셀 수 있게
//   2순위) 그 상태에서 넓이가 '정수'가 되도록 최소한으로 보정
// 원리: 꼭짓점이 모두 격자 위이면 (신발끈 공식상) 넓이는 항상 정수 또는 반정수.
//   반정수(x.5)면, 한 꼭짓점만 '반대편 격자선'으로 한 칸 옮겨 정수로 만든다(최소 이동).
// 이미 '격자 위 + 정수 넓이'면 null 반환.
function niceAreaSnap(points: Point[]): Point[] | null {
  const n = points.length;
  if (n < 3) return null;
  // 2 × 넓이(칸²) — 꼭짓점이 격자 위면 정수. 짝수면 넓이가 정수, 홀수면 반정수.
  const doubledCells = (pts: Point[]) => {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      d += (a.x / GRID) * (b.y / GRID) - (b.x / GRID) * (a.y / GRID);
    }
    return d;
  };
  const areaCells = (pts: Point[]) => Math.abs(doubledCells(pts)) / 2;
  const onGrid = (pts: Point[]) => pts.every((p) => Math.abs(p.x / GRID - Math.round(p.x / GRID)) < 1e-6 && Math.abs(p.y / GRID - Math.round(p.y / GRID)) < 1e-6);
  const isWhole = (pts: Point[]) => Math.abs(Math.round(doubledCells(pts)) % 2) < 1e-9;
  // 이미 격자 위 + 정수 넓이면 손대지 않음
  if (onGrid(points) && isWhole(points) && areaCells(points) > 0.4) return null;

  // 1) 모든 꼭짓점을 가장 가까운 격자 교차점으로
  const base = points.map((p) => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID }));
  if (areaCells(base) > 0.4 && isWhole(base)) return base; // 격자 위 + 넓이 정수 → 완료

  // 2) 반정수(x.5) → 한 꼭짓점을 '원래 위치의 반대편 격자선'으로 한 칸 옮겨 정수 넓이로.
  //    여러 후보 중 원래 위치에서 가장 덜 벗어나는(최소 이동) 것을 선택.
  let best: Point[] | null = null;
  let bestErr = Infinity;
  const axes: ("x" | "y")[] = ["x", "y"];
  for (let i = 0; i < n; i++) {
    for (const ax of axes) {
      const alt = base.map((p) => ({ ...p }));
      const cur = base[i][ax];
      const orig = points[i][ax];
      alt[i][ax] = cur + (orig >= cur ? GRID : -GRID); // 원래 좌표 기준 두 번째로 가까운 격자선
      if (areaCells(alt) > 0.4 && isWhole(alt)) {
        const err = Math.hypot(alt[i].x - points[i].x, alt[i].y - points[i].y);
        if (err < bestErr) { bestErr = err; best = alt; }
      }
    }
  }
  if (best) return best;
  // 3) 정수 해를 못 찾으면 격자 스냅(반정수 넓이)이라도 반환
  return areaCells(base) > 0.4 ? base : null;
}

// 🎓 학습모드: 꼭짓점 vi를 주변(±2칸) 격자점 중 '인접 두 변이 모두 정수 cm'가
//   되는 곳으로 스냅. 예) 밑변 16 삼각형의 꼭대기가 높이 14 근처면 → 높이 15로
//   옮겨 17·17·16 (피타고라스 수) 완성. 그런 곳이 없으면 null(변화 없음).
function learnSnapVertex(pts: Point[], vi: number): Point[] | null {
  const n = pts.length;
  if (n < 3 || n >= 20) return null;
  const P = pts[(vi - 1 + n) % n];
  const N = pts[(vi + 1) % n];
  const V = pts[vi];
  const near = (v: number) => Math.abs(v - Math.round(v)) < 0.02;
  const vx0 = Math.round(V.x / GRID);
  const vy0 = Math.round(V.y / GRID);
  let best: Point | null = null;
  let bestD = Infinity;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const c = { x: (vx0 + dx) * GRID, y: (vy0 + dy) * GRID };
      const l1 = Math.hypot(c.x - P.x, c.y - P.y) / GRID;
      const l2 = Math.hypot(c.x - N.x, c.y - N.y) / GRID;
      if (l1 < 0.9 || l2 < 0.9) continue;
      if (!near(l1) || !near(l2)) continue; // 두 변 모두 정수일 때만 후보
      const d = Math.hypot(c.x - V.x, c.y - V.y);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  if (!best) return null;
  if (Math.abs(best.x - V.x) < 1e-6 && Math.abs(best.y - V.y) < 1e-6) return null; // 이미 그 자리
  const out = pts.map((q, i) => (i === vi ? best! : q));
  if (Math.abs(polygonArea(out)) < GRID * GRID * 0.4) return null; // 찌그러지면 취소
  return out;
}
// 🎓 학습모드: 삼각형의 세 변이 모두 정수 cm가 되도록 꼭짓점 하나를 보정 (가능할 때만)
function learnRefineTriangle(pts: Point[]): Point[] | null {
  if (pts.length !== 3) return null;
  const isInt = (v: number) => Math.abs(v - Math.round(v)) < 0.02;
  const sideLens = (q: Point[]) => q.map((p, i) => Math.hypot(q[(i + 1) % 3].x - p.x, q[(i + 1) % 3].y - p.y) / GRID);
  if (sideLens(pts).every(isInt)) return null; // 이미 모두 정수
  for (let vi = 0; vi < 3; vi++) {
    const r = learnSnapVertex(pts, vi);
    if (r && sideLens(r).every(isInt)) return r;
  }
  return null;
}

// 한 변의 '표시 길이'(라벨에 보이는 값)를 소수 첫째자리 단위 수치로 반환
function niceLenCm(cm: number): number {
  const r = Math.round(cm);
  if (Math.abs(cm - r) < 0.05) return r;
  const h = Math.round(cm * 2) / 2;
  if (Math.abs(cm - h) < 0.05) return h;
  // 어림값은 소수 첫째자리 (예: 5.66 → 5.7)
  return Math.round(cm * 10) / 10;
}
// 둘레 = 화면에 보이는 각 변 라벨의 합 (아이가 변을 더한 값과 일치, 깔끔한 수)
function displayPerimeterCm(points: Point[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sum += niceLenCm(Math.hypot(b.x - a.x, b.y - a.y) / GRID);
  }
  return sum;
}

type Camera = { scale: number; tx: number; ty: number };
type Measurement = { id: string; a: Point; b: Point };
type Guide = { id: string; a: Point; b: Point };
type Segment = Measurement; // {id,a,b} 공통 구조
type ActiveAux = { kind: "guide" | "measure"; id: string } | null;

// 되돌리기 단위 — 도형뿐 아니라 측정선·가이드까지 함께 스냅샷
type Snapshot = { shapes: Shape[]; measurements: Measurement[]; guides: Guide[]; texts: TextNote[] };
function cloneSegs<T extends Segment>(arr: T[]): T[] {
  return arr.map((m) => ({ ...m, a: { ...m.a }, b: { ...m.b } }));
}

type DragMode =
  | { type: "none" }
  | { type: "pan"; sx: number; sy: number; startCam: Camera; moved?: boolean; maybeDeselect?: boolean }
  | {
      type: "translate";
      shapeId: string;
      startPointer: Point;
      startPoints: Point[];
      startGhosts?: Point[][];
      group?: { id: string; startPoints: Point[]; startGhosts?: Point[][] }[];
    }
  | { type: "vertex"; shapeId: string; vertexIndex: number; startCenter?: Point; startPoints?: Point[] }
  | {
      type: "rotate";
      shapeId: string;
      center: Point;
      startAngle: number;
      startPoints: Point[];
      startGhosts?: Point[][];
    }
  | { type: "cut"; start: Point; current: Point }
  | { type: "measure"; start: Point; current: Point }
  | { type: "guide"; start: Point; current: Point }
  // 가이드/측정선 편집
  | { type: "auxEnd"; kind: "guide" | "measure"; id: string; end: "a" | "b" }
  | { type: "auxMove"; kind: "guide" | "measure"; id: string; startA: Point; startB: Point; startPointer: Point }
  | { type: "textMove"; id: string; startPointer: Point; startX: number; startY: number; downSX: number; downSY: number; wasActive: boolean }
  | { type: "textResize"; id: string; startPointer: Point; startScale: number; startW: number; startH: number }
  | { type: "circleResize"; shapeId: string; center: Point };

// 점 p에서 선분 a-b까지의 최단 거리
function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// 축에 평행한 직사각형이면 {x,y,w,h}(월드px) 반환, 아니면 null — 격자 칸 시각화용
function axisAlignedRect(pts: Point[]): { x: number; y: number; w: number; h: number } | null {
  if (pts.length !== 4) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 1 || h < 1) return null;
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  for (const p of pts) {
    if (!corners.some((c) => Math.abs(c.x - p.x) < 0.5 && Math.abs(c.y - p.y) < 0.5)) return null;
  }
  return { x: minX, y: minY, w, h };
}

// 축에 평행한 직각 다각형(ㄴ자·십자·직사각형)의 내부 단위 칸 목록을 반환. 아니면 null.
// 칸은 도형의 좌상단 모서리 기준으로 정렬하므로, 도형이 절대 격자선과 어긋나 있어도(반-칸 이동 등) 동작한다.
function gridCells(pts: Point[]): { x: number; y: number }[] | null {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) return null; // 대각선 변 → 제외
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cols = Math.round((maxX - minX) / GRID);
  const rows = Math.round((maxY - minY) / GRID);
  if (cols < 1 || rows < 1 || cols * rows > 800) return null;
  // 가로/세로가 정수 칸 수여야 함 (모서리 기준 정렬이므로 절대 위치는 무관)
  if (Math.abs(maxX - minX - cols * GRID) > 0.1 * GRID) return null;
  if (Math.abs(maxY - minY - rows * GRID) > 0.1 * GRID) return null;
  const cells: { x: number; y: number }[] = [];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const c = { x: minX + (i + 0.5) * GRID, y: minY + (j + 0.5) * GRID };
      if (pointInPolygon(c, pts)) cells.push({ x: minX + i * GRID, y: minY + j * GRID });
    }
  return cells.length ? cells : null;
}

// 각 꼭짓점의 내각(도) — 오목(reflex) 꼭짓점은 180°보다 큼. 합은 (n-2)×180°.
function interiorAnglesDeg(pts: Point[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area2 += a.x * b.y - b.x * a.y;
  }
  const ccw = area2 > 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
    const v2x = next.x - cur.x, v2y = next.y - cur.y;
    const th = Math.atan2(Math.abs(v1x * v2y - v1y * v2x), v1x * v2x + v1y * v2y); // 0..π
    let deg = (th * 180) / Math.PI;
    const crossEdge = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    const reflex = ccw ? crossEdge < 0 : crossEdge > 0;
    if (reflex) deg = 360 - deg;
    out.push(deg);
  }
  return out;
}

// 칸세기 모드: 어떤 다각형이든 모눈 칸을 '꽉 찬 칸'과 '걸친 칸'으로 분류 (넓이 어림용)
function gridCountCells(pts: Point[]): { full: Point[]; partial: Point[] } | null {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const i0 = Math.floor(minX / GRID);
  const i1 = Math.ceil(maxX / GRID);
  const j0 = Math.floor(minY / GRID);
  const j1 = Math.ceil(maxY / GRID);
  if ((i1 - i0) * (j1 - j0) > 2000) return null; // 너무 큰 도형은 생략
  const eps = GRID * 0.06;
  const full: Point[] = [];
  const partial: Point[] = [];
  for (let i = i0; i < i1; i++)
    for (let j = j0; j < j1; j++) {
      const x = i * GRID;
      const y = j * GRID;
      const samples: [number, number][] = [
        [x + eps, y + eps],
        [x + GRID - eps, y + eps],
        [x + GRID - eps, y + GRID - eps],
        [x + eps, y + GRID - eps],
        [x + GRID / 2, y + GRID / 2],
      ];
      let inside = 0;
      for (const [sx, sy] of samples) if (pointInPolygon({ x: sx, y: sy }, pts)) inside++;
      if (inside === 5) full.push({ x, y });
      else if (inside > 0) partial.push({ x, y });
    }
  return full.length || partial.length ? { full, partial } : null;
}

function boundsOf(pts: Point[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// 이동 중 다른 도형의 모서리/중심에 정렬(스마트 가이드). dx,dy=보정량, vx/hy=정렬선 좌표
function alignSnap(pts: Point[], all: Shape[], excludeId: string, tol: number) {
  const me = boundsOf(pts);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of all) {
    if (s.id === excludeId) continue;
    const b = boundsOf(s.points);
    xs.push(b.minX, b.cx, b.maxX);
    ys.push(b.minY, b.cy, b.maxY);
  }
  const mX = [me.minX, me.cx, me.maxX];
  const mY = [me.minY, me.cy, me.maxY];
  let dx = 0;
  let bestX = tol;
  for (const a of mX) for (const t of xs) {
    const d = Math.abs(t - a);
    if (d < bestX) {
      bestX = d;
      dx = t - a;
    }
  }
  let dy = 0;
  let bestY = tol;
  for (const a of mY) for (const t of ys) {
    const d = Math.abs(t - a);
    if (d < bestY) {
      bestY = d;
      dy = t - a;
    }
  }
  const vx = new Set<number>();
  const hy = new Set<number>();
  for (const t of xs) for (const a of mX) if (Math.abs(a + dx - t) < 0.5) vx.add(t);
  for (const t of ys) for (const a of mY) if (Math.abs(a + dy - t) < 0.5) hy.add(t);
  return { dx, dy, vx: Array.from(vx), hy: Array.from(hy) };
}

function placeAtCenter(pts: Point[], cx: number, cy: number): Point[] {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const mx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const my = (Math.max(...ys) + Math.min(...ys)) / 2;
  return pts.map((p) => ({ x: p.x - mx + cx, y: p.y - my + cy }));
}

type Preset = { id: string; label: string; formula: string; build: () => Point[]; defKind?: Shape["defKind"] };

// 정n각형 (꼭짓점이 위를 향하도록, 외접원 반지름 R)
function makeRegular(n: number, R: number): Point[] {
  const pts: Point[] = [];
  const start = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = start + (i * 2 * Math.PI) / n;
    pts.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
  }
  return pts;
}
// 한 변 길이를 '정수 cm(sideUnits칸)'로 딱 떨어지게 만드는 정n각형 → 변 라벨이 '약' 없이 정확
function makeRegularSide(n: number, sideUnits: number): Point[] {
  const R = (sideUnits * GRID) / (2 * Math.sin(Math.PI / n));
  return makeRegular(n, R);
}

// 꼭짓점을 옮길 때 '정각(15°배수)·정수 변길이'에 자동으로 딱 맞춰주는 스냅.
// P·N = 옮기는 꼭짓점의 두 이웃(고정). 맞을 게 없으면 null.
function snapVertexNice(raw: Point, P: Point, N: Point, tolWorld: number): Point | null {
  const STEP = Math.PI / 12; // 15°
  const TOLA = (Math.PI / 180) * 8; // 변 방향 허용오차
  const angDiff = (a: number, b: number) => {
    let d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const dP = Math.atan2(raw.y - P.y, raw.x - P.x);
  const dN = Math.atan2(raw.y - N.y, raw.x - N.x);
  const sP = Math.round(dP / STEP) * STEP;
  const sN = Math.round(dN / STEP) * STEP;
  const okP = angDiff(dP, sP) < TOLA;
  const okN = angDiff(dN, sN) < TOLA;
  // 1) 두 변 방향이 모두 예쁜 각 → 두 반직선의 교점(꼭짓점 내각·양쪽 각이 모두 깔끔)
  if (okP && okN) {
    const c1 = Math.cos(sP), s1 = Math.sin(sP), c2 = Math.cos(sN), s2 = Math.sin(sN);
    const den = c1 * s2 - s1 * c2;
    if (Math.abs(den) > 1e-6) {
      const t = ((N.x - P.x) * s2 - (N.y - P.y) * c2) / den;
      const I = { x: P.x + t * c1, y: P.y + t * s1 };
      if (Math.hypot(I.x - raw.x, I.y - raw.y) < tolWorld * 2.2) return I;
    }
  }
  // 2) 한 변만 예쁜 방향 → 그 방향 위에 두고, 길이는 정수 칸에 가까우면 스냅
  const single = (pivot: Point, dir: number, ok: boolean): Point | null => {
    if (!ok) return null;
    let len = Math.hypot(raw.x - pivot.x, raw.y - pivot.y);
    const gi = Math.round(len / GRID) * GRID;
    if (Math.abs(len - gi) < tolWorld) len = gi;
    return { x: pivot.x + len * Math.cos(dir), y: pivot.y + len * Math.sin(dir) };
  };
  const cP = single(P, sP, okP);
  const cN = single(N, sN, okN);
  const dist = (p: Point | null) => (p ? Math.hypot(p.x - raw.x, p.y - raw.y) : Infinity);
  if (cP && dist(cP) <= dist(cN)) return cP;
  if (cN) return cN;
  // 3) 두 이웃 모두에게 정수 cm 거리(그리고 격자 위)인 자리를 탐색 → 마름모·정삼각형 등 만들 때 유용
  //    포인터 주변 반칸 격자에서 두 거리가 모두 반정수(0.5cm 단위)에 아주 가까운 자리를 고름.
  const HALF = GRID / 2;
  const cxg = Math.round(raw.x / HALF) * HALF;
  const cyg = Math.round(raw.y / HALF) * HALF;
  const R = 3; // ±3 * 반칸 = ±1.5cm 반경 검색
  let best: { p: Point; score: number } | null = null;
  const isNice = (len: number) => {
    const halfN = Math.round(len / HALF);
    return { ok: Math.abs(len - halfN * HALF) < 0.05 * GRID, err: Math.abs(len - halfN * HALF) };
  };
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      const q = { x: cxg + dx * HALF, y: cyg + dy * HALF };
      const lP = Math.hypot(q.x - P.x, q.y - P.y);
      const lN = Math.hypot(q.x - N.x, q.y - N.y);
      const aP = isNice(lP);
      const aN = isNice(lN);
      if (!aP.ok || !aN.ok) continue;
      const pull = Math.hypot(q.x - raw.x, q.y - raw.y);
      if (pull > tolWorld * 2) continue;
      const score = pull + (aP.err + aN.err) * 20;
      if (!best || score < best.score) best = { p: q, score };
    }
  }
  return best ? best.p : null;
}

const PRESETS: Preset[] = [
  { id: "square", label: "정사각형", formula: "한 변 × 한 변", build: () => makeRectangle(0, 0, 4 * GRID, 4 * GRID) },
  { id: "rect", label: "직사각형", formula: "가로 × 세로", build: () => makeRectangle(0, 0, 8 * GRID, 4 * GRID) },
  { id: "rtri", label: "직각삼각형", formula: "밑변 × 높이 ÷ 2", build: () => makeRightTriangle(0, 0, 6 * GRID, 4 * GRID) },
  { id: "tri", label: "삼각형", formula: "밑변 × 높이 ÷ 2", build: () => makeTriangle(0, 0, 6 * GRID, 4 * GRID) },
  { id: "para", label: "평행사변형", formula: "밑변 × 높이", build: () => makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID) },
  { id: "trap", label: "사다리꼴", formula: "(윗변 + 아랫변) × 높이 ÷ 2", build: () => makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID) },
  { id: "rhom", label: "마름모", formula: "대각선 × 대각선 ÷ 2", build: () => makeRhombus(0, 0, 8 * GRID, 6 * GRID), defKind: "rhombus" },
  { id: "circle", label: "원", formula: "반지름 × 반지름 × π", build: () => makeCircle(0, 0, 3 * GRID), defKind: { circle: 3 } },
  { id: "reg3", label: "정삼각형", formula: "밑변 × 높이 ÷ 2", build: () => makeRegularSide(3, 6), defKind: { regular: 3 } },
  { id: "reg5", label: "정오각형", formula: "삼각형 5개로 나누기", build: () => makeRegularSide(5, 4), defKind: { regular: 5 } },
  { id: "hex", label: "정육각형", formula: "삼각형 6개로 나누기", build: () => makeHexagon(0, 0, 3 * GRID), defKind: { regular: 6 } },
  { id: "reg8", label: "정팔각형", formula: "삼각형 8개로 나누기", build: () => makeRegularSide(8, 3), defKind: { regular: 8 } },
  // 정10·정12각형은 초등 5-6학년 커리큘럼 밖 → 인지 부담 완화 위해 제거
  { id: "lshape", label: "ㄴ자 모양", formula: "두 직사각형 합", build: () => makeLShape(0, 0, 6 * GRID, 4 * GRID, 2 * GRID, 2 * GRID) },
  { id: "cross", label: "십자 모양", formula: "정사각형 5개", build: () => makeCross(0, 0, 2 * GRID, 2 * GRID) },
];

type Scenario = { label: string; hint: string; build: (cx: number, cy: number) => Shape[] };
type ScenarioGroup = { shape: string; formula: string; scenarios: Scenario[] };

function S(color: string, pts: Point[]): Shape {
  return { id: uid(), color, points: pts };
}

const SCENARIO_GROUPS: ScenarioGroup[] = [
  {
    shape: "🔷 사다리꼴의 넓이",
    formula: "(윗변 + 아랫변) × 높이 ÷ 2",
    scenarios: [
      {
        label: "① 같은 사다리꼴 두 개 → 평행사변형",
        hint: "똑같은 사다리꼴 두 개 중 하나를 180° 돌려서 옆에 붙여 보세요. 평행사변형(밑변=윗변+아랫변, 높이는 그대로)이 돼요. ➜ 사다리꼴 넓이 = (윗변+아랫변)×높이÷2",
        build: (cx, cy) => [
          S(COLORS[0], placeAtCenter(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), cx - 5 * GRID, cy)),
          S(COLORS[1], placeAtCenter(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), cx + 5 * GRID, cy)),
        ],
      },
      {
        label: "② 가운데에서 잘라 → 직사각형",
        hint: "사다리꼴을 ‘높이의 절반(중간선)’ 위치에서 가로로 잘라 보세요. 위쪽 조각을 좌우로 뒤집어 옆에 붙이면 직사각형이 돼요. 가로 = (윗변+아랫변)÷2, 세로 = 높이. ➜ 같은 공식이 나와요!",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), cx, cy))],
      },
      {
        label: "③ 대각선으로 잘라 → 두 개의 삼각형",
        hint: "사다리꼴에 대각선을 그어 잘라 보면 두 개의 삼각형이 나와요. 각 삼각형의 넓이는 ‘밑변×높이÷2’. 두 삼각형 넓이의 합 = (윗변+아랫변)×높이÷2",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), cx, cy))],
      },
      {
        label: "④ 직사각형 + 삼각형들로 나누기",
        hint: "윗변 양 끝에서 아래로 수직선을 그어 자르면, 가운데 직사각형 + 양쪽 직각삼각형이 돼요. 각 부분의 넓이를 따로 구해서 더해 봐요.",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), cx, cy))],
      },
    ],
  },
  {
    shape: "🔶 평행사변형의 넓이",
    formula: "밑변 × 높이",
    scenarios: [
      {
        label: "① 끝을 잘라 옮기기 → 직사각형",
        hint: "평행사변형의 한쪽 끝에서 수직으로 잘라 잘린 직각삼각형을 반대편으로 옮겨 붙여 보세요. ‘🔗 합치기’로 합치면 직사각형이 돼요. ➜ 평행사변형 넓이 = 밑변 × 높이",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID), cx, cy))],
      },
      {
        label: "② 대각선으로 잘라 → 두 개의 합동 삼각형",
        hint: "대각선으로 한 번 자르면 똑같은 삼각형 두 개가 나와요. 한 삼각형의 넓이는 평행사변형의 절반: 밑변×높이÷2",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID), cx, cy))],
      },
    ],
  },
  {
    shape: "🔺 삼각형의 넓이",
    formula: "밑변 × 높이 ÷ 2",
    scenarios: [
      {
        label: "① 직각삼각형 두 개 → 직사각형",
        hint: "똑같은 직각삼각형 두 개 중 하나를 180° 돌려서 빗변끼리 맞붙이면 직사각형이 돼요. 두 개로 직사각형이 되니까 한 개는 그 절반!",
        build: (cx, cy) => [
          S(COLORS[0], placeAtCenter(makeRightTriangle(0, 0, 6 * GRID, 4 * GRID), cx - 4 * GRID, cy)),
          S(COLORS[1], placeAtCenter(makeRightTriangle(0, 0, 6 * GRID, 4 * GRID), cx + 4 * GRID, cy)),
        ],
      },
      {
        label: "② 일반 삼각형 두 개 → 평행사변형",
        hint: "직각이 아닌 삼각형도 똑같이! 한 개를 180° 돌려 한 변을 맞붙이면 평행사변형이 만들어져요. 그 절반이 삼각형의 넓이.",
        build: (cx, cy) => [
          S(COLORS[0], placeAtCenter(makeTriangle(0, 0, 6 * GRID, 4 * GRID), cx - 4 * GRID, cy)),
          S(COLORS[1], placeAtCenter(makeTriangle(0, 0, 6 * GRID, 4 * GRID), cx + 4 * GRID, cy)),
        ],
      },
    ],
  },
  {
    shape: "💎 마름모의 넓이",
    formula: "한 대각선 × 다른 대각선 ÷ 2",
    scenarios: [
      {
        label: "① 두 대각선으로 잘라 → 4개의 직각삼각형",
        hint: "마름모의 두 대각선을 따라 자르면 똑같은 직각삼각형 4개가 나와요. 이들을 다시 배치하면 가로=대각선1, 세로=대각선2÷2인 직사각형이 돼요.",
        build: (cx, cy) => [S(COLORS[2], placeAtCenter(makeRhombus(0, 0, 6 * GRID, 4 * GRID), cx, cy))],
      },
      {
        label: "② 마름모를 둘러싼 직사각형",
        hint: "두 대각선 길이를 가로·세로로 하는 직사각형 안에 마름모가 딱 들어가요. 마름모는 그 직사각형의 절반!",
        build: (cx, cy) => [
          S(COLORS[2], placeAtCenter(makeRhombus(0, 0, 6 * GRID, 4 * GRID), cx, cy)),
          S(COLORS[3], placeAtCenter(makeRectangle(0, 0, 6 * GRID, 4 * GRID), cx, cy)),
        ],
      },
    ],
  },
  {
    shape: "▭ 직사각형의 넓이",
    formula: "가로 × 세로",
    scenarios: [
      {
        label: "① 격자 칸 세어 보기",
        hint: "직사각형 안에 모눈 칸이 몇 개 들어가는지 세어 보세요. ‘가로 칸 수 × 세로 칸 수’가 칸의 개수, 즉 넓이(cm²)예요.",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeRectangle(0, 0, 6 * GRID, 4 * GRID), cx, cy))],
      },
      {
        label: "② 대각선으로 잘라 → 직각삼각형 두 개",
        hint: "직사각형을 대각선으로 자르면 똑같은 직각삼각형 두 개가 돼요. 그래서 직각삼각형의 넓이는 ‘가로×세로÷2’.",
        build: (cx, cy) => [S(COLORS[0], placeAtCenter(makeRectangle(0, 0, 6 * GRID, 4 * GRID), cx, cy))],
      },
    ],
  },
];

// ===== 탐구(조작) 레슨 — 아이가 직접 조작해 공식을 유도 =====
type FillBlank = { parts: string[]; answers: string[]; options: string[] }; // parts.length === answers.length + 1
type Challenge = { question: string; answer: number; unit: string; solution: string; tolerance?: number };
type LessonStep = {
  prompt?: string;
  hint?: string;
  tool?: Tool;
  manual?: boolean; // 자동 감지 불가(관찰형) → '다음' 버튼
  final?: boolean; // 공식 공개 단계
  done?: (shapes: Shape[]) => boolean; // 목표 상태 감지(작업 도형만, reference 제외)
  success?: string;
  fill?: FillBlank; // 빈칸 채우기 정리
  challenge?: Challenge; // 적용 챌린지(자동 채점)
};
type Lesson = {
  id: string;
  title: string;
  formula: string;
  // working: 아이가 조작하는 도형 / reference: 비교용 박제(읽기 전용 점선)
  build: (cx: number, cy: number) => { working: Shape[]; reference: Shape[] };
  steps: LessonStep[];
};

// 의미 라벨 (각 도형 빌더의 점 순서에 맞춰 부여)
const TRAP_LABELS = ["윗변", "오른쪽 빗변", "아랫변", "왼쪽 빗변"];
const PARA_LABELS = ["윗변", "오른쪽 변", "아랫변", "왼쪽 변"];
const TRI_LABELS = ["밑변", "오른쪽 변", "왼쪽 변"];
const RTRI_LABELS = ["밑변", "빗변", "높이"];
const RECT_LABELS = ["윗변(가로)", "오른쪽(세로)", "아랫변(가로)", "왼쪽(세로)"];

function withLabels(color: string, pts: Point[], labels: string[]): Shape {
  return { id: uid(), color, points: pts, edgeLabels: labels };
}
function asReference(s: Shape): Shape {
  return { ...s, id: uid(), isReference: true };
}

const LESSONS: Lesson[] = [
  {
    id: "trapezoid",
    title: "사다리꼴 → 평행사변형",
    formula: "(윗변 + 아랫변) × 높이 ÷ 2",
    build: (cx, cy) => {
      const top = 2 * GRID,
        bot = 6 * GRID,
        h = 4 * GRID;
      const w1 = withLabels(COLORS[3], placeAtCenter(makeTrapezoid(0, 0, top, bot, h), cx - 4.5 * GRID, cy + 0.5 * GRID), TRAP_LABELS);
      const w2 = withLabels(COLORS[1], placeAtCenter(makeTrapezoid(0, 0, top, bot, h), cx + 4.5 * GRID, cy + 0.5 * GRID), TRAP_LABELS);
      const ref = asReference(withLabels(COLORS[3], placeAtCenter(makeTrapezoid(0, 0, top, bot, h), cx, cy - 6 * GRID), TRAP_LABELS));
      return { working: [w1, w2], reference: [ref] };
    },
    steps: [
      {
        prompt:
          "🎯 똑같은 사다리꼴 두 개로 '평행사변형'을 만들어 보세요! 한 도형을 선택해 ↷180° 로 돌린 뒤, 빗변끼리 맞붙이고 🔗 합치기를 누르세요.",
        hint: "기울어진 변(빗변)끼리 정확히 맞붙여야 합쳐져요. 🧲 자석을 켜고 천천히 가까이 가져가 보세요!",
        tool: "select",
        done: (shapes) =>
          shapes.length === 1 &&
          detectShapeKind(shapes[0].points).name === "평행사변형" &&
          Math.abs(polygonArea(shapes[0].points) / (GRID * GRID) - 32) < 1.5,
        success: "🎉 평행사변형! 밑변에 '윗변 + 아랫변'이라고 보여요? 두 라벨이 합쳐졌어요!",
      },
      {
        prompt:
          "📏 평행사변형 넓이 = 밑변 × 높이 = (윗변 + 아랫변) × 높이. 그런데 이건 똑같은 사다리꼴 '두 개'로 만든 거예요. 위에 점선의 원본과 비교해 봐요!",
        manual: true,
      },
      {
        fill: {
          parts: ["똑같은 사다리꼴 ", "개를 붙이면 ", "이 돼요. 그 넓이는 (윗변 + 아랫변) × ", " 이고, 사다리꼴은 그 ", " 이에요."],
          answers: ["2", "평행사변형", "높이", "절반"],
          options: ["2", "3", "평행사변형", "삼각형", "높이", "둘레", "절반", "두 배"],
        },
      },
      {
        challenge: {
          question: "윗변 3cm, 아랫변 7cm, 높이 4cm인 사다리꼴의 넓이는?",
          answer: 20,
          unit: "cm²",
          solution: "(3 + 7) × 4 ÷ 2 = 20",
        },
      },
      {
        prompt: "💡 그러니까 사다리꼴 한 개의 넓이 = (윗변 + 아랫변) × 높이 ÷ 2 — 직접 만들어 알아냈어요!",
        manual: true,
        final: true,
      },
    ],
  },
  {
    id: "triangle",
    title: "삼각형 → 평행사변형",
    formula: "밑변 × 높이 ÷ 2",
    build: (cx, cy) => {
      const W = 6 * GRID,
        H = 4 * GRID;
      const w1 = withLabels(COLORS[2], placeAtCenter(makeTriangle(0, 0, W, H), cx - 4 * GRID, cy + 0.5 * GRID), TRI_LABELS);
      const w2 = withLabels(COLORS[0], placeAtCenter(makeTriangle(0, 0, W, H), cx + 4 * GRID, cy + 0.5 * GRID), TRI_LABELS);
      const ref = asReference(withLabels(COLORS[2], placeAtCenter(makeTriangle(0, 0, W, H), cx, cy - 6 * GRID), TRI_LABELS));
      return { working: [w1, w2], reference: [ref] };
    },
    steps: [
      {
        prompt: "🎯 똑같은 삼각형 두 개로 '평행사변형'을 만들어 보세요! 한 개를 ↷180° 돌려 한 변을 맞붙이고 🔗 합치기.",
        hint: "어느 변에 붙여도 돼요! 한 변이 완전히 겹쳐야 해요. 🧲 자석을 켜면 정확해져요.",
        tool: "select",
        done: (shapes) => {
          if (shapes.length !== 1) return false;
          const kind = detectShapeKind(shapes[0].points).name;
          if (!["평행사변형", "직사각형", "마름모"].includes(kind)) return false;
          return Math.abs(polygonArea(shapes[0].points) / (GRID * GRID) - 24) < 1.5;
        },
        success: "🎉 평행사변형이 됐어요! 두 삼각형으로 만든 거예요.",
      },
      {
        prompt: "📏 평행사변형 넓이 = 밑변 × 높이. 이건 똑같은 삼각형 '두 개'로 만든 거예요. 위 원본과 같은 모양·크기죠?",
        manual: true,
      },
      {
        fill: {
          parts: ["똑같은 삼각형 ", "개를 붙이면 ", "이 돼요. 그 넓이는 밑변 × ", " 이고, 삼각형은 그 ", " 이에요."],
          answers: ["2", "평행사변형", "높이", "절반"],
          options: ["2", "3", "평행사변형", "사다리꼴", "높이", "둘레", "절반", "두 배"],
        },
      },
      {
        challenge: {
          question: "밑변 8cm, 높이 5cm인 삼각형의 넓이는?",
          answer: 20,
          unit: "cm²",
          solution: "8 × 5 ÷ 2 = 20",
        },
      },
      {
        prompt: "💡 삼각형 한 개의 넓이 = 밑변 × 높이 ÷ 2 — 직접 발견했어요!",
        manual: true,
        final: true,
      },
    ],
  },
  {
    id: "parallelogram",
    title: "평행사변형 → 직사각형",
    formula: "밑변 × 높이",
    build: (cx, cy) => {
      const W = 6 * GRID,
        H = 4 * GRID,
        sk = 2 * GRID;
      const w1 = withLabels(COLORS[4], placeAtCenter(makeParallelogram(0, 0, W, H, sk), cx, cy + 0.5 * GRID), PARA_LABELS);
      const ref = asReference(withLabels(COLORS[4], placeAtCenter(makeParallelogram(0, 0, W, H, sk), cx, cy - 6 * GRID), PARA_LABELS));
      return { working: [w1], reference: [ref] };
    },
    steps: [
      {
        prompt:
          "🎯 평행사변형의 끝부분(기울어진 삼각형)을 ✂️ 자르기로 잘라 반대쪽으로 옮긴 뒤 🔗 합치기를 해 '직사각형'을 만들어 보세요.",
        hint: "자르는 선은 끝의 꼭짓점에서 수직으로 내려야 해요. 잘린 삼각형을 이동해 빈 곳에 끼우고 합치기!",
        tool: "cut",
        done: (shapes) => {
          if (shapes.length !== 1) return false;
          const kind = detectShapeKind(shapes[0].points).name;
          if (kind !== "직사각형" && kind !== "정사각형") return false;
          return Math.abs(polygonArea(shapes[0].points) / (GRID * GRID) - 24) < 1.5;
        },
        success: "🎉 직사각형이 됐어요! 가로(밑변)와 세로(높이)가 평행사변형 때 그대로네요.",
      },
      {
        prompt: "📏 직사각형 넓이 = 가로 × 세로 = 밑변 × 높이. 위 점선 원본과 같은 넓이예요!",
        manual: true,
      },
      {
        fill: {
          parts: ["평행사변형의 끝을 잘라 옮기면 ", "이 돼요. 가로는 ", ", 세로는 ", " 예요. 그래서 넓이는 밑변 × ", " 이에요."],
          answers: ["직사각형", "밑변", "높이", "높이"],
          options: ["직사각형", "삼각형", "밑변", "대각선", "높이", "둘레"],
        },
      },
      {
        challenge: {
          question: "밑변 6cm, 높이 5cm인 평행사변형의 넓이는?",
          answer: 30,
          unit: "cm²",
          solution: "6 × 5 = 30",
        },
      },
      {
        prompt: "💡 평행사변형 넓이 = 밑변 × 높이 — 똑같은 공식! 직사각형으로 변신시켜 알아냈어요.",
        manual: true,
        final: true,
      },
    ],
  },
  {
    id: "rhombus",
    title: "마름모 = 직사각형의 절반",
    formula: "한 대각선 × 다른 대각선 ÷ 2",
    build: (cx, cy) => {
      const d1 = 6 * GRID,
        d2 = 4 * GRID;
      const r = withLabels(COLORS[3], placeAtCenter(makeRectangle(0, 0, d1, d2), cx, cy + 0.5 * GRID), RECT_LABELS);
      const m = withLabels(COLORS[1], placeAtCenter(makeRhombus(0, 0, d1, d2), cx, cy + 0.5 * GRID), [
        "대각선 절반",
        "대각선 절반",
        "대각선 절반",
        "대각선 절반",
      ]);
      const ref = asReference(withLabels(COLORS[1], placeAtCenter(makeRhombus(0, 0, d1, d2), cx, cy - 6 * GRID), TRAP_LABELS.map(() => "")));
      return { working: [r, m], reference: [ref] };
    },
    steps: [
      {
        prompt:
          "👀 마름모가 직사각형 안에 딱 들어가요. 마름모의 네 꼭짓점이 직사각형의 네 변 가운데에 닿죠? 직사각형의 가로·세로 = 마름모의 두 대각선!",
        manual: true,
      },
      {
        prompt:
          "🤔 직사각형 넓이 = 대각선1 × 대각선2 = 24cm². 마름모는 직사각형 안의 절반만 채워요 (위·아래·좌·우 4개의 삼각형이 똑같이 절반).",
        manual: true,
      },
      {
        fill: {
          parts: ["마름모는 두 대각선을 가로·세로로 하는 ", "의 ", " 이에요. 그래서 넓이는 (대각선 × 대각선) ÷ ", " 예요."],
          answers: ["직사각형", "절반", "2"],
          options: ["직사각형", "평행사변형", "절반", "두 배", "2", "4"],
        },
      },
      {
        challenge: {
          question: "두 대각선이 6cm, 8cm인 마름모의 넓이는?",
          answer: 24,
          unit: "cm²",
          solution: "6 × 8 ÷ 2 = 24",
        },
      },
      {
        prompt: "💡 마름모 넓이 = 한 대각선 × 다른 대각선 ÷ 2",
        manual: true,
        final: true,
      },
    ],
  },
  {
    id: "rectangle",
    title: "직사각형 = 가로 × 세로 (격자 세기)",
    formula: "가로 × 세로",
    build: (cx, cy) => {
      const W = 6 * GRID,
        H = 4 * GRID;
      const w1 = withLabels(COLORS[0], placeAtCenter(makeRectangle(0, 0, W, H), cx, cy + 0.5 * GRID), RECT_LABELS);
      const ref = asReference(withLabels(COLORS[0], placeAtCenter(makeRectangle(0, 0, W, H), cx, cy - 6 * GRID), RECT_LABELS));
      return { working: [w1], reference: [ref] };
    },
    steps: [
      {
        prompt:
          "👀 직사각형을 한 번 눌러 선택해 보세요. 안에 모눈 칸이 보일 거예요. 가로로 몇 칸? 세로로 몇 칸인가요?",
        manual: true,
        tool: "select",
      },
      {
        prompt: "📏 가로 6칸 × 세로 4칸 = 24칸. 한 칸은 1cm²이니까 넓이도 24cm²!",
        manual: true,
      },
      {
        fill: {
          parts: ["직사각형은 가로 ", "칸 × 세로 ", "칸 = ", "칸. 한 칸이 1cm²니까 넓이는 ", "cm² 예요."],
          answers: ["6", "4", "24", "24"],
          options: ["4", "6", "10", "12", "24"],
        },
      },
      {
        challenge: {
          question: "가로 7cm, 세로 5cm인 직사각형의 넓이는?",
          answer: 35,
          unit: "cm²",
          solution: "7 × 5 = 35",
        },
      },
      {
        prompt: "💡 직사각형 넓이 = 가로 × 세로 — 칸을 세는 게 곧 곱하기였어요!",
        manual: true,
        final: true,
      },
    ],
  },
];

// ===== 문제 모드 — 랜덤 20문제 =====
type QuizKind = "rect" | "para" | "tri" | "trap" | "compound";
type QuizProblem = {
  id: string;
  kind: QuizKind;
  prompt: string;
  answer: number; // cm²
  build: (cx: number, cy: number) => Shape[];
};
type QuizState = {
  problems: QuizProblem[];
  index: number;
  score: number;
  answered: ("correct" | "wrong" | null)[];
  userAnswer: string;
  result: "idle" | "correct" | "wrong" | "shown"; // shown=막힘 시 답 공개(점수 미인정)
  attempts: number; // 현재 문제 오답 횟수
  origin: Shape[]; // 현재 문제의 원본 도형(되돌리기용)
};

const KIND_HINT: Record<QuizKind, string> = {
  rect: "가로 칸 수 × 세로 칸 수를 세어 보세요!",
  para: "밑변 × 높이! 높이는 모눈 칸으로 셀 수 있어요.",
  tri: "밑변 × 높이 ÷ 2 예요. 똑같은 삼각형 둘이면 평행사변형!",
  trap: "(윗변 + 아랫변) × 높이 ÷ 2 예요.",
  compound: "여러 직사각형으로 ✂️나눠 더하거나, 모눈 칸을 하나씩 세어 보세요.",
};

const KIND_LABEL: Record<QuizKind, string> = {
  rect: "직사각형",
  para: "평행사변형",
  tri: "삼각형",
  trap: "사다리꼴",
  compound: "합성 도형",
};

function randInt(lo: number, hi: number) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// 난이도(0=쉬움,1=보통,2=어려움)별 치수 범위
function makeQuizProblem(kind: QuizKind, lv: number): QuizProblem {
  if (kind === "rect") {
    const w = lv === 0 ? randInt(2, 5) : lv === 1 ? randInt(3, 9) : randInt(6, 12);
    const h = lv === 0 ? randInt(2, 4) : lv === 1 ? randInt(2, 6) : randInt(4, 8);
    const color = pickColor();
    return {
      id: uid(),
      kind,
      prompt: "이 직사각형의 넓이는 몇 cm²일까요?",
      answer: w * h,
      build: (cx, cy) => [withLabels(color, placeAtCenter(makeRectangle(0, 0, w * GRID, h * GRID), cx, cy), RECT_LABELS)],
    };
  }
  if (kind === "para") {
    const b = lv === 0 ? randInt(3, 5) : lv === 1 ? randInt(4, 8) : randInt(6, 10);
    const h = lv === 0 ? randInt(2, 3) : lv === 1 ? randInt(3, 5) : randInt(4, 6);
    const sk = randInt(1, 2);
    const color = pickColor();
    return {
      id: uid(),
      kind,
      prompt: "이 평행사변형의 넓이는 몇 cm²일까요?",
      answer: b * h,
      build: (cx, cy) => [withLabels(color, placeAtCenter(makeParallelogram(0, 0, b * GRID, h * GRID, sk * GRID), cx, cy), PARA_LABELS)],
    };
  }
  if (kind === "tri") {
    const all: [number, number][] = [
      [4, 3], [6, 4], [4, 5], [8, 3], [6, 5], [4, 6], [8, 5], [10, 4], [6, 6], [8, 6], [10, 6], [12, 5],
    ];
    const pool = all.filter(([b, h]) => (lv === 0 ? b * h <= 18 : lv === 1 ? b * h <= 48 : b * h >= 30));
    const [b, h] = (pool.length ? pool : all)[randInt(0, (pool.length ? pool : all).length - 1)];
    const color = pickColor();
    const useRight = Math.random() < 0.5;
    return {
      id: uid(),
      kind,
      prompt: `이 ${useRight ? "직각" : ""}삼각형의 넓이는 몇 cm²일까요?`,
      answer: (b * h) / 2,
      build: (cx, cy) => [
        withLabels(
          color,
          placeAtCenter(useRight ? makeRightTriangle(0, 0, b * GRID, h * GRID) : makeTriangle(0, 0, b * GRID, h * GRID), cx, cy),
          useRight ? RTRI_LABELS : TRI_LABELS
        ),
      ],
    };
  }
  if (kind === "trap") {
    const maxB = lv === 0 ? 5 : lv === 1 ? 8 : 10;
    const maxH = lv === 0 ? 3 : lv === 1 ? 6 : 6;
    const tries: [number, number, number][] = [];
    for (let t = 2; t <= maxB - 2; t++)
      for (let bv = t + 2; bv <= maxB; bv++)
        for (let hv = 2; hv <= maxH; hv++)
          if (((t + bv) * hv) % 2 === 0) tries.push([t, bv, hv]);
    const [t, b, h] = tries[randInt(0, tries.length - 1)];
    const color = pickColor();
    return {
      id: uid(),
      kind,
      prompt: "이 사다리꼴의 넓이는 몇 cm²일까요?",
      answer: ((t + b) * h) / 2,
      build: (cx, cy) => [
        withLabels(color, placeAtCenter(makeTrapezoid(0, 0, t * GRID, b * GRID, h * GRID), cx, cy), TRAP_LABELS),
      ],
    };
  }
  // compound: ㄴ자 또는 십자 (격자로 셀 수 있는 정수)
  const useL = Math.random() < 0.5;
  if (useL) {
    const W = lv === 0 ? randInt(3, 5) : lv === 1 ? randInt(4, 8) : randInt(6, 10);
    const H = lv === 0 ? randInt(3, 5) : lv === 1 ? randInt(4, 7) : randInt(5, 8);
    const cw = randInt(1, Math.max(1, W - 2));
    const ch = randInt(1, Math.max(1, H - 2));
    const area = W * H - cw * ch;
    const color = pickColor();
    return {
      id: uid(),
      kind: "compound",
      prompt: "이 ㄴ자 도형의 넓이는 몇 cm²일까요?",
      answer: area,
      build: (cx, cy) => [{ id: uid(), color, points: placeAtCenter(makeLShape(0, 0, W * GRID, H * GRID, cw * GRID, ch * GRID), cx, cy) }],
    };
  }
  // 십자: 가운데 정사각형(aCm) + 4팔(aCm × lCm)
  const armCells = lv === 2 ? randInt(1, 2) : 1;
  const armLenCells = lv === 0 ? randInt(1, 2) : lv === 1 ? randInt(2, 3) : randInt(2, 4);
  const aCm = armCells * 2;
  const lCm = armLenCells;
  const area = aCm * aCm + 4 * aCm * lCm;
  const color = pickColor();
  return {
    id: uid(),
    kind: "compound",
    prompt: "이 십자 도형의 넓이는 몇 cm²일까요?",
    answer: area,
    build: (cx, cy) => [{ id: uid(), color, points: placeAtCenter(makeCross(0, 0, aCm * GRID, lCm * GRID), cx, cy) }],
  };
}

type QuizConfig = { count: number; kinds: QuizKind[]; level: number };

function makeQuizSet(cfg: QuizConfig): QuizProblem[] {
  const kindsPool = cfg.kinds.length ? cfg.kinds : (["rect", "para", "tri", "trap", "compound"] as QuizKind[]);
  const seq: QuizKind[] = [];
  for (let i = 0; i < cfg.count; i++) seq.push(kindsPool[i % kindsPool.length]);
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seq[i], seq[j]] = [seq[j], seq[i]];
  }
  // 첫 문제는 쉬운 유형(직사각형>평행사변형)으로 워밍업 — 가능하면 앞으로 당김
  const easyIdx = seq.findIndex((k) => k === "rect");
  const warmIdx = easyIdx >= 0 ? easyIdx : seq.findIndex((k) => k === "para");
  if (warmIdx > 0) [seq[0], seq[warmIdx]] = [seq[warmIdx], seq[0]];
  return seq.map((k) => makeQuizProblem(k, cfg.level));
}

// ----- 합치기 후 변 라벨 추론: 원본 변이 결과 변과 같은 직선상에 겹치면 라벨을 결과 변에 부여 -----
// (collinear 합쳐진 경우에도 양쪽 라벨이 모두 잡혀 "윗변 + 아랫변" 같이 표시됨)
function edgeOverlapsResult(m1: Point, m2: Point, a: Point, b: Point, tol = 2): boolean {
  const dx = m2.x - m1.x;
  const dy = m2.y - m1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1) return false;
  // a, b의 m1-m2 직선에 대한 수직 거리 (둘 다 직선 위에 있어야 collinear)
  const perpA = Math.abs((a.x - m1.x) * dy - (a.y - m1.y) * dx) / L;
  const perpB = Math.abs((b.x - m1.x) * dy - (b.y - m1.y) * dx) / L;
  if (perpA > tol || perpB > tol) return false;
  // 결과 변 길이 단위의 t값. [0,1]을 벗어나도 겹침만 있으면 OK
  const tA = ((a.x - m1.x) * dx + (a.y - m1.y) * dy) / (L * L);
  const tB = ((b.x - m1.x) * dx + (b.y - m1.y) * dy) / (L * L);
  const lo = Math.min(tA, tB);
  const hi = Math.max(tA, tB);
  return hi > 0.02 && lo < 0.98;
}
function inferEdgeLabels(merged: Point[], sources: Shape[]): string[] | undefined {
  if (!sources.some((s) => s.edgeLabels && s.edgeLabels.some(Boolean))) return undefined;
  const out: string[] = [];
  let any = false;
  for (let i = 0; i < merged.length; i++) {
    const m1 = merged[i];
    const m2 = merged[(i + 1) % merged.length];
    const labels = new Set<string>();
    for (const s of sources) {
      const ls = s.edgeLabels;
      if (!ls) continue;
      for (let k = 0; k < s.points.length; k++) {
        const a = s.points[k];
        const b = s.points[(k + 1) % s.points.length];
        if (ls[k] && edgeOverlapsResult(m1, m2, a, b)) labels.add(ls[k]);
      }
    }
    const joined = Array.from(labels).join(" + ");
    if (joined) any = true;
    out.push(joined);
  }
  return any ? out : undefined;
}

// 단축키는 왼손에 모이도록 배치: 주요 4도구는 홈행 A·S·D·F, 보조는 Q·W·E
const TOOL_META: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "select", icon: "🖱️", label: "선택·이동", key: "A" },
  { id: "draw", icon: "✏️", label: "그리기", key: "S" },
  { id: "cut", icon: "✂️", label: "자르기", key: "D" },
  { id: "merge", icon: "🔗", label: "합치기", key: "F" },
  { id: "measure", icon: "📏", label: "길이재기", key: "Q" },
  { id: "guide", icon: "📐", label: "가이드", key: "W" },
  { id: "text", icon: "📝", label: "글상자", key: "T" },
  { id: "delete", icon: "🗑️", label: "삭제", key: "E" },
];

// 선택 도형 변형/모드 단축키 (왼손 아래줄 Z·X·C·V + G)
const ACTION_KEYS = { rotL: "z", rotR: "x", flipH: "c", flipV: "v", gridCount: "g" } as const;

const TOOL_HINT: Record<Tool, string> = {
  select: "도형 눌러 선택 · Ctrl/Shift+클릭=여러 개 선택 · 드래그=이동 · 손잡이(초록)=회전(15°씩, Shift=자유) · 변 가운데 ➕=점 추가 · 꼭짓점 옆 ➖=점 삭제",
  draw: "빈 곳을 클릭해 꼭짓점을 찍어요. 첫 점을 다시 누르거나 Enter로 도형 완성!",
  cut: "도형 위를 드래그해 잘라요. 가로·세로·대각선 모두 가능.",
  merge: "합칠 도형 두 개를 차례로 누르세요. 한 변이 맞붙어야 합쳐져요. (여러 개를 선택한 뒤 '합치기'를 누르면 한꺼번에!)",
  measure: "두 점을 드래그해 길이를 재요. 끝점·선을 잡아 옮기고, Delete로 지울 수 있어요.",
  guide: "점선 보조선을 그어요. 끝점·선을 잡아 옮기고 조절, Delete로 지우기. (자르기 전 ‘여기서 자를까?’)",
  text: "빈 곳을 눌러 글상자를 만들어요. 글상자를 드래그=이동 · 다시 탭=글자 수정 · 오른쪽 아래 손잡이=크기 조절 (Shift 누르면 격자 무시). 선택 도구에서도 똑같이 다룰 수 있어요!",
  delete: "지우고 싶은 도형이나 글상자를 누르세요.",
};

// =============================================================

type XY = { x: number; y: number };
// 오버레이(도구 패널)를 손잡이로 끌어 자유롭게 옮기는 훅
function useDraggable(onMove: (p: XY) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<{ ox: number; oy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grab.current = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!g) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 100;
    const h = el?.offsetHeight ?? 100;
    const x = Math.max(2, Math.min(window.innerWidth - w - 2, e.clientX - g.ox));
    const y = Math.max(2, Math.min(window.innerHeight - h - 2, e.clientY - g.oy));
    onMove({ x, y });
  };
  const onPointerUp = () => {
    grab.current = null;
  };
  return { ref, handle: { onPointerDown, onPointerMove, onPointerUp } };
}

// 작은 드래그 손잡이 (점 6개) — 더블클릭 시 기본 위치로
function Grip({ handle, onReset, className }: { handle: object; onReset?: () => void; className?: string }) {
  return (
    <div
      {...handle}
      onDoubleClick={onReset}
      title="드래그해서 옮기기 · 더블클릭=기본 위치"
      className={`flex cursor-move touch-none items-center justify-center text-slate-300 hover:text-slate-500 ${className ?? ""}`}
    >
      <span className="text-xs tracking-tight">⠿⠿</span>
    </div>
  );
}

export default function PolygonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  // 다중 선택: 선택된 도형 id 집합(마지막이 '주 선택' = 꼭짓점 편집·회전 등 단일 대상)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  const setSelectedId = (id: string | null) => setSelectedIds(id ? [id] : []);
  const toggleSelect = (id: string) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const isSelected = (id: string) => selectedIds.includes(id);
  const [inspectId, setInspectId] = useState<string | null>(null); // 합쳐진 도형의 '조각 보기' 대상 id
  const [activeAux, setActiveAux] = useState<ActiveAux>(null);
  const [showAreaBadge, setShowAreaBadge] = useState(true);
  const [gridCountMode, setGridCountMode] = useState(false); // 칸세기 모드(어떤 도형이든 모눈 칸 표시)
  // ⬜ 무격자 모드: 모눈을 숨김 — 칸을 세지 않고 공식·표시된 길이만으로 넓이를 구하는 연습
  const [showGrid, setShowGrid] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem("showGrid") === "0") setShowGrid(false); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("showGrid", showGrid ? "1" : "0"); } catch {}
  }, [showGrid]);
  const [showAngles, setShowAngles] = useState(false); // 각도 표시(내각 + 내각의 합 유도)
  const [showSymmetry, setShowSymmetry] = useState(false); // 🪞 대칭축 표시(선대칭)
  const [showEdgeLen, setShowEdgeLen] = useState(true); // 변 길이(cm) 라벨 표시
  const [labelScale, setLabelScale] = useState(1); // 변·넓이 숫자 라벨 크기 배율 (수업용)
  // 원주율 어림값 모드 — 교과서에 따라 3 / 3.1 / 3.14 로 계산 (6학년 원 단원)
  const [piMode, setPiMode] = useState<3 | 3.1 | 3.14>(3.14);
  useEffect(() => {
    try {
      const v = localStorage.getItem("piMode");
      if (v === "3") setPiMode(3);
      else if (v === "3.1") setPiMode(3.1);
      else if (v === "3.14") setPiMode(3.14);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("piMode", String(piMode)); } catch {}
  }, [piMode]);
  const [mergeFirstId, setMergeFirstId] = useState<string | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [snapStep, setSnapStep] = useState<0 | 0.5 | 1>(0.5);
  // 자연수 모드: 모든 꼭짓점을 정수 cm(모눈 교차점)에 강제 스냅 — 기본값 ON
  const [integerMode, setIntegerMode] = useState(true);
  // 알파(딱맞춤) 모드: 등변/등각·프리셋 등으로 도형을 만들 때 넓이가 소수로 떨어지면
  //   모양을 최대한 유지하며 넓이가 딱 떨어지도록 자동 조정 (기본 OFF)
  const [alphaMode, setAlphaMode] = useState(false);
  // 🎓 학습모드: 자연수+딱맞춤을 강제하고, 회전은 90°씩, 도형을 만들거나 꼭짓점을
  //   놓을 때 변 길이·넓이가 '딱 떨어지는' 정합적인 값으로만 맞춰지도록 안내 (기본 OFF = 자유모드)
  const [learnMode, setLearnMode] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem("integerMode");
      // "0"으로 명시적으로 꺼둔 사용자만 OFF 유지, 그 외(null·"1")는 ON
      if (v === "0") setIntegerMode(false);
      else setIntegerMode(true);
      if (localStorage.getItem("alphaMode") === "1") setAlphaMode(true);
      if (localStorage.getItem("learnMode") === "1") {
        setLearnMode(true);
        setIntegerMode(true);
        setAlphaMode(true);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("alphaMode", alphaMode ? "1" : "0"); } catch {}
  }, [alphaMode]);
  useEffect(() => {
    try { localStorage.setItem("learnMode", learnMode ? "1" : "0"); } catch {}
  }, [learnMode]);
  function toggleLearnMode() {
    const next = !learnMode;
    setLearnMode(next);
    if (next) {
      setIntegerMode(true);
      setAlphaMode(true);
      setFlash("🎓 학습모드: 도형이 늘 격자에 딱 맞고, 변·넓이가 깔끔한 값으로 맞춰져요. 회전은 90°씩!");
    } else {
      setFlash("🕊️ 자유모드: 제한 없이 자유롭게 탐구할 수 있어요");
    }
  }
  useEffect(() => {
    try { localStorage.setItem("integerMode", integerMode ? "1" : "0"); } catch {}
    if (integerMode && snapStep !== 1) setSnapStep(1);
  }, [integerMode, snapStep]);
  // 자연수 모드가 켜질 때 기존 도형의 모든 꼭짓점을 정수 cm에 반올림 → "약" 흔적 즉시 제거
  useEffect(() => {
    if (!integerMode) return;
    setShapes((all) => {
      let changed = false;
      const next = all.map((s) => {
        // 정의 기반 도형(마름모·정n각형)은 정수 격자 강제 대신 정의(등변)를 유지 → 재구성
        if (s.defKind) {
          const rebuilt = reconstructDefShape(s.defKind, s.points, GRID);
          if (rebuilt) {
            changed = true;
            return { ...s, points: rebuilt, edgeLabels: undefined };
          }
          return s;
        }
        const pts = s.points.map((q) => {
          const nx = Math.round(q.x / GRID) * GRID;
          const ny = Math.round(q.y / GRID) * GRID;
          if (nx !== q.x || ny !== q.y) changed = true;
          return { x: nx, y: ny };
        });
        // 반올림해서 두 꼭짓점이 겹치면 원래대로 유지(도형 붕괴 방지)
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            if (Math.abs(pts[i].x - pts[j].x) < 1e-6 && Math.abs(pts[i].y - pts[j].y) < 1e-6) {
              return s;
            }
          }
        }
        return changed ? { ...s, points: pts, edgeLabels: undefined } : s;
      });
      return changed ? next : all;
    });
  }, [integerMode]);
  const [magnetic, setMagnetic] = useState(true);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const [scenarioHint, setScenarioHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [guides, setGuides] = useState<Guide[]>([]);
  // 글상자(설명 메모)
  const [texts, setTexts] = useState<TextNote[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const textBoxRef = useRef<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const justCreatedTextRef = useRef(false);
  // 꼭짓점 롱프레스(꾹 눌러 삭제) 타이머
  const holdVertexRef = useRef<{ timer: number; shapeId: string; vertexIndex: number; sx: number; sy: number } | null>(null);
  // 변·각 길게 누르기 → 등변/등각
  const holdEdgeRef = useRef<{ timer: number; shapeId: string; sx: number; sy: number } | null>(null);
  const holdAngleRef = useRef<{ timer: number; shapeId: string; sx: number; sy: number } | null>(null);
  // 도구모음(왼쪽 세로 막대) 접기 상태 — 저장은 세션 localStorage
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [infoCollapsed, setInfoCollapsed] = useState(false);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("railCollapsed") === "1") setRailCollapsed(true);
      const savedInfo = localStorage.getItem("infoCollapsed");
      if (savedInfo === "1") setInfoCollapsed(true);
      // 스마트폰(폭 480px 미만)에선 정보 카드가 화면 중앙을 가리므로,
      // 사용자가 명시적으로 펴 둔 적 없으면 접힌 상태로 시작
      else if (savedInfo === null && window.innerWidth < 480) setInfoCollapsed(true);
      if (localStorage.getItem("ctxCollapsed") === "1") setCtxCollapsed(true);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("railCollapsed", railCollapsed ? "1" : "0"); } catch {}
  }, [railCollapsed]);
  useEffect(() => {
    try { localStorage.setItem("infoCollapsed", infoCollapsed ? "1" : "0"); } catch {}
  }, [infoCollapsed]);
  useEffect(() => {
    try { localStorage.setItem("ctxCollapsed", ctxCollapsed ? "1" : "0"); } catch {}
  }, [ctxCollapsed]);
  // 회전 중 각도 배지(돌린 양·스냅 여부·화면 위치)
  const [rotInfo, setRotInfo] = useState<{ deg: number; snapped: boolean; sx: number; sy: number } | null>(null);
  // 제출용 저장 대화상자
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveTitle, setSaveTitle] = useState("");
  const [boardMode, setBoardMode] = useState(false);
  const [drawer, setDrawer] = useState<null | "shapes" | "scenarios">(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [lessonStep, setLessonStep] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [lessonReference, setLessonReference] = useState<Shape[]>([]);
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [quizSetup, setQuizSetup] = useState(false);
  const [progress, setProgress] = useState<{ quizBestPct: number; lessonsDone: string[] }>({ quizBestPct: 0, lessonsDone: [] });
  const [muted, setMuted] = useState(false);

  const [cam, setCamState] = useState<Camera>({ scale: 1, tx: 0, ty: 0 });
  const camRef = useRef<Camera>({ scale: 1, tx: 0, ty: 0 });
  const setCam = useCallback((c: Camera) => {
    camRef.current = c;
    setCamState(c);
  }, []);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  // 상단 바 실제 높이 — 좁은 화면(태블릿 세로 등)에서 줄바꿈돼도 패널이 겹치지 않게 동적 측정
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(56);
  // 넓이/둘레 정보카드를 자유롭게 옮긴 위치(없으면 기본=헤더 아래 우측)
  const [infoPos, setInfoPos] = useState<{ x: number; y: number } | null>(null);
  // 도구 패널들 자유 이동 위치
  const [railPos, setRailPos] = useState<XY | null>(null);
  const [ctxPos, setCtxPos] = useState<XY | null>(null);
  const [zoomPos, setZoomPos] = useState<XY | null>(null);
  const railDrag = useDraggable(setRailPos);
  const zoomDrag = useDraggable(setZoomPos);
  const ctxDrag = useDraggable(setCtxPos);
  // 🧹 화면 정리: 옮겨 놓은 패널을 전부 기본 위치로 (스마트폰에서 패널이 겹쳐 엉킬 때 한 번에 복구)
  function resetPanelLayout() {
    setInfoPos(null);
    setRailPos(null);
    setCtxPos(null);
    setZoomPos(null);
    setInfoCollapsed(false);
    setFlash("🧹 패널을 기본 위치로 정리했어요!");
  }
  // 화면 크기가 바뀌면(회전·키보드 등) 화면 밖에 남은 패널을 안으로 끌어옴
  useEffect(() => {
    const clampAll = () => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const fix = (p: XY | null): XY | null => {
        if (!p) return p;
        const x = Math.max(2, Math.min(W - 64, p.x));
        const y = Math.max(2, Math.min(H - 64, p.y));
        return x === p.x && y === p.y ? p : { x, y };
      };
      setInfoPos((p) => fix(p));
      setRailPos((p) => fix(p));
      setCtxPos((p) => fix(p));
      setZoomPos((p) => fix(p));
    };
    window.addEventListener("resize", clampAll);
    return () => window.removeEventListener("resize", clampAll);
  }, []);

  const dragRef = useRef<DragMode>({ type: "none" });
  const clipboardRef = useRef<{ points: Point[]; color: string; ghosts?: Point[][]; edgeLabels?: string[]; defKind?: Shape["defKind"] }[] | null>(null);
  const alignGuidesRef = useRef<{ vx: number[]; hy: number[] }>({ vx: [], hy: [] });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startCam: Camera; startMid: { x: number; y: number } } | null>(null);
  const spaceRef = useRef(false);
  const colorIndexRef = useRef(0);
  const didInitRef = useRef(false);

  const selected = useMemo(() => shapes.find((s) => s.id === selectedId) ?? null, [shapes, selectedId]);
  const selectedLiveRef = useRef<Shape | null>(null);
  selectedLiveRef.current = selected;
  // 최신 shapes와 함수들을 timer/rAF에서 stale-closure 없이 참조하기 위한 ref
  const shapesLiveRef = useRef<Shape[]>([]);
  shapesLiveRef.current = shapes;
  const equilateralizeShapeRef = useRef<(sid: string) => void>(() => {});
  const equiangularizeShapeRef = useRef<(sid: string) => void>(() => {});

  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    setDraft([]);
    setMergeFirstId(null);
    dragRef.current = { type: "none" };
  }, []);

  // ----- 화면 크기 추적 -----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      sizeRef.current = { w, h };
      setSize({ w, h });
    });
    ro.observe(el);
    const hel = headerRef.current;
    let hro: ResizeObserver | null = null;
    if (hel) {
      hro = new ResizeObserver(() => setHeaderH(hel.offsetHeight));
      hro.observe(hel);
      setHeaderH(hel.offsetHeight);
    }
    return () => {
      ro.disconnect();
      hro?.disconnect();
    };
  }, []);

  // 전자칠판을 껐다 켜면 헤더가 새로 마운트되므로 높이를 다시 측정·관찰 (스테일 방지)
  useEffect(() => {
    const hel = headerRef.current;
    if (!hel) return;
    const hro = new ResizeObserver(() => setHeaderH(hel.offsetHeight));
    hro.observe(hel);
    setHeaderH(hel.offsetHeight);
    return () => hro.disconnect();
  }, [boardMode]);

  // ----- 카메라 헬퍼 -----
  const toWorld = useCallback((sx: number, sy: number): Point => {
    const c = camRef.current;
    return { x: (sx - c.tx) / c.scale, y: (sy - c.ty) / c.scale };
  }, []);

  const gridSnap = useCallback(
    (p: Point): Point => {
      if (snapStep === 0) return p;
      const step = snapStep * GRID;
      return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
    },
    [snapStep]
  );

  const zoomAt = useCallback(
    (sx: number, sy: number, factor: number) => {
      const c = camRef.current;
      const ns = clamp(c.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = (sx - c.tx) / c.scale;
      const wy = (sy - c.ty) / c.scale;
      setCam({ scale: ns, tx: sx - wx * ns, ty: sy - wy * ns });
    },
    [setCam]
  );

  const zoomCenter = useCallback(
    (factor: number) => {
      const { w, h } = sizeRef.current;
      zoomAt(w / 2, h / 2, factor);
    },
    [zoomAt]
  );

  const fitView = useCallback(
    (list?: Shape[], opts?: { topInset?: number; bottomInset?: number; leftInset?: number }) => {
      const { w, h } = sizeRef.current;
      if (!w || !h) return;
      const src = list ?? shapes;
      let minX = 0,
        minY = 0,
        maxX = 16 * GRID,
        maxY = 10 * GRID;
      if (src.length) {
        minX = Infinity;
        minY = Infinity;
        maxX = -Infinity;
        maxY = -Infinity;
        for (const s of src)
          for (const p of s.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
      }
      // 여백은 화면 크기에 비례 (폰에서 80px 고정은 과해서 도형이 지나치게 작아짐).
      // 최소 48px — 변 길이 라벨이 도형 바깥으로 나와도 잘리지 않을 만큼
      const pad = Math.min(80, Math.max(48, w * 0.08));
      // 상단 문제 카드/하단 컨텍스트바를 가리지 않도록 위·아래 여백을 비워 그 사이에 도형 배치
      // 왼쪽 도구 레일(≈84px)에 도형이 가리지 않도록 왼쪽 여백도 기본으로 확보
      const topInset = opts?.topInset ?? 0;
      const bottomInset = opts?.bottomInset ?? 0;
      const leftInset = opts?.leftInset ?? 90;
      const availH = Math.max(GRID, h - topInset - bottomInset);
      const availW = Math.max(GRID, w - leftInset);
      const bw = Math.max(GRID, maxX - minX);
      const bh = Math.max(GRID, maxY - minY);
      const s = clamp(Math.min((availW - pad * 2) / bw, (availH - pad * 2) / bh), MIN_SCALE, MAX_SCALE);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      setCam({ scale: s, tx: leftInset + availW / 2 - cx * s, ty: topInset + availH / 2 - cy * s });
    },
    [shapes, setCam]
  );

  // 첫 렌더 시 기본 작업영역을 화면 중앙에 맞춤
  useEffect(() => {
    if (didInitRef.current) return;
    if (size.w > 0 && size.h > 0) {
      didInitRef.current = true;
      fitView([]);
    }
  }, [size, fitView]);

  // 현재 화면 중앙의 월드 좌표 (도형 생성 위치)
  const viewCenterWorld = useCallback((): Point => {
    const { w, h } = sizeRef.current;
    const p = toWorld(w / 2, h / 2);
    return { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
  }, [toWorld]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  // ----- 히스토리 (도형 + 측정선 + 가이드) -----
  const snapshot = useCallback(
    (): Snapshot => ({
      shapes: cloneShapes(shapes),
      measurements: cloneSegs(measurements),
      guides: cloneSegs(guides),
      texts: texts.map((t) => ({ ...t })),
    }),
    [shapes, measurements, guides, texts]
  );

  const commitHistory = useCallback(() => {
    setPast((p) => {
      const next = [...p, snapshot()];
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    });
    setFuture([]);
  }, [snapshot]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [snapshot(), ...f]);
    setPast((p) => p.slice(0, -1));
    setShapes(prev.shapes);
    setMeasurements(prev.measurements);
    setGuides(prev.guides);
    setTexts(prev.texts ?? []);
    setActiveTextId(null);
    setEditingTextId(null);
    setSelectedIds((ids) => ids.filter((id) => prev.shapes.find((s) => s.id === id)));
    setActiveAux(null);
    setMergeFirstId(null);
    setDraft([]);
    dragRef.current = { type: "none" };
  }, [past, snapshot]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, snapshot()]);
    setFuture((f) => f.slice(1));
    setShapes(next.shapes);
    setMeasurements(next.measurements);
    setGuides(next.guides);
    setTexts(next.texts ?? []);
    setActiveTextId(null);
    setEditingTextId(null);
    setSelectedIds((ids) => ids.filter((id) => next.shapes.find((s) => s.id === id)));
    setActiveAux(null);
    setMergeFirstId(null);
  }, [future, snapshot]);

  // ----- 자석 스냅 -----
  const vertexSnap = useCallback(
    (p: Point, excludeShapeId: string | undefined, tol: number): Point => {
      if (!magnetic) return p;
      let bestD = tol;
      let best: Point | null = null;
      for (const s of shapes) {
        if (excludeShapeId && s.id === excludeShapeId) continue;
        for (const v of s.points) {
          const d = Math.hypot(p.x - v.x, p.y - v.y);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
      return best ?? p;
    },
    [magnetic, shapes]
  );

  const magnetTranslate = useCallback(
    (pts: Point[], excludeShapeId: string, tol: number): { dx: number; dy: number } => {
      if (!magnetic) return { dx: 0, dy: 0 };
      let bestD = tol;
      let best = { dx: 0, dy: 0 };
      let found = false;
      for (const v of pts) {
        for (const s of shapes) {
          if (s.id === excludeShapeId) continue;
          for (const ov of s.points) {
            const d = Math.hypot(v.x - ov.x, v.y - ov.y);
            if (d < bestD) {
              bestD = d;
              best = { dx: ov.x - v.x, dy: ov.y - v.y };
              found = true;
            }
          }
        }
      }
      return found ? best : { dx: 0, dy: 0 };
    },
    [magnetic, shapes]
  );

  function nextColor() {
    const c = COLORS[colorIndexRef.current % COLORS.length];
    colorIndexRef.current += 1;
    return c;
  }

  function topShapeAt(p: Point): Shape | null {
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (shapes[i].isReference) continue;
      if (pointInPolygon(p, shapes[i].points)) return shapes[i];
    }
    return null;
  }

  // 월드 좌표 p에 있는 글상자 id (렌더 시 저장한 bbox 사용)
  function textAt(p: Point): string | null {
    for (let i = texts.length - 1; i >= 0; i--) {
      const b = textBoxRef.current.get(texts[i].id);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return texts[i].id;
    }
    return null;
  }
  function createTextAt(p: Point) {
    commitHistory();
    const id = uid();
    setTexts((t) => [...t, { id, x: p.x, y: p.y, text: "", color: "#78350f" }]);
    setActiveTextId(id);
    setEditingTextId(id);
    // 포인터 이벤트의 기본 포커스 동작과 경쟁하지 않도록, 잠깐 blur를 무시
    justCreatedTextRef.current = true;
    requestAnimationFrame(() => {
      textAreaRef.current?.focus();
      requestAnimationFrame(() => {
        justCreatedTextRef.current = false;
      });
    });
  }
  function updateText(id: string, text: string) {
    setTexts((t) => t.map((n) => (n.id === id ? { ...n, text } : n)));
  }
  function finishEditingText() {
    // 방금 생성돼 아직 포커스가 안정되지 않은 상태에서 온 blur는 무시(자동 포커스 경쟁 방지)
    if (justCreatedTextRef.current) {
      textAreaRef.current?.focus();
      return;
    }
    // 빈 글상자는 제거
    setTexts((t) => t.filter((n) => n.id !== editingTextId || n.text.trim().length > 0));
    setEditingTextId(null);
  }
  function deleteText(id: string) {
    commitHistory();
    setTexts((t) => t.filter((n) => n.id !== id));
    textBoxRef.current.delete(id);
    if (activeTextId === id) setActiveTextId(null);
    if (editingTextId === id) setEditingTextId(null);
  }

  function rotationHandle(s: Shape, k: number): Point {
    const c = polygonCentroid(s.points);
    const minY = Math.min(...s.points.map((q) => q.y));
    // 윗변 길이 라벨(≈ minY-30*k)을 가리지 않도록 충분히 위로 띄움
    return { x: c.x, y: minY - 56 * k };
  }

  // ----- 포인터 입력 -----
  function localXY(e: React.PointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  function doPinch() {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const a = { x: pts[0].x - rect.left, y: pts[0].y - rect.top };
    const b = { x: pts[1].x - rect.left, y: pts[1].y - rect.top };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!pinchRef.current) {
      pinchRef.current = { startDist: dist, startCam: { ...camRef.current }, startMid: mid };
      return;
    }
    const pr = pinchRef.current;
    const f = dist / (pr.startDist || 1);
    const ns = clamp(pr.startCam.scale * f, MIN_SCALE, MAX_SCALE);
    const wx = (pr.startMid.x - pr.startCam.tx) / pr.startCam.scale;
    const wy = (pr.startMid.y - pr.startCam.ty) / pr.startCam.scale;
    setCam({ scale: ns, tx: mid.x - wx * ns, ty: mid.y - wy * ns });
  }

  function handlePointerDown(e: React.PointerEvent) {
    const c = canvasRef.current!;
    c.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      pinchRef.current = null;
      dragRef.current = { type: "none" };
      return;
    }

    const { sx, sy } = localXY(e);
    const k0 = 1 / camRef.current.scale;
    // 손가락(터치)은 마우스보다 부정확 → 손잡이·꼭짓점 히트 영역을 1.5배로 (태블릿 조작성)
    const k = e.pointerType === "touch" ? k0 * 1.5 : k0;
    const raw = toWorld(sx, sy);
    const p = gridSnap(raw);

    // 화면 이동(팬): 스페이스, 가운데 버튼
    if (spaceRef.current || e.button === 1) {
      dragRef.current = { type: "pan", sx, sy, startCam: { ...camRef.current } };
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // 글상자(프레젠테이션식): 선택·글상자 도구 어디서든 자유롭게 이동·크기조절·편집
    //   손잡이 드래그=크기, 몸통 드래그=이동, 몸통 탭=편집, 빈 곳(글상자 도구)=새로 만들기
    if (tool === "select" || tool === "text") {
      // 1) 활성 글상자의 오른쪽 아래 손잡이 → 크기(글자) 조절
      if (activeTextId) {
        const b = textBoxRef.current.get(activeTextId);
        const note = texts.find((n) => n.id === activeTextId);
        if (b && note) {
          // 손잡이는 오른쪽 아래 '모서리'에 중심을 둠(절반은 상자 밖) → 작은 상자에서도 본문 탭을 가리지 않음
          const hs = 13 * k;
          const hcx = b.x + b.w;
          const hcy = b.y + b.h;
          if (Math.abs(raw.x - hcx) <= hs / 2 + 4 * k && Math.abs(raw.y - hcy) <= hs / 2 + 4 * k) {
            commitHistory();
            dragRef.current = { type: "textResize", id: activeTextId, startPointer: raw, startScale: note.scale ?? 1, startW: b.w, startH: b.h };
            return;
          }
        }
      }
      // 2) 글상자 몸통 → 드래그로 이동 / (거의 안 움직이면) 탭으로 편집
      const ht = textAt(raw);
      if (ht) {
        const note = texts.find((n) => n.id === ht)!;
        const wasActive = activeTextId === ht;
        setActiveTextId(ht);
        setSelectedIds([]);
        commitHistory();
        dragRef.current = { type: "textMove", id: ht, startPointer: raw, startX: note.x, startY: note.y, downSX: sx, downSY: sy, wasActive };
        return;
      }
    }

    if (tool === "draw") {
      if (draft.length >= 3) {
        const first = draft[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) < 14 * k) {
          finishDraft();
          return;
        }
      }
      setDraft((d) => [...d, p]);
      return;
    }

    if (tool === "text") {
      // 글상자 히트는 위 통합 블록에서 처리됨 → 여기 오면 빈 곳 클릭 = 새 글상자 만들기(바로 편집)
      createTextAt(p);
      return;
    }

    if (tool === "delete") {
      const hitText = textAt(raw);
      if (hitText) {
        commitHistory();
        deleteText(hitText);
        return;
      }
      const target = topShapeAt(raw);
      if (target) {
        commitHistory();
        setShapes((all) => all.filter((s) => s.id !== target.id));
        setSelectedIds((ids) => ids.filter((id) => id !== target.id));
      }
      return;
    }

    if (tool === "cut") {
      const startPt = vertexSnap(p, undefined, 16 * k);
      dragRef.current = { type: "cut", start: startPt, current: startPt };
      return;
    }
    if (tool === "measure" || tool === "guide") {
      const kind: "measure" | "guide" = tool;
      const list = kind === "measure" ? measurements : guides;
      // 1) 기존 끝점 잡기 → 끝점 조절 (격자 스냅 오차를 고려해 넉넉한 허용오차)
      for (const seg of list) {
        const end = Math.hypot(raw.x - seg.a.x, raw.y - seg.a.y) < 18 * k ? "a" : Math.hypot(raw.x - seg.b.x, raw.y - seg.b.y) < 18 * k ? "b" : null;
        if (end) {
          commitHistory();
          setSelectedId(null);
          setActiveAux({ kind, id: seg.id });
          dragRef.current = { type: "auxEnd", kind, id: seg.id, end };
          return;
        }
      }
      // 2) 선분 몸통 잡기 → 전체 평행이동
      for (const seg of list) {
        if (distToSegment(raw, seg.a, seg.b) < 10 * k) {
          commitHistory();
          setSelectedId(null);
          setActiveAux({ kind, id: seg.id });
          dragRef.current = { type: "auxMove", kind, id: seg.id, startA: { ...seg.a }, startB: { ...seg.b }, startPointer: p };
          return;
        }
      }
      // 3) 빈 곳 → 새로 그리기
      const startPt = vertexSnap(p, undefined, 16 * k);
      setActiveAux(null);
      dragRef.current = { type: kind, start: startPt, current: startPt };
      return;
    }

    if (tool === "merge") {
      const hit = topShapeAt(raw);
      if (!hit) {
        setMergeFirstId(null);
        return;
      }
      if (!mergeFirstId) {
        setMergeFirstId(hit.id);
        return;
      }
      if (mergeFirstId === hit.id) return;
      const A = shapes.find((s) => s.id === mergeFirstId)!;
      const merged = mergePolygons(A.points, hit.points);
      if (!merged) {
        setFlash("두 도형의 한 변이 정확히 맞붙어 있어야 합쳐져요. 🧲 자석을 켜고 가까이 가져가 보세요!");
        return;
      }
      commitHistory();
      const ghosts = [...(A.ghosts ?? [A.points]), ...(hit.ghosts ?? [hit.points])];
      const edgeLabels = inferEdgeLabels(merged, [A, hit]);
      setShapes((all) => {
        const remaining = all.filter((s) => s.id !== A.id && s.id !== hit.id);
        return [...remaining, { id: uid(), color: A.color, points: merged, ghosts, edgeLabels }];
      });
      setMergeFirstId(null);
      setFlash("도형 두 개를 하나로 합쳤어요! 합쳐진 자국이 점선으로 보여요.");
      return;
    }

    // (글상자 이동·크기조절은 위쪽 통합 블록에서 처리)

    // select — 단일 선택일 때만 회전/꼭짓점/점추가 편집 허용
    if (selected && selectedIds.length === 1) {
      // 원: 테두리(경계선) 근처를 잡으면 반지름 조절 — 자연수 cm로 스냅
      const isCircle = typeof selected.defKind === "object" && selected.defKind !== null && "circle" in selected.defKind;
      if (isCircle) {
        const c = polygonCentroid(selected.points);
        const R = selected.points.reduce((sum, q) => sum + Math.hypot(q.x - c.x, q.y - c.y), 0) / selected.points.length;
        const dist = Math.hypot(raw.x - c.x, raw.y - c.y);
        if (Math.abs(dist - R) < 16 * k) {
          commitHistory();
          dragRef.current = { type: "circleResize", shapeId: selected.id, center: c };
          return;
        }
        // 원은 회전 손잡이·꼭짓점 편집 없음 → 아래 일반 로직(이동/선택)으로 진행
      } else {
      // 손잡이·꼭짓점 히트테스트는 격자 스냅된 p가 아니라 실제 포인터 raw로 —
      //   손잡이가 격자 사이에 있으면 스냅된 좌표가 멀어져 "잘 안 잡히는" 문제 방지
      const handle = rotationHandle(selected, k);
      if (Math.hypot(raw.x - handle.x, raw.y - handle.y) < 18 * k) {
        commitHistory();
        const center = polygonCentroid(selected.points);
        dragRef.current = {
          type: "rotate",
          shapeId: selected.id,
          center,
          startAngle: Math.atan2(raw.y - center.y, raw.x - center.x),
          startPoints: selected.points.map((q) => ({ ...q })),
          startGhosts: selected.ghosts?.map((g) => g.map((q) => ({ ...q }))),
        };
        return;
      }
      // 꼭짓점 삭제 배지(➖) — 각 꼭짓점 바깥쪽의 빨간 버튼을 '탭'하면 바로 삭제(꾹 누르기 없이)
      if (selected.points.length > 3) {
        const cen = polygonCentroid(selected.points);
        for (let i = 0; i < selected.points.length; i++) {
          const v = selected.points[i];
          const ox = v.x - cen.x, oy = v.y - cen.y;
          const ol = Math.hypot(ox, oy) || 1;
          const bx = v.x + (ox / ol) * 22 * k;
          const by = v.y + (oy / ol) * 22 * k;
          if (Math.hypot(raw.x - bx, raw.y - by) < 13 * k) {
            commitHistory();
            const np = selected.points.filter((_, j) => j !== i);
            // 꼭짓점 개수가 바뀌면 정의 도형 특성(마름모/정n각형) 소실
            setShapes((all) => all.map((s) => (s.id === selected.id ? { ...s, points: np, ghosts: undefined, edgeLabels: undefined, defKind: undefined } : s)));
            setFlash("꼭짓점을 지웠어요 ➖");
            dragRef.current = { type: "none" };
            return;
          }
        }
      }
      const vi = selected.points.findIndex((v) => Math.hypot(v.x - raw.x, v.y - raw.y) < 15 * k);
      if (vi !== -1) {
        commitHistory();
        // 정의 도형(마름모·정n각형)은 드래그 시작 시점의 중심 + 원본 포인트를 저장
        // → 매 프레임 원본에서 재구성해 누적 오차/폭주 방지
        const startCenter = selected.defKind ? polygonCentroid(selected.points) : undefined;
        const startPoints = selected.defKind ? selected.points.map((q) => ({ ...q })) : undefined;
        dragRef.current = { type: "vertex", shapeId: selected.id, vertexIndex: vi, startCenter, startPoints };
        // 꾹 누르기(0.6초, 거의 안 움직였을 때) → 꼭짓점 삭제
        if (holdVertexRef.current) window.clearTimeout(holdVertexRef.current.timer);
        const shapeId = selected.id;
        const timer = window.setTimeout(() => {
          const cur = shapes.find((s) => s.id === shapeId);
          if (!cur || cur.points.length <= 3) {
            setFlash("삼각형은 더 줄일 수 없어요 (점 3개 최소)");
            holdVertexRef.current = null;
            return;
          }
          const np = cur.points.filter((_, i) => i !== vi);
          // C3: 꼭짓점 개수가 바뀌면 정의 도형 특성 소실
          setShapes((all) => all.map((s) => (s.id === shapeId ? { ...s, points: np, ghosts: undefined, edgeLabels: undefined, defKind: undefined } : s)));
          setFlash("꼭짓점을 지웠어요! (꾹 누르기)");
          dragRef.current = { type: "none" };
          holdVertexRef.current = null;
        }, 600);
        holdVertexRef.current = { timer, shapeId, vertexIndex: vi, sx, sy };
        return;
      }
      // 변 가운데 '+' 핸들 → 점 추가 후 바로 끌기 · 꾹 누르면 등변화
      if (tool === "select" && selected.points.length < 16) {
        for (let i = 0; i < selected.points.length; i++) {
          const a = selected.points[i];
          const b = selected.points[(i + 1) % selected.points.length];
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (Math.hypot(raw.x - m.x, raw.y - m.y) < 13 * k) {
            commitHistory();
            const np = [...selected.points];
            np.splice(i + 1, 0, { ...m });
            // C3: 정의 도형(마름모/정n각형)은 점 추가하면 정의가 깨지므로 defKind 클리어
            setShapes((all) => all.map((s) => (s.id === selected.id ? { ...s, points: np, ghosts: undefined, edgeLabels: undefined, defKind: undefined } : s)));
            dragRef.current = { type: "vertex", shapeId: selected.id, vertexIndex: i + 1, startCenter: undefined, startPoints: undefined };
            // 0.6초간 안 움직이면 → 방금 추가한 점 취소 후 등변화 (변을 꾹 눌러 모든 변 같게)
            if (holdEdgeRef.current) window.clearTimeout(holdEdgeRef.current.timer);
            const shapeId = selected.id;
            const timer = window.setTimeout(() => {
              // C5: 롱프레스 등변화의 히스토리 스택 정정
              //   1) ➕ 클릭 시 이미 commitHistory가 pre-add 상태를 저장했음
              //   2) 여기서 그 pre-add 스냅샷을 팝(해 실제로 "원래 상태 → 등변화" 한 단계로)
              //   3) 그 다음 점 추가를 취소하고 등변화 실행 → equilateralize 안에서 다시 commit
              setPast((p) => (p.length > 0 ? p.slice(0, -1) : p));
              setShapes((all) => all.map((s) => (s.id === shapeId ? { ...s, points: s.points.filter((_, j) => j !== i + 1) } : s)));
              requestAnimationFrame(() => {
                dragRef.current = { type: "none" };
                equilateralizeShapeRef.current(shapeId);
              });
              holdEdgeRef.current = null;
            }, 600);
            holdEdgeRef.current = { timer, shapeId, sx, sy };
            return;
          }
        }
      }
      // 각도(내각 라벨) 부근에서 시작: 각도 켜져 있을 때만 꼭짓점 근처를 꾹 눌러 등각화
      if (showAngles && tool === "select") {
        const vi = selected.points.findIndex((v) => Math.hypot(v.x - raw.x, v.y - raw.y) < 22 * k && Math.hypot(v.x - raw.x, v.y - raw.y) >= 14 * k);
        if (vi !== -1) {
          if (holdAngleRef.current) window.clearTimeout(holdAngleRef.current.timer);
          const shapeId = selected.id;
          const timer = window.setTimeout(() => {
            dragRef.current = { type: "none" };
            equiangularizeShapeRef.current(shapeId);
            holdAngleRef.current = null;
          }, 600);
          holdAngleRef.current = { timer, shapeId, sx, sy };
          return;
        }
      }
      } // end: 원이 아닌 도형의 회전/꼭짓점/점추가/각도 편집
    }
    const hit = topShapeAt(raw);
    if (hit) {
      const multi = e.ctrlKey || e.metaKey || e.shiftKey;
      if (multi) {
        // Ctrl/Shift+클릭 → 선택 토글(추가/제외), 이동 없음
        toggleSelect(hit.id);
        setActiveAux(null);
        setActiveTextId(null);
        dragRef.current = { type: "none" };
        return;
      }
      // 이미 선택된 그룹의 일부를 잡으면 그룹 전체를 함께 이동
      const inGroup = selectedIds.includes(hit.id) && selectedIds.length > 1;
      if (!inGroup) setSelectedId(hit.id);
      setActiveAux(null);
      setActiveTextId(null);
      commitHistory();
      const groupIds = inGroup ? selectedIds : [hit.id];
      const group = groupIds
        .map((id) => shapes.find((s) => s.id === id))
        .filter((s): s is Shape => !!s)
        .map((s) => ({ id: s.id, startPoints: s.points.map((q) => ({ ...q })), startGhosts: s.ghosts?.map((g) => g.map((q) => ({ ...q }))) }));
      dragRef.current = {
        type: "translate",
        shapeId: hit.id,
        startPointer: raw, // 격자 스냅 전 raw 좌표로 저장 → 이동은 연속, 자석 우선
        startPoints: hit.points.map((q) => ({ ...q })),
        startGhosts: hit.ghosts?.map((g) => g.map((q) => ({ ...q }))),
        group,
      };
    } else {
      // 빈 곳 → 화면 이동(팬). 움직이지 않으면 선택 해제.
      dragRef.current = { type: "pan", sx, sy, startCam: { ...camRef.current }, maybeDeselect: true };
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      doPinch();
      return;
    }
    const { sx, sy } = localXY(e);
    const raw = toWorld(sx, sy);
    const p = gridSnap(raw);
    setHoverPt(p);
    const dm = dragRef.current;
    // 꾹 누르기 삭제 대기 중 조금이라도 움직이면 취소(=일반 드래그로 이동)
    if (holdVertexRef.current) {
      const h = holdVertexRef.current;
      if (Math.hypot(sx - h.sx, sy - h.sy) > 6) {
        window.clearTimeout(h.timer);
        holdVertexRef.current = null;
      }
    }
    if (holdEdgeRef.current) {
      const h = holdEdgeRef.current;
      if (Math.hypot(sx - h.sx, sy - h.sy) > 6) {
        window.clearTimeout(h.timer);
        holdEdgeRef.current = null;
      }
    }
    if (holdAngleRef.current) {
      const h = holdAngleRef.current;
      if (Math.hypot(sx - h.sx, sy - h.sy) > 6) {
        window.clearTimeout(h.timer);
        holdAngleRef.current = null;
      }
    }
    if (dm.type === "none") return;

    if (dm.type === "pan") {
      const dx = sx - dm.sx;
      const dy = sy - dm.sy;
      if (Math.hypot(dx, dy) > 3) dm.moved = true;
      setCam({ scale: dm.startCam.scale, tx: dm.startCam.tx + dx, ty: dm.startCam.ty + dy });
      return;
    }

    const k = 1 / camRef.current.scale;
    if (dm.type === "cut") {
      dragRef.current = { ...dm, current: vertexSnap(p, undefined, 16 * k) };
      return;
    }
    if (dm.type === "measure") {
      dragRef.current = { ...dm, current: vertexSnap(p, undefined, 16 * k) };
      return;
    }
    if (dm.type === "guide") {
      dragRef.current = { ...dm, current: vertexSnap(p, undefined, 16 * k) };
      return;
    }
    if (dm.type === "auxEnd") {
      const np = vertexSnap(p, undefined, 14 * k);
      const patch = (s: Segment): Segment => (s.id === dm.id ? { ...s, ...(dm.end === "a" ? { a: np } : { b: np }) } : s);
      if (dm.kind === "measure") setMeasurements((m) => m.map(patch));
      else setGuides((g) => g.map(patch));
      return;
    }
    if (dm.type === "auxMove") {
      const dx = p.x - dm.startPointer.x;
      const dy = p.y - dm.startPointer.y;
      const patch = (s: Segment): Segment =>
        s.id === dm.id
          ? { ...s, a: { x: dm.startA.x + dx, y: dm.startA.y + dy }, b: { x: dm.startB.x + dx, y: dm.startB.y + dy } }
          : s;
      if (dm.kind === "measure") setMeasurements((m) => m.map(patch));
      else setGuides((g) => g.map(patch));
      return;
    }
    if (dm.type === "textMove") {
      const dx = raw.x - dm.startPointer.x;
      const dy = raw.y - dm.startPointer.y;
      let nx = dm.startX + dx;
      let ny = dm.startY + dy;
      // Shift로 스냅 잠시 해제, 그 외에는 현재 격자 간격에 맞춰 스냅
      if (!e.shiftKey && snapStep > 0) {
        const step = snapStep * GRID;
        nx = Math.round(nx / step) * step;
        ny = Math.round(ny / step) * step;
      }
      setTexts((t) => t.map((n) => (n.id === dm.id ? { ...n, x: nx, y: ny } : n)));
      return;
    }
    if (dm.type === "textResize") {
      // 시작 상자 크기와 포인터 이동량으로 스케일 계산 (대각선 기준)
      const dx = raw.x - dm.startPointer.x;
      const dy = raw.y - dm.startPointer.y;
      const startD = Math.hypot(dm.startW, dm.startH);
      let newD = Math.hypot(dm.startW + dx, dm.startH + dy);
      // 격자 스냅: 새 대각선 길이를 격자 배수에 가깝게 맞춤
      if (!e.shiftKey && snapStep > 0) {
        const step = snapStep * GRID;
        const stepD = step * Math.SQRT2; // 대각선 상의 격자 단위
        newD = Math.max(stepD, Math.round(newD / stepD) * stepD);
      }
      const f = startD > 0 ? newD / startD : 1;
      const next = Math.max(0.5, Math.min(4, dm.startScale * f));
      setTexts((t) => t.map((n) => (n.id === dm.id ? { ...n, scale: next } : n)));
      return;
    }
    if (dm.type === "circleResize") {
      // 포인터-중심 거리 = 새 반지름. 자연수 모드(또는 격자 켬)면 정수/반정수 cm 스냅
      let rCm = Math.hypot(raw.x - dm.center.x, raw.y - dm.center.y) / GRID;
      if (!e.shiftKey) {
        if (integerMode) rCm = Math.max(1, Math.round(rCm));
        else if (snapStep > 0) rCm = Math.max(snapStep, Math.round(rCm / snapStep) * snapStep);
      }
      rCm = Math.max(0.5, Math.min(50, rCm));
      const newPts = makeCircle(dm.center.x, dm.center.y, rCm * GRID);
      setShapes((all) =>
        all.map((s) => (s.id === dm.shapeId ? { ...s, points: newPts, defKind: { circle: rCm } } : s))
      );
      return;
    }
    if (dm.type === "rotate") {
      // 회전 각도는 격자 스냅된 p가 아니라 실제 포인터(raw)로 계산
      const curAbs = Math.atan2(raw.y - dm.center.y, raw.x - dm.center.x);
      const rawAng = curAbs - dm.startAngle;
      // 초록 손잡이 회전은 '돌린 양' 기준 15° 단위로만 —
      //   0·15·30·…·90·180° 처럼 딱딱 끊어지고, 180° 돌리면 정확히 반대,
      //   같은 만큼 되돌리면 처음 위치로 정확히 돌아옴 (이상한 각도로 남지 않음)
      //   🎓 학습모드에서는 90° 단위로만 → 회전해도 격자에서 벗어나지 않음.
      //   Shift를 누르면 자유 회전.
      const STEP = learnMode ? Math.PI / 2 : Math.PI / 12;
      const isSnap = !e.shiftKey;
      const ang = isSnap ? Math.round(rawAng / STEP) * STEP : rawAng;
      // 돌린 양(도) 배지
      let deg = ((ang * 180) / Math.PI) % 360;
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      const cam = camRef.current;
      setRotInfo({ deg: Math.round(deg), snapped: isSnap, sx: dm.center.x * cam.scale + cam.tx, sy: dm.center.y * cam.scale + cam.ty });
      // 🎓 학습모드: 90° 회전 후 꼭짓점을 격자에 다시 딱 붙임(반정수 중심 보정).
      //   곡선형(원 조각, 꼭짓점 20개 이상)은 개별 반올림하면 톱니가 되므로 제외.
      const snapRot = (pts: Point[]) => {
        const r = rotatePoints(pts, dm.center, ang);
        return learnMode && !e.shiftKey && pts.length < 20
          ? r.map((q) => ({ x: Math.round(q.x / GRID) * GRID, y: Math.round(q.y / GRID) * GRID }))
          : r;
      };
      setShapes((all) =>
        all.map((s) =>
          s.id === dm.shapeId
            ? { ...s, points: snapRot(dm.startPoints), ghosts: dm.startGhosts?.map((g) => snapRot(g)) }
            : s
        )
      );
      return;
    }
    if (dm.type === "translate") {
      // 이동은 연속(raw) 좌표 기준 — 격자 스냅으로 양자화하지 않음
      const dx0 = raw.x - dm.startPointer.x;
      const dy0 = raw.y - dm.startPointer.y;
      const moved = dm.startPoints.map((q) => ({ x: q.x + dx0, y: q.y + dy0 }));
      // 자석 우선(주 선택 도형 기준): 꼭짓점 자석 → 모서리/중심 정렬
      const mag = magnetTranslate(moved, dm.shapeId, 20 * k);
      const afterMag = moved.map((q) => ({ x: q.x + mag.dx, y: q.y + mag.dy }));
      const al = magnetic ? alignSnap(afterMag, shapes, dm.shapeId, 8 * k) : { dx: 0, dy: 0, vx: [], hy: [] };
      alignGuidesRef.current = { vx: al.vx, hy: al.hy };
      const step = e.shiftKey ? 0 : (snapStep > 0 ? snapStep * GRID : 0);
      const engagedX = mag.dx !== 0 || al.dx !== 0;
      const engagedY = mag.dy !== 0 || al.dy !== 0;
      // 잡은 손잡이(=드래그 시작점에서 가장 가까운 꼭짓점)를 격자 교차점에 딱 붙임
      // → 어디를 잡든 그 꼭짓점이 항상 모눈 교차점 위에 놓임(도형이 rotated/off-grid여도)
      let anchor = dm.startPoints[0];
      let bestD = Infinity;
      for (const q of dm.startPoints) {
        const d = Math.hypot(q.x - dm.startPointer.x, q.y - dm.startPointer.y);
        if (d < bestD) { bestD = d; anchor = q; }
      }
      const tdx = engagedX
        ? mag.dx + al.dx
        : step
        ? Math.round((anchor.x + dx0) / step) * step - (anchor.x + dx0)
        : 0;
      const tdy = engagedY
        ? mag.dy + al.dy
        : step
        ? Math.round((anchor.y + dy0) / step) * step - (anchor.y + dy0)
        : 0;
      const Dx = dx0 + tdx;
      const Dy = dy0 + tdy;
      // 자연수 모드: 모든 꼭짓점을 정수 cm에 개별 반올림 (정의 기반 도형은 예외 — 정의 유지)
      const translated = (q: Point): Point => ({ x: q.x + Dx, y: q.y + Dy });
      const roundIfInt = (q: Point, preserveDef: boolean): Point =>
        integerMode && !e.shiftKey && !preserveDef
          ? { x: Math.round((q.x + Dx) / GRID) * GRID, y: Math.round((q.y + Dy) / GRID) * GRID }
          : translated(q);
      // 선택 그룹 전체를 같은 양만큼 이동
      const grp = dm.group ?? [{ id: dm.shapeId, startPoints: dm.startPoints, startGhosts: dm.startGhosts }];
      const startMap = new Map(grp.map((g) => [g.id, g]));
      setShapes((all) =>
        all.map((s) => {
          const st = startMap.get(s.id);
          if (!st) return s;
          // 개별 꼭짓점 반올림을 하지 않고 강체(rigid)로 이동해야 하는 경우 — 잡은 꼭짓점만 격자에 맞춤:
          //   1) 정의 기반 도형(defKind: 마름모·정n각형·원)
          //   2) 곡선형(원 조각 등, 꼭짓점이 아주 많음) — 호가 톱니로 깨지는 것 방지
          //   3) 이미 격자에서 벗어난 도형(회전 등) — 개별 반올림하면 모양이 찌그러짐
          const onGrid = st.startPoints.every(
            (q) =>
              Math.abs(q.x / GRID - Math.round(q.x / GRID)) < 1e-3 &&
              Math.abs(q.y / GRID - Math.round(q.y / GRID)) < 1e-3
          );
          const preserveDef = !!s.defKind || s.points.length >= 20 || !onGrid;
          return {
            ...s,
            points: st.startPoints.map((q) => roundIfInt(q, preserveDef)),
            ghosts: st.startGhosts?.map((g) => g.map((q) => roundIfInt(q, preserveDef))),
          };
        })
      );
      return;
    }
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== dm.shapeId) return s;
        if (dm.type === "vertex") {
          // 자석 우선: 다른 도형 꼭짓점에 먼저 붙이고,
          // 없으면 정각(15°배수)·정수 변길이 스냅 → 그래도 없으면 격자 스냅.
          // Shift를 누르면 모든 스냅을 끄고 자유롭게 이동.
          const v = vertexSnap(raw, dm.shapeId, 16 * k);
          let snapped: Point;
          if (v.x !== raw.x || v.y !== raw.y) {
            snapped = v;
          } else if (e.shiftKey) {
            snapped = raw;
          } else if (integerMode) {
            // 자연수 모드: 무조건 정수 cm(모눈 교차점)에만
            snapped = { x: Math.round(raw.x / GRID) * GRID, y: Math.round(raw.y / GRID) * GRID };
          } else {
            const n = s.points.length;
            const P = s.points[(dm.vertexIndex - 1 + n) % n];
            const N = s.points[(dm.vertexIndex + 1) % n];
            const nice = snapVertexNice(raw, P, N, 12 * k);
            snapped = nice ?? gridSnap(raw);
          }
          // 정의 도형(defKind)은 스냅샷된 startPoints에서 앵커만 옮겨 매 프레임 재구성
          //   → s.points(이전 프레임 결과)에서 누적되는 오차를 원천 차단
          const basePoints = integerMode && s.defKind && dm.startPoints ? dm.startPoints : s.points;
          let newPoints = basePoints.map((q, i) => (i === dm.vertexIndex ? snapped : q));
          if (integerMode && s.defKind && !e.shiftKey) {
            const rebuilt = reconstructDefShape(s.defKind, newPoints, GRID, dm.vertexIndex, dm.startCenter);
            if (rebuilt) newPoints = rebuilt;
          }
          return {
            ...s,
            points: newPoints,
            ghosts: undefined,
          };
        }
        return s;
      })
    );
  }

  function handlePointerUp(e: React.PointerEvent) {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const dm = dragRef.current;
    const k = 1 / camRef.current.scale;
    if (dm.type === "rotate") setRotInfo(null);
    // 꾹 누르기 대기 취소(손을 뗀 경우)
    if (holdVertexRef.current) {
      window.clearTimeout(holdVertexRef.current.timer);
      holdVertexRef.current = null;
    }
    if (holdEdgeRef.current) {
      window.clearTimeout(holdEdgeRef.current.timer);
      holdEdgeRef.current = null;
    }
    if (holdAngleRef.current) {
      window.clearTimeout(holdAngleRef.current.timer);
      holdAngleRef.current = null;
    }
    if (dm.type === "pan") {
      if (dm.maybeDeselect && !dm.moved) {
        setSelectedId(null);
        setActiveTextId(null);
      }
    } else if (dm.type === "textMove") {
      // 거의 안 움직였으면 '탭' (프레젠테이션 글상자처럼):
      //   - 처음 탭 = 선택(손잡이 표시)  - 이미 선택된 글상자를 다시 탭 = 글자 편집
      const { sx, sy } = localXY(e);
      if (Math.hypot(sx - dm.downSX, sy - dm.downSY) < 5 && dm.wasActive) {
        setEditingTextId(dm.id);
        justCreatedTextRef.current = true;
        requestAnimationFrame(() => {
          textAreaRef.current?.focus();
          requestAnimationFrame(() => {
            justCreatedTextRef.current = false;
          });
        });
      }
    } else if (dm.type === "cut") {
      const { sx, sy } = localXY(e);
      const b = vertexSnap(gridSnap(toWorld(sx, sy)), undefined, 16 * k);
      const a = dm.start;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4 * k) applyCut(a, b);
    } else if (dm.type === "measure" || dm.type === "guide") {
      const { sx, sy } = localXY(e);
      const b = vertexSnap(gridSnap(toWorld(sx, sy)), undefined, 16 * k);
      const a = dm.start;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 8 * k) {
        commitHistory();
        const seg = { id: uid(), a, b };
        if (dm.type === "measure") setMeasurements((m) => [...m, seg]);
        else setGuides((g) => [...g, seg]);
        setActiveAux({ kind: dm.type, id: seg.id });
      }
    } else if (dm.type === "auxEnd" || dm.type === "auxMove") {
      // 편집 후 길이가 거의 0이면 자동 제거
      const list = dm.kind === "measure" ? measurements : guides;
      const seg = list.find((s) => s.id === dm.id);
      if (seg && Math.hypot(seg.a.x - seg.b.x, seg.a.y - seg.b.y) < 6 * k) {
        if (dm.kind === "measure") setMeasurements((m) => m.filter((s) => s.id !== dm.id));
        else setGuides((g) => g.filter((s) => s.id !== dm.id));
        setActiveAux(null);
      }
    } else if (dm.type === "vertex" && learnMode) {
      // 🎓 학습모드: 꼭짓점을 놓는 순간, 근처에 '인접 두 변이 모두 정수 cm'가 되는
      //   격자점이 있으면 그리로 딱 맞춤 (예: 16·약16.1·약16.1 → 16·17·17)
      const s = shapesLiveRef.current.find((sh) => sh.id === dm.shapeId);
      if (s && !s.defKind && s.points.length >= 3 && s.points.length < 20) {
        const snapped = learnSnapVertex(s.points, dm.vertexIndex);
        if (snapped) {
          setShapes((all) => all.map((sh) => (sh.id === dm.shapeId ? { ...sh, points: snapped } : sh)));
          const n = s.points.length;
          const v = snapped[dm.vertexIndex];
          const l1 = Math.round(Math.hypot(v.x - snapped[(dm.vertexIndex - 1 + n) % n].x, v.y - snapped[(dm.vertexIndex - 1 + n) % n].y) / GRID);
          const l2 = Math.round(Math.hypot(v.x - snapped[(dm.vertexIndex + 1) % n].x, v.y - snapped[(dm.vertexIndex + 1) % n].y) / GRID);
          setFlash(`🎓 딱 맞췄어요! 변 ${l1}cm·${l2}cm`);
        }
      }
    }
    dragRef.current = { type: "none" };
    alignGuidesRef.current = { vx: [], hy: [] };
  }

  function finishDraft() {
    if (draft.length < 3) return;
    commitHistory();
    const color = nextColor();
    const s: Shape = { id: uid(), points: draft, color };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setDraft([]);
    setTool("select");
  }

  function applyCut(a: Point, b: Point) {
    const out: Shape[] = [];
    let didCut = false;
    for (const s of shapes) {
      const parts = splitPolygonByLine(s.points, a, b);
      if (parts) {
        didCut = true;
        parts.forEach((pts, i) => {
          out.push({ id: uid(), points: pts, color: i === 0 ? s.color : nextColor() });
        });
      } else {
        out.push(s);
      }
    }
    if (didCut) {
      commitHistory();
      setShapes(out);
      setSelectedId(null);
    }
  }

  // ----- 휠 줌 (비-passive 네이티브 리스너) -----
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ----- 키보드 -----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const meta = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        spaceRef.current = true;
        return;
      }
      // 도구 단축키 (A/S/D/F/Q/W/E) — 수정키 없이
      if (!meta && !e.altKey) {
        const lk = e.key.toLowerCase();
        const tk = TOOL_META.find((t) => t.key.toLowerCase() === lk);
        if (tk) {
          activateTool(tk.id);
          return;
        }
        // 칸세기 모드 토글 (G)
        if (lk === ACTION_KEYS.gridCount) {
          setGridCountMode((v) => !v);
          return;
        }
        // 회전/뒤집기 (Z/X/C/V) — 선택 도형에 적용
        if (selectedId && (lk === ACTION_KEYS.rotL || lk === ACTION_KEYS.rotR || lk === ACTION_KEYS.flipH || lk === ACTION_KEYS.flipV)) {
          if (lk === ACTION_KEYS.rotL) transformSelected((pts, c) => rotatePoints(pts, c, -Math.PI / 2));
          else if (lk === ACTION_KEYS.rotR) transformSelected((pts, c) => rotatePoints(pts, c, Math.PI / 2));
          else if (lk === ACTION_KEYS.flipH) transformSelected((pts, c) => flipPoints(pts, c, "horizontal"));
          else transformSelected((pts, c) => flipPoints(pts, c, "vertical"));
          return;
        }
      }
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        if (selectedId) {
          e.preventDefault();
          copySelected();
        }
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        if (clipboardRef.current) {
          e.preventDefault();
          pasteClipboard();
        }
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (e.key === "+" || e.key === "=") zoomCenter(1.2);
      else if (e.key === "-" || e.key === "_") zoomCenter(1 / 1.2);
      else if (e.key === "Escape") {
        setDraft([]);
        setMergeFirstId(null);
        setDrawer(null);
        dragRef.current = { type: "none" };
      } else if (e.key === "Enter" && tool === "draw" && draft.length >= 3) {
        finishDraft();
      } else if (e.key.startsWith("Arrow") && selectedIds.length) {
        e.preventDefault();
        const base = (snapStep > 0 ? snapStep : 0.5) * GRID;
        const step = e.shiftKey ? GRID : base;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx || dy) {
          commitHistory();
          const ids = new Set(selectedIds);
          setShapes((all) =>
            all.map((s) =>
              ids.has(s.id)
                ? { ...s, points: translatePoints(s.points, dx, dy), ghosts: s.ghosts?.map((g) => translatePoints(g, dx, dy)) }
                : s
            )
          );
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.length) {
          commitHistory();
          const ids = new Set(selectedIds);
          setShapes((all) => all.filter((s) => !ids.has(s.id)));
          setSelectedIds([]);
        } else if (activeTextId) {
          commitHistory();
          deleteText(activeTextId);
        } else if (activeAux) {
          commitHistory();
          if (activeAux.kind === "measure") setMeasurements((m) => m.filter((s) => s.id !== activeAux.id));
          else setGuides((g) => g.filter((s) => s.id !== activeAux.id));
          setActiveAux(null);
        }
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spaceRef.current = false;
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, draft.length, selectedIds, shapes, activeAux, activeTextId, snapStep, undo, redo, commitHistory, zoomCenter, setTool, transformSelected]);

  function transformSelected(fn: (pts: Point[], center: Point) => Point[]) {
    if (!selectedIds.length) return;
    commitHistory();
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    // 여러 개면 전체를 감싼 상자의 중심을 공통 회전/뒤집기 축으로
    let center: Point;
    if (sel.length <= 1) {
      center = sel[0] ? polygonCentroid(sel[0].points) : { x: 0, y: 0 };
    } else {
      const pts = sel.flatMap((s) => s.points);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
    setShapes((all) =>
      all.map((s) => (selectedIds.includes(s.id) ? { ...s, points: fn(s.points, center), ghosts: s.ghosts?.map((g) => fn(g, center)) } : s))
    );
  }

  function duplicateSelected() {
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    if (!sel.length) return;
    commitHistory();
    const copies: Shape[] = sel.map((s) => ({
      id: uid(),
      color: sel.length === 1 ? nextColor() : s.color,
      points: translatePoints(s.points, GRID, GRID),
      ghosts: s.ghosts?.map((g) => translatePoints(g, GRID, GRID)),
      edgeLabels: s.edgeLabels ? [...s.edgeLabels] : undefined,
      defKind:
        typeof s.defKind === "object" && s.defKind !== null && "regular" in s.defKind
          ? { regular: s.defKind.regular }
          : s.defKind, // C2: 정의 도형 특성 유지
    }));
    setShapes((all) => [...all, ...copies]);
    setSelectedIds(copies.map((c) => c.id));
  }

  function deleteSelected() {
    if (!selectedIds.length) return;
    commitHistory();
    const ids = new Set(selectedIds);
    setShapes((all) => all.filter((s) => !ids.has(s.id)));
    setSelectedIds([]);
  }

  // 선택한 도형을 '정다각형'으로 반듯하게 맞추기 — 변 길이·내각을 딱 떨어지게
  // 특정 도형을 등변(모든 변 같음)으로 변환
  function equilateralizeShape(sid: string) {
    const s = shapesLiveRef.current.find((sh) => sh.id === sid);
    if (!s) return;
    // 원은 이미 '완벽한 등변' — 48각형으로 바뀌지 않도록 차단
    if (typeof s.defKind === "object" && s.defKind !== null && "circle" in s.defKind) return;
    const n = s.points.length;
    if (n < 3) return;
    if (n === 4) {
      // 마름모: 대각선을 자연수(짝수) cm로 스냅 → 넓이 = 대각선×대각선÷2 관계가 깔끔하게 유지
      const rebuilt = reconstructDefShape("rhombus", s.points, GRID);
      if (rebuilt) {
        commitHistory();
        setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: rebuilt, defKind: "rhombus", ghosts: undefined, edgeLabels: undefined } : sh)));
        const dd1 = Math.round(Math.hypot(rebuilt[2].x - rebuilt[0].x, rebuilt[2].y - rebuilt[0].y) / GRID);
        const dd2 = Math.round(Math.hypot(rebuilt[3].x - rebuilt[1].x, rebuilt[3].y - rebuilt[1].y) / GRID);
        setFlash(`🔷 마름모! 대각선 ${dd1}×${dd2}cm → 넓이 ${(dd1 * dd2) / 2}cm² (둘러싼 직사각형의 절반)`);
      }
      return;
    }
    // 정n각형(=등변+등각)
    const c = polygonCentroid(s.points);
    const avgR = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / n;
    const curSide = 2 * avgR * Math.sin(Math.PI / n);
    const sideUnits = Math.max(1, Math.round(curSide / GRID));
    const R = (sideUnits * GRID) / (2 * Math.sin(Math.PI / n));
    const a0 = Math.atan2(s.points[0].y - c.y, s.points[0].x - c.x);
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i * 2 * Math.PI) / n;
      pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
    }
    commitHistory();
    // 알파(딱맞춤) 모드: 넓이가 소수로 떨어지면 모양을 살짝 조정해 딱 떨어지게
    let alphaSnap = alphaMode ? niceAreaSnap(pts) : null;
    // 🎓 학습모드: 삼각형은 가능하면 세 변까지 모두 정수 cm로 (예: 5·5·6)
    if (alphaSnap && learnMode) {
      const refined = learnRefineTriangle(alphaSnap);
      if (refined) alphaSnap = refined;
    }
    if (alphaSnap) {
      setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: alphaSnap, defKind: undefined, ghosts: undefined, edgeLabels: undefined } : sh)));
      setFlash(`🎯 격자에 딱 맞추고 넓이를 ${fmtArea(polygonArea(alphaSnap) / (GRID * GRID))}로 만들었어요!`);
    } else {
      setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: pts, defKind: { regular: n }, ghosts: undefined, edgeLabels: undefined } : sh)));
      setFlash(`🔷 등변으로 만들었어요! 모든 변이 ${sideUnits}cm`);
    }
  }
  equilateralizeShapeRef.current = equilateralizeShape;
  function equilateralizeSelected() {
    if (selectedIds.length === 1) equilateralizeShape(selectedIds[0]);
  }
  // 🎯 알파(딱맞춤): 선택 도형의 넓이를 딱 떨어지는 값으로 자동 조정
  function snapNiceAreaShape(sid: string, silent = false): boolean {
    const s = shapesLiveRef.current.find((sh) => sh.id === sid);
    if (!s) return false;
    // 원은 넓이가 반지름×반지름×π 라서 정수가 될 수 없음 → 제외
    if (typeof s.defKind === "object" && s.defKind !== null && "circle" in s.defKind) {
      if (!silent) setFlash("원의 넓이는 반지름×반지름×π 라서 딱 떨어지지 않아요");
      return false;
    }
    const snapped = niceAreaSnap(s.points);
    if (!snapped) {
      if (!silent) setFlash("이미 넓이가 딱 떨어져요 👍");
      return false;
    }
    if (!silent) commitHistory();
    setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: snapped, defKind: undefined, ghosts: undefined, edgeLabels: undefined } : sh)));
    if (!silent) {
      const a = polygonArea(snapped) / (GRID * GRID);
      setFlash(`🎯 꼭짓점을 격자에 딱 맞추고 넓이를 ${fmtArea(a)}로 만들었어요!`);
    }
    return true;
  }
  function snapNiceAreaSelected() {
    if (selectedIds.length === 1) snapNiceAreaShape(selectedIds[0]);
  }
  // 특정 도형을 등각(모든 각 같음)으로 변환
  function equiangularizeShape(sid: string) {
    const s = shapesLiveRef.current.find((sh) => sh.id === sid);
    if (!s) return;
    // 원은 각 개념이 없음 — 정48각형으로 바뀌지 않도록 차단
    if (typeof s.defKind === "object" && s.defKind !== null && "circle" in s.defKind) return;
    const n = s.points.length;
    if (n < 3) return;
    const c = polygonCentroid(s.points);
    if (n === 4) {
      // C1: 직사각형(모든 각 90°). bbox가 아니라 실제 인접 두 변 길이를 사용해
      //   회전된 사각형에서도 원래 가로/세로가 정확히 나옴.
      const p0 = s.points[0], p1 = s.points[1], p2 = s.points[2], p3 = s.points[3];
      // 대각선 방향이 아닌 두 이웃 쌍(0-1, 1-2)의 평균 → (0-1 & 2-3), (1-2 & 3-0)
      const side01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const side23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
      const side12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const side30 = Math.hypot(p0.x - p3.x, p0.y - p3.y);
      const w = ((side01 + side23) / 2) / GRID;
      const h = ((side12 + side30) / 2) / GRID;
      const wi = Math.max(1, Math.round(w)) * GRID;
      const hi = Math.max(1, Math.round(h)) * GRID;
      // 방향: 변 0-1의 각도를 그대로 사용해 원본 회전을 유지
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      // 로컬 축(u = 변 0-1 방향, v = 그에 수직)
      const ux = cosA, uy = sinA;
      const vx = -sinA, vy = cosA;
      const pts = [
        { x: c.x - (wi / 2) * ux - (hi / 2) * vx, y: c.y - (wi / 2) * uy - (hi / 2) * vy },
        { x: c.x + (wi / 2) * ux - (hi / 2) * vx, y: c.y + (wi / 2) * uy - (hi / 2) * vy },
        { x: c.x + (wi / 2) * ux + (hi / 2) * vx, y: c.y + (wi / 2) * uy + (hi / 2) * vy },
        { x: c.x - (wi / 2) * ux + (hi / 2) * vx, y: c.y - (wi / 2) * uy + (hi / 2) * vy },
      ];
      commitHistory();
      setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: pts, defKind: undefined, ghosts: undefined, edgeLabels: undefined } : sh)));
      setFlash(`📐 등각으로 만들었어요! 모든 각이 90° (직사각형 ${Math.round(w)}×${Math.round(h)}cm)`);
      return;
    }
    // n≠4: 정n각형(등변+등각). 크기(반지름)는 유지 후 한 변을 자연수 cm로.
    const avgR = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / n;
    const curSide = 2 * avgR * Math.sin(Math.PI / n);
    const sideUnits = Math.max(1, Math.round(curSide / GRID));
    const R = (sideUnits * GRID) / (2 * Math.sin(Math.PI / n));
    const a0 = Math.atan2(s.points[0].y - c.y, s.points[0].x - c.x);
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i * 2 * Math.PI) / n;
      pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
    }
    commitHistory();
    let alphaSnap = alphaMode ? niceAreaSnap(pts) : null;
    if (alphaSnap && learnMode) {
      const refined = learnRefineTriangle(alphaSnap);
      if (refined) alphaSnap = refined;
    }
    if (alphaSnap) {
      setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: alphaSnap, defKind: undefined, ghosts: undefined, edgeLabels: undefined } : sh)));
      setFlash(`🎯 격자에 딱 맞추고 넓이를 ${fmtArea(polygonArea(alphaSnap) / (GRID * GRID))}로 만들었어요!`);
    } else {
      setShapes((all) => all.map((sh) => (sh.id === sid ? { ...sh, points: pts, defKind: { regular: n }, ghosts: undefined, edgeLabels: undefined } : sh)));
      const interior = Math.round(((n - 2) * 180) / n);
      setFlash(`📐 등각으로 만들었어요! 모든 각이 ${interior}° (정${n}각형)`);
    }
  }
  equiangularizeShapeRef.current = equiangularizeShape;
  function equiangularizeSelected() {
    if (selectedIds.length === 1) equiangularizeShape(selectedIds[0]);
  }
  function regularizeSelected() {
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    if (sel.length !== 1) return;
    const s = sel[0];
    const n = s.points.length;
    if (n < 3) return;
    const c = polygonCentroid(s.points);
    const avgR = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / n;
    const curSide = 2 * avgR * Math.sin(Math.PI / n);
    const sideUnits = Math.max(1, Math.round(curSide / GRID));
    const R = (sideUnits * GRID) / (2 * Math.sin(Math.PI / n));
    const a0 = Math.atan2(s.points[0].y - c.y, s.points[0].x - c.x); // 회전 유지
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i * 2 * Math.PI) / n;
      pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
    }
    commitHistory();
    setShapes((all) => all.map((sh) => (sh.id === s.id ? { ...sh, points: pts, ghosts: undefined, edgeLabels: undefined } : sh)));
    const interior = Math.round(((n - 2) * 180) / n);
    setFlash(`정다각형으로 반듯하게 맞췄어요! 한 변 ${sideUnits}cm · 내각 ${interior}°`);
  }

  // 단일 선택 도형이 '정다각형에 가까운지'(변 길이가 거의 같은지) — 맞추기 버튼 노출 조건
  const regularizable = (() => {
    if (selectedIds.length !== 1) return false;
    const s = shapes.find((x) => x.id === selectedIds[0]);
    if (!s || s.points.length < 3) return false;
    const lens = s.points.map((p, i) => {
      const q = s.points[(i + 1) % s.points.length];
      return Math.hypot(p.x - q.x, p.y - q.y);
    });
    const mn = Math.min(...lens);
    const mx = Math.max(...lens);
    return mn > 0 && mx / mn < 1.7;
  })();

  // 선택한 여러 도형을 한 번에 합치기 (맞붙은 변을 찾아 반복 병합)
  function mergeSelected(): boolean {
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    if (sel.length < 2) return false;
    // 작업용 목록: 병합 가능한 쌍을 찾을 때까지 반복
    let work: Shape[] = sel.map((s) => ({ ...s, ghosts: s.ghosts ?? [s.points] }));
    let progress = true;
    while (work.length > 1 && progress) {
      progress = false;
      outer: for (let i = 0; i < work.length; i++) {
        for (let j = i + 1; j < work.length; j++) {
          const merged = mergePolygons(work[i].points, work[j].points) || mergePolygons(work[j].points, work[i].points);
          if (merged) {
            const A = work[i];
            const B = work[j];
            const combined: Shape = {
              id: A.id,
              color: A.color,
              points: merged,
              ghosts: [...(A.ghosts ?? [A.points]), ...(B.ghosts ?? [B.points])],
              edgeLabels: inferEdgeLabels(merged, [A, B]),
            };
            work = work.filter((_, idx) => idx !== i && idx !== j);
            work.push(combined);
            progress = true;
            break outer;
          }
        }
      }
    }
    if (work.length === sel.length) {
      // 하나도 못 합침
      setFlash("합치려면 도형들이 한 변씩 정확히 맞붙어 있어야 해요. 🧲 자석을 켜고 붙여 보세요!");
      return false;
    }
    commitHistory();
    const removed = new Set(sel.map((s) => s.id));
    setShapes((all) => [...all.filter((s) => !removed.has(s.id)), ...work]);
    setSelectedIds(work.map((s) => s.id));
    if (work.length === 1) setFlash("선택한 도형들을 하나로 합쳤어요! 합쳐진 자국이 점선으로 보여요.");
    else setFlash(`맞붙은 것끼리 합쳐 ${work.length}개가 됐어요. 나머지는 변을 정확히 붙여 다시 합쳐 보세요.`);
    return true;
  }

  // 도구 선택: '합치기'는 여러 개가 선택돼 있으면 바로 합침(버튼·단축키 공통)
  function activateTool(id: Tool) {
    if (id === "merge" && selectedIds.length >= 2) {
      mergeSelected();
      return;
    }
    setTool(id);
  }

  // 더블클릭 → 글상자 편집
  function handleDoubleClick(e: React.MouseEvent) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const ht = textAt(w);
    if (ht) {
      setActiveTextId(ht);
      setEditingTextId(ht);
    }
  }

  // 꼭짓점 우클릭 → 점 삭제 (3개보다 많을 때)
  function handleContextMenu(e: React.MouseEvent) {
    const sel = selectedLiveRef.current;
    if (!sel || tool !== "select") return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const k = 1 / camRef.current.scale;
    const vi = sel.points.findIndex((v) => Math.hypot(v.x - w.x, v.y - w.y) < 14 * k);
    if (vi !== -1) {
      e.preventDefault();
      if (sel.points.length <= 3) {
        setFlash("삼각형은 더 줄일 수 없어요 (점 3개 최소)");
        return;
      }
      commitHistory();
      const np = sel.points.filter((_, i) => i !== vi);
      // C3: 꼭짓점 개수가 바뀌면 정의 도형 특성 소실
      setShapes((all) => all.map((s) => (s.id === sel.id ? { ...s, points: np, ghosts: undefined, edgeLabels: undefined, defKind: undefined } : s)));
    }
  }

  // ----- 복사/붙여넣기 (Ctrl+C / Ctrl+V) — 여러 개 지원 -----
  function copySelected() {
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    if (!sel.length) return;
    clipboardRef.current = sel.map((s) => ({
      points: s.points.map((p) => ({ ...p })),
      color: s.color,
      ghosts: s.ghosts?.map((g) => g.map((p) => ({ ...p }))),
      edgeLabels: s.edgeLabels ? [...s.edgeLabels] : undefined,
      defKind:
        typeof s.defKind === "object" && s.defKind !== null && "regular" in s.defKind
          ? { regular: s.defKind.regular }
          : s.defKind,
    }));
    setFlash(`도형 ${sel.length}개를 복사했어요 (Ctrl+V로 붙여넣기) 📋`);
  }
  function pasteClipboard() {
    const c = clipboardRef.current;
    if (!c || !c.length) return;
    commitHistory();
    const pastes: Shape[] = c.map((it) => ({
      id: uid(),
      color: it.color,
      points: translatePoints(it.points, GRID, GRID),
      ghosts: it.ghosts?.map((g) => translatePoints(g, GRID, GRID)),
      edgeLabels: it.edgeLabels ? [...it.edgeLabels] : undefined,
      defKind: it.defKind, // C2: 정의 도형 특성 유지(마름모/정n각형)
    }));
    setShapes((all) => [...all, ...pastes]);
    setSelectedIds(pastes.map((p) => p.id));
    setTool("select");
  }

  // 합쳐진 도형: 조각 보기 토글 (각 원본 조각을 색으로 구분해 넓이와 함께 표시)
  function toggleInspect() {
    if (!selected) return;
    setInspectId((cur) => (cur === selected.id ? null : selected.id));
  }

  // 합쳐진 도형을 원본 조각들로 분리 (개별로 다시 다룰 수 있게)
  function splitSelected() {
    if (!selected || !selected.ghosts || selected.ghosts.length < 2) return;
    commitHistory();
    const pieces: Shape[] = selected.ghosts.map((g, i) => ({
      id: uid(),
      color: COLORS[i % COLORS.length],
      points: g.map((p) => ({ ...p })),
    }));
    setShapes((all) => [...all.filter((s) => s.id !== selected.id), ...pieces]);
    setInspectId(null);
    setSelectedId(pieces[0]?.id ?? null);
    setFlash(`조각 ${pieces.length}개로 분리했어요. 이제 하나씩 옮길 수 있어요!`);
  }

  // 선택이 바뀌면 조각 보기 해제
  useEffect(() => {
    if (inspectId && inspectId !== selectedId) setInspectId(null);
  }, [selectedId, inspectId]);

  function setSelectedColor(color: string) {
    if (!selectedIds.length) return;
    commitHistory();
    const ids = new Set(selectedIds);
    setShapes((all) => all.map((s) => (ids.has(s.id) ? { ...s, color } : s)));
  }

  function addPreset(pr: Preset) {
    commitHistory();
    const { x: cx, y: cy } = viewCenterWorld();
    let pts = placeAtCenter(pr.build(), cx, cy);
    let defKind = pr.defKind;
    // 🎓 학습모드: 만들어지는 도형은 항상 격자 위 + 딱 떨어지는 값
    if (learnMode) {
      if (typeof defKind === "object" && defKind !== null && "circle" in defKind) {
        // 원: 중심을 격자 교차점에 (반지름은 이미 정수 cm)
        const c = polygonCentroid(pts);
        const dx = Math.round(c.x / GRID) * GRID - c.x;
        const dy = Math.round(c.y / GRID) * GRID - c.y;
        pts = pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      } else {
        const snapped = niceAreaSnap(pts);
        if (snapped) {
          pts = snapped;
          // 정n각형은 격자 보정 후 더 이상 '정다각형'이 아님 → 정의 해제
          if (typeof defKind === "object" && defKind !== null && "regular" in defKind) defKind = undefined;
        }
        // 삼각형은 가능하면 세 변 모두 정수 cm(피타고라스 수)로 마무리
        if (pts.length === 3) {
          const refined = learnRefineTriangle(pts);
          if (refined) pts = refined;
        }
      }
    }
    const s: Shape = { id: uid(), color: nextColor(), points: pts, defKind };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setTool("select");
    // 좁은 화면(스마트폰)에서는 드로어가 화면 대부분을 가리므로 도형을 추가하면 자동으로 닫음
    if (typeof window !== "undefined" && window.innerWidth < 640) setDrawer(null);
  }

  function loadScenario(sc: Scenario) {
    commitHistory();
    const { x: cx, y: cy } = viewCenterWorld();
    let built = sc.build(cx, cy);
    // 세로 화면: 나란한 예시 도형을 세로로 쌓아 크게 (겹쳐 놓은 도형은 묶음 유지)
    if (sizeRef.current.h > sizeRef.current.w) built = stackClustersForPortrait(built);
    setShapes(built);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setTool("select");
    setScenarioHint(sc.hint);
    setDrawer(null);
    requestAnimationFrame(() => fitView(built));
  }

  // ----- 탐구 레슨 -----
  // 세로(포트레이트) 화면: 가로로 나란히 배치된 도형들을 세로로 쌓아 더 크게 보이게.
  // 일부러 겹쳐 놓은 도형(예: 직사각형 안 마름모)은 '겹침 클러스터'로 묶어 함께 이동.
  function stackClustersForPortrait(shapesIn: Shape[]): Shape[] {
    const n = shapesIn.length;
    if (n < 2) return shapesIn;
    const boxes = shapesIn.map((s) => {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
    // 겹침(여유 0.5칸) 기준 연결 요소 찾기
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const m = GRID * 0.5;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.minX < b.maxX + m && b.minX < a.maxX + m && a.minY < b.maxY + m && b.minY < a.maxY + m) parent[find(i)] = find(j);
      }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }
    if (groups.size < 2) return shapesIn; // 전부 한 덩어리면 그대로
    // 전체가 이미 세로형이면 그대로
    const totW = Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX));
    const totH = Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY));
    if (totH >= totW) return shapesIn;
    // 클러스터를 (위→아래, 왼→오른쪽) 순으로 세로 쌓기 — 이동량은 칸 단위로 반올림해 격자 유지
    const clusters = [...groups.values()].map((idxs) => {
      const bb = {
        minX: Math.min(...idxs.map((i) => boxes[i].minX)),
        maxX: Math.max(...idxs.map((i) => boxes[i].maxX)),
        minY: Math.min(...idxs.map((i) => boxes[i].minY)),
        maxY: Math.max(...idxs.map((i) => boxes[i].maxY)),
      };
      return { idxs, bb };
    });
    clusters.sort((a, b) => a.bb.minY - b.bb.minY || a.bb.minX - b.bb.minX);
    const cx = (Math.min(...boxes.map((b) => b.minX)) + Math.max(...boxes.map((b) => b.maxX))) / 2;
    let y = Math.min(...boxes.map((b) => b.minY));
    const out = shapesIn.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
    for (const cl of clusters) {
      const dx = Math.round((cx - (cl.bb.minX + cl.bb.maxX) / 2) / GRID) * GRID;
      const dy = Math.round((y - cl.bb.minY) / GRID) * GRID;
      for (const i of cl.idxs) out[i] = { ...out[i], points: translatePoints(out[i].points, dx, dy) };
      y += cl.bb.maxY - cl.bb.minY + GRID * 1.5;
    }
    return out;
  }

  function startLesson(L: Lesson) {
    commitHistory();
    const { x: cx, y: cy } = viewCenterWorld();
    const built = L.build(cx, cy);
    let working = built.working;
    let reference = built.reference;
    // 세로 화면에서는 나란한 배치를 세로로 쌓아 도형이 크게 보이도록
    if (sizeRef.current.h > sizeRef.current.w) {
      const stacked = stackClustersForPortrait([...reference, ...working]);
      reference = stacked.slice(0, reference.length);
      working = stacked.slice(reference.length);
    }
    setShapes(working);
    setLessonReference(reference);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setMeasurements([]);
    setGuides([]);
    setScenarioHint(null);
    setTool(L.steps[0]?.tool ?? "select");
    setLesson(L);
    setLessonStep(0);
    setShowHint(false);
    setDrawer(null);
    const all = [...working, ...reference];
    requestAnimationFrame(() => fitView(all, { topInset: headerH + 8, bottomInset: 90 }));
  }

  function restartLesson() {
    if (!lesson) return;
    const { x: cx, y: cy } = viewCenterWorld();
    const built = lesson.build(cx, cy);
    commitHistory();
    let working = built.working;
    let reference = built.reference;
    if (sizeRef.current.h > sizeRef.current.w) {
      const stacked = stackClustersForPortrait([...reference, ...working]);
      reference = stacked.slice(0, reference.length);
      working = stacked.slice(reference.length);
    }
    setShapes(working);
    setLessonReference(reference);
    setSelectedId(null);
    setMergeFirstId(null);
    setLessonStep(0);
    setShowHint(false);
    const all = [...working, ...reference];
    requestAnimationFrame(() => fitView(all, { topInset: headerH + 8, bottomInset: 90 }));
  }

  function exitLesson() {
    if (lesson) setFlash("🧪 학습을 마쳤어요 — '학습 예시'에서 언제든 다시 시작할 수 있어요");
    setLesson(null);
    setLessonStep(0);
    setShowHint(false);
    setLessonReference([]);
  }

  // ----- 문제 모드 -----
  // 현재 문제의 도형을 만들고, 되돌리기용 원본 스냅샷도 반환
  function buildQuizShapes(p: QuizProblem): Shape[] {
    const { x: cx, y: cy } = viewCenterWorld();
    return p.build(cx, cy);
  }
  function showQuizShapes(built: Shape[]) {
    setShapes(built);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setMeasurements([]);
    setGuides([]);
    setActiveAux(null);
    // 헤더(동적) + 문제 카드 높이만큼 위를, 하단 컨텍스트바만큼 아래를 비워 그 사이에 도형 배치
    requestAnimationFrame(() => fitView(built, { topInset: headerH + 180, bottomInset: 100 }));
  }

  function startQuiz(cfg: QuizConfig) {
    exitLesson();
    setQuizSetup(false);
    const problems = makeQuizSet(cfg);
    setQuizFromProblems(problems);
  }

  function setQuizFromProblems(problems: QuizProblem[]) {
    commitHistory(); // 학생이 그리던 캔버스가 대체되므로 ↶ 되돌리기로 복구 가능하게
    const built = buildQuizShapes(problems[0]);
    setQuiz({
      problems,
      index: 0,
      score: 0,
      answered: problems.map(() => null),
      userAnswer: "",
      result: "idle",
      attempts: 0,
      origin: cloneShapes(built),
    });
    setTool("select");
    setDrawer(null);
    setScenarioHint(null);
    showQuizShapes(built);
  }

  function exitQuiz() {
    if (quiz) {
      // 문제 도형이 캔버스에 남아 정답이 노출된 채 어질러지지 않도록 정리 (↶로 복구 가능)
      commitHistory();
      setShapes([]);
      setSelectedId(null);
      setMergeFirstId(null);
    }
    setQuiz(null);
  }

  // 현재 문제 도형을 처음 상태로 복원 (자르기/합치기 등으로 망가졌을 때)
  function resetQuizShape() {
    if (!quiz) return;
    showQuizShapes(cloneShapes(quiz.origin));
  }

  function submitQuiz() {
    if (!quiz) return;
    // 빈칸·숫자 아닌 입력은 오답으로 세지 않고 친절히 안내
    if (!/[0-9]/.test(quiz.userAnswer)) {
      setFlash("답에 숫자를 입력해요 ✏️");
      return;
    }
    const v = parseFloat(quiz.userAnswer.replace(/[^0-9.\-]/g, ""));
    const target = quiz.problems[quiz.index].answer;
    if (!isNaN(v) && Math.abs(v - target) <= 0.001) {
      const answered = [...quiz.answered];
      const firstTry = answered[quiz.index] === null;
      if (firstTry) answered[quiz.index] = "correct";
      setQuiz({ ...quiz, result: "correct", score: firstTry ? quiz.score + 1 : quiz.score, answered });
    } else {
      const answered = [...quiz.answered];
      if (answered[quiz.index] === null) answered[quiz.index] = "wrong";
      setQuiz({ ...quiz, result: "wrong", answered, attempts: quiz.attempts + 1 });
    }
  }

  // 막힘 방지: 답을 확인하고 넘어가기 (점수 미인정)
  function giveUpQuiz() {
    if (!quiz) return;
    const answered = [...quiz.answered];
    if (answered[quiz.index] === null) answered[quiz.index] = "wrong";
    setQuiz({ ...quiz, result: "shown", answered });
  }

  function nextQuiz() {
    if (!quiz) return;
    const ni = quiz.index + 1;
    if (ni >= quiz.problems.length) {
      setQuiz({ ...quiz, index: ni, result: "idle", userAnswer: "" });
      return;
    }
    const built = buildQuizShapes(quiz.problems[ni]);
    setQuiz({ ...quiz, index: ni, result: "idle", userAnswer: "", attempts: 0, origin: cloneShapes(built) });
    showQuizShapes(built);
  }

  function restartQuiz() {
    if (!quiz) return;
    setQuizFromProblems(quiz.problems.map((pr) => makeQuizProblem(pr.kind, 1)));
  }

  // 오답 리뷰: 틀린(또는 답 본) 문제만 다시 풀기
  function retryWrong() {
    if (!quiz) return;
    const wrongs = quiz.problems.filter((_, i) => quiz.answered[i] !== "correct");
    if (!wrongs.length) return;
    setQuizFromProblems(wrongs);
  }

  // ----- 진도/점수 저장 (F) -----
  useEffect(() => {
    try {
      const raw = localStorage.getItem("studytool.progress");
      if (raw) setProgress(JSON.parse(raw));
      const m = localStorage.getItem("studytool.muted");
      if (m) setMuted(m === "1");
      const ls = localStorage.getItem("studytool.labelScale");
      if (ls) setLabelScale(Math.min(2.4, Math.max(1, parseFloat(ls) || 1)));
    } catch {}
  }, []);
  function persist(p: { quizBestPct: number; lessonsDone: string[] }) {
    setProgress(p);
    try {
      localStorage.setItem("studytool.progress", JSON.stringify(p));
    } catch {}
  }
  function toggleMuted() {
    setMuted((v) => {
      const nv = !v;
      try {
        localStorage.setItem("studytool.muted", nv ? "1" : "0");
      } catch {}
      return nv;
    });
  }
  // 라벨(변·넓이 숫자) 크기 단계 조절: 1 → 1.3 → 1.7 → 2.1 순환
  const LABEL_STEPS = [1, 1.3, 1.7, 2.1];
  function bumpLabelScale(dir: 1 | -1) {
    setLabelScale((cur) => {
      const i = LABEL_STEPS.reduce((best, v, idx) => (Math.abs(v - cur) < Math.abs(LABEL_STEPS[best] - cur) ? idx : best), 0);
      const ni = Math.min(LABEL_STEPS.length - 1, Math.max(0, i + dir));
      const nv = LABEL_STEPS[ni];
      try {
        localStorage.setItem("studytool.labelScale", String(nv));
      } catch {}
      return nv;
    });
  }
  // 레슨 완료 기록
  useEffect(() => {
    if (lesson && lesson.steps[lessonStep]?.final && !progress.lessonsDone.includes(lesson.id)) {
      persist({ ...progress, lessonsDone: [...progress.lessonsDone, lesson.id] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson, lessonStep]);
  // 퀴즈 완주 시 최고 기록(%)
  useEffect(() => {
    if (quiz && quiz.index >= quiz.problems.length) {
      const pct = Math.round((quiz.score / quiz.problems.length) * 100);
      if (pct > progress.quizBestPct) persist({ ...progress, quizBestPct: pct });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz?.index]);

  function advanceLesson() {
    if (!lesson) return;
    setShowHint(false);
    setLessonStep((i) => Math.min(i + 1, lesson.steps.length - 1));
  }

  // 자동 감지: 현재 단계의 목표 상태가 달성되면 다음 단계로 (reference 제외)
  useEffect(() => {
    if (!lesson) return;
    const step = lesson.steps[lessonStep];
    if (!step || step.manual || !step.done) return;
    const working = shapes.filter((s) => !s.isReference);
    if (step.done(working)) {
      if (step.success) setFlash(step.success);
      setShowHint(false);
      setLessonStep((i) => Math.min(i + 1, lesson.steps.length - 1));
    }
  }, [shapes, lesson, lessonStep]);

  function clearAll() {
    // 학생 기기에서 실수로 눌러 작업·학습이 통째로 날아가지 않도록 확인
    if (shapes.length > 0 || texts.length > 0 || lesson || quiz) {
      const msg = lesson
        ? "진행 중인 학습과 모든 도형이 지워져요. 정말 처음부터 시작할까요?"
        : "모든 도형과 글상자가 지워져요. 정말 전체 초기화할까요?";
      if (!window.confirm(msg)) return;
    }
    commitHistory();
    setShapes([]);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setScenarioHint(null);
    setMeasurements([]);
    setGuides([]);
    exitLesson();
    setQuiz(null); // exitQuiz의 캔버스 정리는 위에서 이미 수행 (중복 커밋 방지)
  }

  // 저장 버튼 → 제출용 대화상자 열기(입력창 포커스가 편집 중 글상자를 자동 확정)
  function openSaveDialog() {
    // 편집 중 글상자가 있다면 먼저 확정(내용을 손실하지 않도록)
    if (editingTextId) {
      const editing = texts.find((t) => t.id === editingTextId);
      // 편집 중인 노트가 비어 있으면 빈 채로라도 유지(자동 삭제 방지)
      if (editing && editing.text.length === 0) {
        setTexts((all) =>
          all.map((n) => (n.id === editingTextId ? { ...n, text: n.text || " " } : n))
        );
      }
      setEditingTextId(null);
    }
    // U2: 공용 iPad에서 이전 학생 이름 자동 채움을 없앰(사생활 보호)
    // 이름 필드는 매번 비운 상태로 열림. 원한다면 힌트만 title로.
    setSaveOpen(true);
  }

  // 이름·날짜 머리글을 붙인 '제출용' 이미지로 저장
  function exportSubmission(name: string, title: string) {
    const c = canvasRef.current;
    if (!c) return;
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const H = Math.round(92 * dpr); // 머리글 높이
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height + H;
      const g = off.getContext("2d");
      if (!g) return;
      // 배경 + 머리글 띠
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, off.width, off.height);
      g.fillStyle = "#eff6ff";
      g.fillRect(0, 0, off.width, H);
      g.fillStyle = "#bfdbfe";
      g.fillRect(0, H - Math.round(3 * dpr), off.width, Math.round(3 * dpr));
      const d = new Date();
      const dateStr = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
      const pad = Math.round(26 * dpr);
      g.textBaseline = "middle";
      g.textAlign = "left";
      g.fillStyle = "#1e3a8a";
      g.font = `800 ${Math.round(30 * dpr)}px sans-serif`;
      g.fillText(name.trim() ? `이름: ${name.trim()}` : "이름:", pad, Math.round(H * 0.36));
      g.fillStyle = "#475569";
      g.font = `600 ${Math.round(20 * dpr)}px sans-serif`;
      g.fillText(title.trim() ? `${title.trim()}   ·   ${dateStr}` : dateStr, pad, Math.round(H * 0.72));
      g.textAlign = "right";
      g.fillStyle = "#60a5fa";
      g.font = `800 ${Math.round(19 * dpr)}px sans-serif`;
      g.fillText("임선생의 도형학습", off.width - pad, Math.round(H * 0.5));
      g.textAlign = "left";
      // 캔버스 스냅샷을 머리글 아래에 합성
      const img = new Image();
      img.onload = () => {
        g.drawImage(img, 0, H);
        const url = off.toDataURL("image/png");
        const a = document.createElement("a");
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(
          d.getHours()
        ).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
        const safe = (name.trim() || "도형학습").replace(/[\\/:*?"<>|\s]+/g, "_");
        a.href = url;
        a.download = `${safe}-${stamp}.png`;
        a.click();
        setFlash("제출용 이미지로 저장했어요! 이름·날짜와 설명 글상자가 함께 담겼어요. 📷");
      };
      img.onerror = () => setFlash("이미지 저장에 실패했어요. 다시 시도해 주세요.");
      img.src = c.toDataURL("image/png");
    } catch {
      setFlash("이미지 저장에 실패했어요. 다시 시도해 주세요.");
    }
  }

  function confirmSave() {
    try {
      localStorage.setItem("studentName", saveName.trim());
    } catch {}
    setSaveOpen(false);
    // 편집 중이던 글상자가 캔버스에 반영된 뒤 캡처(두 번의 rAF)
    requestAnimationFrame(() => requestAnimationFrame(() => exportSubmission(saveName, saveTitle)));
  }

  // ----- 파일로 저장·불러오기 (JSON) — 학생이 다음 시간에 이어서 작업할 수 있게 -----
  function exportSaveFile() {
    try {
      const payload = {
        app: "임선생의 도형학습",
        version: 1,
        savedAt: new Date().toISOString(),
        shapes: shapes.map((s) => ({ ...s })),
        texts: texts.map((t) => ({ ...t })),
        measurements: measurements.map((m) => ({ ...m })),
        guides: guides.map((g) => ({ ...g })),
        settings: { snapStep, magnetic, integerMode, showAngles, showEdgeLen, showSymmetry, labelScale },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      a.href = url;
      a.download = `도형학습-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFlash("작업 파일로 저장했어요! 다음 시간에 '📁 열기'로 이어서 작업할 수 있어요. 💾");
    } catch {
      setFlash("파일 저장에 실패했어요. 다시 시도해 주세요.");
    }
  }
  function importSaveFile(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(String(r.result));
        if (!data || !Array.isArray(data.shapes)) {
          setFlash("파일 형식이 맞지 않아요. '도형학습-….json' 파일인지 확인해 주세요.");
          return;
        }
        commitHistory();
        setShapes(data.shapes);
        setTexts(Array.isArray(data.texts) ? data.texts : []);
        setMeasurements(Array.isArray(data.measurements) ? data.measurements : []);
        setGuides(Array.isArray(data.guides) ? data.guides : []);
        setSelectedIds([]);
        setActiveTextId(null);
        setEditingTextId(null);
        const st = data.settings || {};
        if (st.snapStep !== undefined) setSnapStep(st.snapStep);
        if (typeof st.magnetic === "boolean") setMagnetic(st.magnetic);
        if (typeof st.integerMode === "boolean") setIntegerMode(st.integerMode);
        if (typeof st.showAngles === "boolean") setShowAngles(st.showAngles);
        if (typeof st.showEdgeLen === "boolean") setShowEdgeLen(st.showEdgeLen);
        if (typeof st.showSymmetry === "boolean") setShowSymmetry(st.showSymmetry);
        if (typeof st.labelScale === "number") setLabelScale(st.labelScale);
        setFlash("작업을 불러왔어요! 이어서 진행하세요. 📁");
      } catch {
        setFlash("파일을 읽을 수 없어요. 손상됐거나 다른 앱의 파일일 수 있어요.");
      }
    };
    r.readAsText(file);
  }

  // ----- 캔버스 렌더링 -----
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { w: cw, h: ch } = sizeRef.current;
    if (!cw || !ch) return;
    const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
    const needW = Math.round(cw * dpr);
    const needH = Math.round(ch * dpr);
    if (c.width !== needW) c.width = needW;
    if (c.height !== needH) c.height = needH;
    const ctx = c.getContext("2d")!;
    const camera = camRef.current;
    const k = 1 / camera.scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#fbfcfe";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.tx, dpr * camera.ty);

    // 보이는 월드 범위
    const x0 = (0 - camera.tx) / camera.scale;
    const x1 = (cw - camera.tx) / camera.scale;
    const y0 = (0 - camera.ty) / camera.scale;
    const y1 = (ch - camera.ty) / camera.scale;
    const gx0 = Math.floor(x0 / GRID) * GRID;
    const gy0 = Math.floor(y0 / GRID) * GRID;

    // ⬜ 무격자 모드가 아닐 때만 모눈을 그림
    const bx0 = Math.floor(x0 / (GRID * 5)) * GRID * 5;
    const by0 = Math.floor(y0 / (GRID * 5)) * GRID * 5;
    if (showGrid) {
      // 모눈 (얇은 선)
      ctx.strokeStyle = "#e6ebf2";
      ctx.lineWidth = 1 * k;
      ctx.beginPath();
      for (let x = gx0; x <= x1; x += GRID) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let y = gy0; y <= y1; y += GRID) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
      // 5cm 굵은 선
      ctx.strokeStyle = "#cdd7e5";
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      for (let x = bx0; x <= x1; x += GRID * 5) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let y = by0; y <= y1; y += GRID * 5) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
      // 원점 축 강조
      ctx.strokeStyle = "#bcd0ea";
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      if (0 >= x0 && 0 <= x1) {
        ctx.moveTo(0, y0);
        ctx.lineTo(0, y1);
      }
      if (0 >= y0 && 0 <= y1) {
        ctx.moveTo(x0, 0);
        ctx.lineTo(x1, 0);
      }
      ctx.stroke();
    }

    // reference (원본 박제) 먼저 — 작업 도형 아래 레이어
    for (const s of lessonReference) drawShape(ctx, s, false, false, k);
    for (const s of shapes) drawShape(ctx, s, isSelected(s.id), s.id === mergeFirstId, k);

    // 스마트 정렬 가이드 (도형 이동 중 모서리/중심 정렬)
    if (dragRef.current.type === "translate") {
      const ag = alignGuidesRef.current;
      if (ag.vx.length || ag.hy.length) {
        ctx.save();
        ctx.setLineDash([6 * k, 6 * k]);
        ctx.strokeStyle = "#ec4899";
        ctx.lineWidth = 1.5 * k;
        ctx.beginPath();
        for (const x of ag.vx) {
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
        }
        for (const y of ag.hy) {
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // 그리는 중 도형
    if (draft.length > 0) {
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 2.5 * k;
      ctx.beginPath();
      ctx.moveTo(draft[0].x, draft[0].y);
      for (let i = 1; i < draft.length; i++) ctx.lineTo(draft[i].x, draft[i].y);
      if (hoverPt && tool === "draw") ctx.lineTo(hoverPt.x, hoverPt.y);
      ctx.stroke();
      for (const v of draft) {
        ctx.fillStyle = "#0ea5e9";
        ctx.beginPath();
        ctx.arc(v.x, v.y, 5 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      if (draft.length >= 3) {
        ctx.strokeStyle = "#0ea5e9";
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.arc(draft[0].x, draft[0].y, 10 * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 자르기 미리보기
    const dm = dragRef.current;
    if (tool === "cut" && dm.type === "cut") {
      const a = dm.start;
      const b = dm.current;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = (dx / len) * 4000;
      const ey = (dy / len) * 4000;
      ctx.save();
      ctx.setLineDash([8 * k, 6 * k]);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.moveTo(a.x - ex, a.y - ey);
      ctx.lineTo(a.x + ex, a.y + ey);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 3.5 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = "#dc2626";
      [a, b].forEach((q) => {
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6 * k, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 측정선
    const drawRuler = (a: Point, b: Point, color: string, active = false) => {
      const dist = Math.hypot(b.x - a.x, b.y - a.y) / GRID;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const tx = -dy / L;
      const ty = dx / L;
      const t = 9 * k;
      [a, b].forEach((q) => {
        ctx.beginPath();
        ctx.moveTo(q.x - tx * t, q.y - ty * t);
        ctx.lineTo(q.x + tx * t, q.y + ty * t);
        ctx.stroke();
      });
      const steps = Math.floor(L / GRID);
      ctx.lineWidth = 1.5 * k;
      for (let i = 1; i <= steps; i++) {
        const r = (i * GRID) / L;
        const px = a.x + dx * r;
        const py = a.y + dy * r;
        const small = 4 * k;
        ctx.beginPath();
        ctx.moveTo(px - tx * small, py - ty * small);
        ctx.lineTo(px + tx * small, py + ty * small);
        ctx.stroke();
      }
      const mx = (a.x + b.x) / 2 + tx * 22 * k;
      const my = (a.y + b.y) / 2 + ty * 22 * k;
      const text = fmtLen(dist);
      const f = boardMode ? 22 : 18;
      ctx.font = `bold ${f * k}px sans-serif`;
      const tw = ctx.measureText(text).width;
      const padH = 8 * k;
      const boxH = (f + 8) * k;
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * k;
      ctx.fillRect(mx - tw / 2 - padH, my - boxH / 2, tw + padH * 2, boxH);
      ctx.strokeRect(mx - tw / 2 - padH, my - boxH / 2, tw + padH * 2, boxH);
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, mx, my);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      if (active) {
        [a, b].forEach((q) => {
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(q.x, q.y, 8 * k, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5 * k;
          ctx.stroke();
        });
      }
    };
    for (const m of measurements)
      drawRuler(m.a, m.b, "#7c3aed", activeAux?.kind === "measure" && activeAux.id === m.id);
    if (tool === "measure" && dm.type === "measure") drawRuler(dm.start, dm.current, "#a855f7");

    // 가이드선
    const drawGuide = (a: Point, b: Point, color: string, active = false) => {
      ctx.save();
      ctx.setLineDash([12 * k, 8 * k]);
      ctx.strokeStyle = active ? "#2563eb" : color;
      ctx.lineWidth = (active ? 4 : 3) * k;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const ex = (dx / L) * 14 * k;
      const ey = (dy / L) * 14 * k;
      ctx.beginPath();
      ctx.moveTo(a.x - ex, a.y - ey);
      ctx.lineTo(b.x + ex, b.y + ey);
      ctx.stroke();
      ctx.restore();
      [a, b].forEach((q) => {
        if (active) {
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(q.x, q.y, 8 * k, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#2563eb";
          ctx.lineWidth = 2.5 * k;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 5 * k, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    };
    for (const g of guides) drawGuide(g.a, g.b, "#0f172a", activeAux?.kind === "guide" && activeAux.id === g.id);
    if (tool === "guide" && dm.type === "guide") drawGuide(dm.start, dm.current, "#475569");

    // 글상자(설명 메모) — 화면 크기 고정(k), 월드 앵커. 편집 중인 것은 textarea로 대체
    textBoxRef.current.clear();
    {
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      for (const t of texts) {
        const sc = t.scale ?? 1;
        const FS = 15 * labelScale * sc;
        const padX = 9 * sc * k;
        const padY = 7 * sc * k;
        const lh = FS * 1.4 * k;
        const lines = t.text.length ? t.text.split("\n") : [""];
        ctx.font = `600 ${FS * k}px sans-serif`;
        let maxw = 0;
        for (const ln of lines) maxw = Math.max(maxw, ctx.measureText(ln || " ").width);
        const boxW = maxw + padX * 2;
        const boxH = lines.length * lh + padY * 2;
        textBoxRef.current.set(t.id, { x: t.x, y: t.y, w: boxW, h: boxH });
        if (t.id === editingTextId) continue; // 편집 중이면 textarea가 보여줌
        ctx.fillStyle = "rgba(254,249,231,0.97)";
        ctx.fillRect(t.x, t.y, boxW, boxH);
        ctx.strokeStyle = t.id === activeTextId ? "#f59e0b" : "#fcd34d";
        ctx.lineWidth = (t.id === activeTextId ? 2.5 : 1.4) * k;
        ctx.strokeRect(t.x, t.y, boxW, boxH);
        ctx.fillStyle = t.color;
        lines.forEach((ln, i) => ctx.fillText(ln, t.x + padX, t.y + padY + i * lh));
        // 선택된 글상자: 오른쪽 아래 크기 조절 손잡이 + 이동 안내
        if (t.id === activeTextId) {
          const hs = 13 * k; // 손잡이 크기
          // 오른쪽 아래 모서리에 중심을 둠(절반은 상자 밖) — 본문 글자를 가리지 않게
          const hx = t.x + boxW - hs / 2;
          const hy = t.y + boxH - hs / 2;
          ctx.fillStyle = "#f59e0b";
          ctx.beginPath();
          // 둥근 모서리 손잡이
          const r = 3 * k;
          ctx.moveTo(hx + r, hy);
          ctx.arcTo(hx + hs, hy, hx + hs, hy + hs, r);
          ctx.arcTo(hx + hs, hy + hs, hx, hy + hs, r);
          ctx.arcTo(hx, hy + hs, hx, hy, r);
          ctx.arcTo(hx, hy, hx + hs, hy, r);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.6 * k;
          ctx.beginPath();
          ctx.moveTo(hx + hs * 0.28, hy + hs * 0.72);
          ctx.lineTo(hx + hs * 0.72, hy + hs * 0.28);
          ctx.moveTo(hx + hs * 0.5, hy + hs * 0.74);
          ctx.lineTo(hx + hs * 0.74, hy + hs * 0.5);
          ctx.stroke();
        }
      }
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    // 모눈 눈금 숫자 (화면 가장자리에 고정 = 자 느낌) — 무격자 모드에서는 숨김
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (showGrid) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = `bold ${boardMode ? 14 : 12}px sans-serif`;
      ctx.textBaseline = "top";
      for (let x = bx0; x <= x1; x += GRID * 5) {
        const sx = x * camera.scale + camera.tx;
        if (sx >= 16 && sx <= cw - 4) ctx.fillText(`${Math.round(x / GRID)}`, sx + 3, 3);
      }
      ctx.textBaseline = "alphabetic";
      for (let y = by0; y <= y1; y += GRID * 5) {
        const sy = y * camera.scale + camera.ty;
        if (sy >= 14 && sy <= ch - 4) ctx.fillText(`${Math.round(y / GRID)}`, 4, sy + 4);
      }
    }
  }, [shapes, draft, hoverPt, selectedIds, inspectId, mergeFirstId, tool, cam, size, measurements, guides, texts, editingTextId, activeTextId, boardMode, activeAux, showAreaBadge, gridCountMode, showGrid, showAngles, showEdgeLen, showSymmetry, labelScale, piMode, lessonReference, quiz]);

  // 선대칭도형의 대칭축을 도형 폭보다 조금 더 길게 점선으로 그림
  function drawSymmetryAxes(
    ctx: CanvasRenderingContext2D,
    s: Shape,
    k: number,
    circleDef: { circle: number } | null
  ) {
    const c = polygonCentroid(s.points);
    // 도형 바운딩 반지름 (표시 길이 결정)
    const bbR = Math.max(...s.points.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) * 1.15;
    const drawLine = (angle: number) => {
      const dx = Math.cos(angle) * bbR;
      const dy = Math.sin(angle) * bbR;
      ctx.beginPath();
      ctx.moveTo(c.x - dx, c.y - dy);
      ctx.lineTo(c.x + dx, c.y + dy);
      ctx.stroke();
    };
    ctx.save();
    ctx.setLineDash([8 * k, 5 * k]);
    ctx.strokeStyle = "#ec4899cc";
    ctx.lineWidth = 1.8 * k;
    if (circleDef) {
      // 원 — 대표 4개 대칭축(수직·수평·대각선 2)
      drawLine(0);
      drawLine(Math.PI / 2);
      drawLine(Math.PI / 4);
      drawLine(-Math.PI / 4);
    } else if (s.defKind === "rhombus" && s.points.length === 4) {
      // 마름모 — 두 대각선
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      ctx.lineTo(s.points[2].x, s.points[2].y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.points[1].x, s.points[1].y);
      ctx.lineTo(s.points[3].x, s.points[3].y);
      ctx.stroke();
    } else if (typeof s.defKind === "object" && s.defKind !== null && "regular" in s.defKind) {
      // 정n각형 — n개 축 (n 짝수: 마주보는 꼭짓점, 마주보는 변 중점)
      const n = s.defKind.regular;
      const a0 = Math.atan2(s.points[0].y - c.y, s.points[0].x - c.x);
      if (n % 2 === 0) {
        // 짝수: 꼭짓점 축 n/2개 + 변 중점 축 n/2개
        for (let i = 0; i < n / 2; i++) drawLine(a0 + (i * Math.PI) / (n / 2));
        for (let i = 0; i < n / 2; i++) drawLine(a0 + Math.PI / n + (i * Math.PI) / (n / 2));
      } else {
        // 홀수: n개 축 각각 꼭짓점 → 반대편 변 중점
        for (let i = 0; i < n; i++) drawLine(a0 + (i * Math.PI) / n);
      }
    } else if (s.points.length === 4) {
      // 축평행 직사각형 자동 감지(대략): 두 변이 평행하고 인접 변이 수직인지 확인
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const xSet = new Set(xs.map((v) => Math.round(v * 100)));
      const ySet = new Set(ys.map((v) => Math.round(v * 100)));
      if (xSet.size === 2 && ySet.size === 2) {
        // 축평행 사각형 → 두 축(수평 중심, 수직 중심)
        drawLine(0);
        drawLine(Math.PI / 2);
      }
    }
    ctx.restore();
  }
  function drawShape(
    ctx: CanvasRenderingContext2D,
    s: Shape,
    isSelected: boolean,
    isMergeFirst: boolean,
    k: number
  ) {
    if (s.points.length < 2) return;
    const isRef = !!s.isReference;
    // 원(defKind.circle)은 매끄러운 호로 렌더링 (다각형 근사 대신)
    const circleDef = typeof s.defKind === "object" && s.defKind !== null && "circle" in s.defKind ? s.defKind : null;
    // 곡선형 도형: 원이거나, 꼭짓점이 아주 많은 조각(원을 잘라 만든 반원 등)
    //   → 개별 꼭짓점 점·변 길이 라벨을 숨기고 매끄럽게 보이도록 처리
    const isCurvy = !!circleDef || s.points.length >= 20;
    if (circleDef) {
      const c = polygonCentroid(s.points);
      const R = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / s.points.length;
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.closePath();
    }
    ctx.fillStyle = isMergeFirst ? "#f59e0b55" : isRef ? s.color + "22" : s.color + "55";
    ctx.fill();

    // 칸세기 모드: 어떤 도형이든 '꽉 찬 칸/걸친 칸'을 덮어 세기 쉽게 (넓이 어림)
    // 색칠은 도형 외곽선으로 클립해 '딱 도형만큼만' 칠해지도록 함
    const gcCells = gridCountMode && !isRef ? gridCountCells(s.points) : null;
    if (gcCells) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.closePath();
      ctx.clip(); // 이후 칠·격자선은 도형 안쪽만 보임
      // 걸친 칸: 연한 색(도형 안쪽 부분만 칠해짐), 꽉 찬 칸: 진한 색
      ctx.fillStyle = s.color + "26";
      for (const c of gcCells.partial) ctx.fillRect(c.x, c.y, GRID, GRID);
      ctx.fillStyle = s.color + "66";
      for (const c of gcCells.full) ctx.fillRect(c.x, c.y, GRID, GRID);
      // 칸 격자선 (도형 안쪽만 보이도록 클립됨) — 세기 보조
      ctx.strokeStyle = s.color + "88";
      ctx.lineWidth = 1 * k;
      for (const c of gcCells.full) ctx.strokeRect(c.x, c.y, GRID, GRID);
      for (const c of gcCells.partial) ctx.strokeRect(c.x, c.y, GRID, GRID);
      ctx.restore();
    }

    // 격자 칸 채우기 시각화 (선택된 축평행 직각 다각형: 직사각형·ㄴ자·십자) — 넓이 = 칸 수
    const rectDims = !gridCountMode && isSelected && !isRef ? axisAlignedRect(s.points) : null;
    const cells = !gridCountMode && isSelected && !isRef ? gridCells(s.points) : null;
    let cellInfo: { cols: number; rows: number } | null = null;
    let cellCount: number | null = null;
    if (cells) {
      for (const c of cells) {
        const gi = Math.round(c.x / GRID);
        const gj = Math.round(c.y / GRID);
        ctx.fillStyle = (gi + gj) % 2 === 0 ? s.color + "33" : s.color + "1f";
        ctx.fillRect(c.x, c.y, GRID, GRID);
      }
      ctx.strokeStyle = s.color + "aa";
      ctx.lineWidth = 1 * k;
      for (const c of cells) ctx.strokeRect(c.x, c.y, GRID, GRID);
      cellCount = cells.length;
      if (rectDims) {
        const cols = Math.round(rectDims.w / GRID);
        const rows = Math.round(rectDims.h / GRID);
        if (cols * rows === cells.length) cellInfo = { cols, rows };
      }
    }

    if (s.ghosts && s.ghosts.length > 1) {
      ctx.save();
      ctx.setLineDash([7 * k, 5 * k]);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.45)";
      ctx.lineWidth = 1.5 * k;
      for (const g of s.ghosts) {
        if (g.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(g[0].x, g[0].y);
        for (let i = 1; i < g.length; i++) ctx.lineTo(g[i].x, g[i].y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.beginPath();
    if (circleDef) {
      const c = polygonCentroid(s.points);
      const R = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / s.points.length;
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    } else {
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    }
    ctx.closePath();
    ctx.save();
    if (isRef) ctx.setLineDash([10 * k, 6 * k]);
    ctx.strokeStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : isRef ? s.color + "cc" : s.color;
    ctx.lineWidth = (isMergeFirst || isSelected ? 3.5 : isRef ? 2 : 2.5) * k;
    ctx.stroke();
    ctx.restore();

    // 🪞 대칭축 표시 — 선대칭도형의 대칭축 자동 감지 후 점선 표시
    if (showSymmetry && !isRef) {
      drawSymmetryAxes(ctx, s, k, circleDef);
    }

    // 원본 박제 워터마크 라벨
    if (isRef) {
      ctx.font = `bold ${(boardMode ? 16 : 13) * k}px sans-serif`;
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "center";
      const minY = Math.min(...s.points.map((p) => p.y));
      ctx.fillText("💎 원본 (비교용)", polygonCentroid(s.points).x, minY - 12 * k);
      ctx.textAlign = "start";
    }

    // 원: 반지름 선 표시 + '반지름 Ncm' 라벨 (선택 시)
    if (isSelected && selectedIds.length === 1 && circleDef && !isRef) {
      const c = polygonCentroid(s.points);
      const R = s.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / s.points.length;
      ctx.save();
      ctx.setLineDash([6 * k, 4 * k]);
      ctx.strokeStyle = "#0284c7";
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + R, c.y);
      ctx.stroke();
      ctx.restore();
      // 중심점
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3 * k, 0, Math.PI * 2);
      ctx.fill();
      // 반지름 라벨
      const rText = fmtLen(R / GRID);
      const rf = (boardMode ? 16 : 13) * labelScale;
      ctx.font = `bold ${rf * k}px sans-serif`;
      const rtxt = `반지름 ${rText}`;
      const rw = ctx.measureText(rtxt).width;
      const rp = 5 * k;
      const rh = rf * k + 6 * k;
      const rlabX = c.x + R / 2;
      const rlabY = c.y - 12 * k;
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.strokeStyle = "#0284c7";
      ctx.lineWidth = 1.4 * k;
      ctx.fillRect(rlabX - rw / 2 - rp, rlabY - rh / 2, rw + rp * 2, rh);
      ctx.strokeRect(rlabX - rw / 2 - rp, rlabY - rh / 2, rw + rp * 2, rh);
      ctx.fillStyle = "#075985";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(rtxt, rlabX, rlabY);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // 마름모: 둘러싼 직사각형(두 변 = 두 대각선) + 두 대각선 표시
    //   → 마름모 넓이가 이 직사각형 넓이의 '절반'임을 눈으로 보여줌
    //   (넓이 모드가 켜진 단일 선택 마름모에서만)
    if (
      isSelected &&
      selectedIds.length === 1 &&
      s.defKind === "rhombus" &&
      s.points.length === 4 &&
      showAreaBadge &&
      !isRef
    ) {
      const c = polygonCentroid(s.points);
      const [p0, p1, p2, p3] = s.points;
      const d1x = p2.x - p0.x, d1y = p2.y - p0.y; // 대각선 1 (p0→p2)
      const d2x = p3.x - p1.x, d2y = p3.y - p1.y; // 대각선 2 (p1→p3)
      const len1 = Math.hypot(d1x, d1y);
      const len2 = Math.hypot(d2x, d2y);
      if (len1 > 1 && len2 > 1) {
        const u1x = d1x / len1, u1y = d1y / len1;
        const u2x = d2x / len2, u2y = d2y / len2;
        const h1 = len1 / 2, h2 = len2 / 2;
        // 직사각형 네 꼭짓점 = 중심 ± (h1·대각선1방향) ± (h2·대각선2방향)
        //   → 마름모 꼭짓점은 이 직사각형 각 변의 '중점'에 놓임
        const corners = [
          { x: c.x - h1 * u1x - h2 * u2x, y: c.y - h1 * u1y - h2 * u2y },
          { x: c.x + h1 * u1x - h2 * u2x, y: c.y + h1 * u1y - h2 * u2y },
          { x: c.x + h1 * u1x + h2 * u2x, y: c.y + h1 * u1y + h2 * u2y },
          { x: c.x - h1 * u1x + h2 * u2x, y: c.y - h1 * u1y + h2 * u2y },
        ];
        ctx.save();
        // 둘러싼 직사각형 (연보라 점선)
        ctx.setLineDash([7 * k, 5 * k]);
        ctx.strokeStyle = "#7c3aedcc";
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.stroke();
        // 두 대각선 (실선, 연보라)
        ctx.setLineDash([]);
        ctx.strokeStyle = "#7c3aed88";
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p3.x, p3.y); ctx.stroke();
        ctx.restore();
        // 두 변 라벨: 직사각형 변 = 대각선 길이
        const drawDiagLabel = (
          text: string,
          mx: number,
          my: number,
          nx: number,
          ny: number // 바깥쪽 방향(단위벡터)
        ) => {
          const f = (boardMode ? 15 : 12) * labelScale;
          ctx.font = `bold ${f * k}px sans-serif`;
          const w = ctx.measureText(text).width;
          const pad = 5 * k;
          const bh = f * k + 6 * k;
          const off = 14 * k;
          const lx = mx + nx * off;
          const ly = my + ny * off;
          ctx.fillStyle = "rgba(255,255,255,0.96)";
          ctx.strokeStyle = "#7c3aed";
          ctx.lineWidth = 1.3 * k;
          ctx.fillRect(lx - w / 2 - pad, ly - bh / 2, w + pad * 2, bh);
          ctx.strokeRect(lx - w / 2 - pad, ly - bh / 2, w + pad * 2, bh);
          ctx.fillStyle = "#6d28d9";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text, lx, ly);
          ctx.textAlign = "start";
          ctx.textBaseline = "alphabetic";
        };
        // 변 corners[0]-corners[1] (길이=대각선1), 중점=c-h2·u2, 바깥=-u2
        drawDiagLabel(
          `대각선 ${fmtLen(len1 / GRID)}`,
          c.x - h2 * u2x, c.y - h2 * u2y,
          -u2x, -u2y
        );
        // 변 corners[1]-corners[2] (길이=대각선2), 중점=c+h1·u1, 바깥=+u1
        drawDiagLabel(
          `대각선 ${fmtLen(len2 / GRID)}`,
          c.x + h1 * u1x, c.y + h1 * u1y,
          u1x, u1y
        );
      }
    }

    // 회전 손잡이(점선+초록 원) — 단일 선택일 때만 (원에는 표시 안 함)
    if (isSelected && selectedIds.length === 1 && !circleDef) {
      const c = polygonCentroid(s.points);
      const h = rotationHandle(s, k);
      ctx.save();
      ctx.setLineDash([8 * k, 6 * k]);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(h.x, h.y, 12 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#065f46";
      ctx.lineWidth = 2 * k;
      ctx.stroke();
    }

    // 변 길이 라벨 (labelScale = 수업용 글자 크기 배율). 원은 개별 변 없음
    const baseFont = (boardMode ? 20 : 16) * labelScale;
    ctx.font = `bold ${baseFont * k}px sans-serif`;
    const cx0 = polygonCentroid(s.points);
    for (let i = 0; i < s.points.length && !isCurvy; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const L = Math.hypot(ex, ey) || 1;
      // 화면에서 변이 너무 짧으면(줌아웃·작은 도형) 라벨을 생략해 겹침 방지 — 줌인하면 다시 표시
      if (L / k < 40 * labelScale) continue;
      const nA = { x: -ey / L, y: ex / L };
      const nB = { x: ey / L, y: -ex / L };
      const toCx = { x: cx0.x - mx, y: cx0.y - my };
      const out = nA.x * toCx.x + nA.y * toCx.y > 0 ? nB : nA;
      const off = 18 * k;
      const tx0 = mx + out.x * off;
      const ty0 = my + out.y * off;
      const len = Math.hypot(b.x - a.x, b.y - a.y) / GRID;
      const text = fmtLen(len);
      const tw = ctx.measureText(text).width;
      const padH = 5 * k;
      const padV = 4 * k;
      const boxH = baseFont * k + padV * 2;
      // 변 길이(cm) 박스 — '변길이' 토글이 켜져 있고, 라벨이 변 길이 안에 '들어갈' 때만
      //   (줌아웃하면 자동으로 정돈되고, 줌인하면 다시 나타남 — 라벨 무더기 방지)
      const drawLenBox = showEdgeLen && !gridCountMode && L >= (tw + 20 * k) * 1.5;
      if (drawLenBox) {
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5 * k;
        ctx.fillRect(tx0 - tw / 2 - padH, ty0 - boxH / 2, tw + padH * 2, boxH);
        ctx.strokeRect(tx0 - tw / 2 - padH, ty0 - boxH / 2, tw + padH * 2, boxH);
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, tx0, ty0);
      }

      // 의미 라벨 (학습 모드) — "윗변", "대각선 절반" 등.
      // 칸세기 모드에서는 cm 길이를 우선하고 의미 라벨은 숨겨 겹침을 줄임.
      const meaning = !gridCountMode ? s.edgeLabels?.[i] : undefined;
      if (meaning) {
        const mf = (boardMode ? 14 : 12) * labelScale * k;
        ctx.font = `bold ${mf}px sans-serif`;
        const mw = ctx.measureText(meaning).width;
        // 의미 라벨도 변 길이 안에 들어갈 때만 (줌아웃 시 겹침 방지)
        if (L >= (mw + 20 * k) * 1.5) {
          const mpx = 6 * k;
          const mpy = 3 * k;
          const mbh = mf + mpy * 2;
          const mty = drawLenBox ? ty0 + boxH / 2 + mbh / 2 + 3 * k : ty0;
          ctx.fillStyle = "#fef3c7";
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 1.2 * k;
          ctx.fillRect(tx0 - mw / 2 - mpx, mty - mbh / 2, mw + mpx * 2, mbh);
          ctx.strokeRect(tx0 - mw / 2 - mpx, mty - mbh / 2, mw + mpx * 2, mbh);
          ctx.fillStyle = "#92400e";
          ctx.fillText(meaning, tx0, mty);
        }
        ctx.font = `bold ${baseFont * k}px sans-serif`;
      }
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    // 곡선형(원·원 조각)은 꼭짓점 점을 표시하지 않음 — 톱니처럼 보이지 않게
    if (!isCurvy) {
      for (const v of s.points) {
        ctx.fillStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : s.color;
        ctx.beginPath();
        ctx.arc(v.x, v.y, (isSelected || isMergeFirst ? 6 : 4) * k, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 점 추가 핸들: 단일 선택+선택도구일 때 각 변 가운데 '+' (눌러서 꼭짓점 추가)
    //   원은 꼭짓점이 없으므로 이 핸들을 표시하지 않음
    if (isSelected && selectedIds.length === 1 && !isRef && tool === "select" && s.points.length < 16 && !circleDef) {
      for (let i = 0; i < s.points.length; i++) {
        const a = s.points[i];
        const b = s.points[(i + 1) % s.points.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) / k < 38) continue; // 너무 짧은 변은 생략
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.beginPath();
        ctx.arc(mx, my, 7 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#10b981";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(mx - 3.5 * k, my);
        ctx.lineTo(mx + 3.5 * k, my);
        ctx.moveTo(mx, my - 3.5 * k);
        ctx.lineTo(mx, my + 3.5 * k);
        ctx.stroke();
      }
    }

    // 꼭짓점 삭제 배지: 단일 선택+선택도구, 점 4개 이상일 때 각 꼭짓점 바깥에 '➖'(탭하면 삭제)
    if (isSelected && selectedIds.length === 1 && !isRef && tool === "select" && !circleDef && s.points.length > 3) {
      const cen = polygonCentroid(s.points);
      for (let i = 0; i < s.points.length; i++) {
        const v = s.points[i];
        const ox = v.x - cen.x, oy = v.y - cen.y;
        const ol = Math.hypot(ox, oy) || 1;
        const bx = v.x + (ox / ol) * 22 * k;
        const by = v.y + (oy / ol) * 22 * k;
        ctx.beginPath();
        ctx.arc(bx, by, 7 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#ef4444";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(bx - 3.5 * k, by);
        ctx.lineTo(bx + 3.5 * k, by);
        ctx.stroke();
      }
    }

    if (isMergeFirst) {
      ctx.fillStyle = "#d97706";
      ctx.font = `bold ${16 * k}px sans-serif`;
      ctx.fillText("1️⃣", s.points[0].x - 10 * k, s.points[0].y - 14 * k);
    }

    // 각도 표시: 내각 + (선택 시) 삼각형 분할로 내각의 합 유도 — 원은 제외
    if (showAngles && !isRef && s.points.length >= 3 && !circleDef) {
      const pts = s.points;
      const n = pts.length;
      // 한 꼭짓점에서 대각선을 그어 (n-2)개 삼각형으로 분할 (선택된 도형만)
      if (isSelected && n >= 4) {
        ctx.save();
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.strokeStyle = "#7c3aed88";
        ctx.lineWidth = 1.5 * k;
        for (let i = 2; i < n - 1; i++) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }
      const angs = interiorAnglesDeg(pts);
      const cen = polygonCentroid(pts);
      for (let i = 0; i < n; i++) {
        const cur = pts[i];
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        const d1 = { x: prev.x - cur.x, y: prev.y - cur.y };
        const d2 = { x: next.x - cur.x, y: next.y - cur.y };
        const l1 = Math.hypot(d1.x, d1.y) || 1;
        const l2 = Math.hypot(d2.x, d2.y) || 1;
        // 화면에서 두 변이 너무 짧으면 생략
        if (Math.min(l1, l2) / k < 34) continue;
        let bx = d1.x / l1 + d2.x / l2;
        let by = d1.y / l1 + d2.y / l2;
        let bl = Math.hypot(bx, by);
        if (bl < 1e-3) {
          bx = -d1.y / l1;
          by = d1.x / l1;
          bl = 1;
        }
        // 내부(중심) 방향으로
        const toC = { x: cen.x - cur.x, y: cen.y - cur.y };
        if (bx * toC.x + by * toC.y < 0) {
          bx = -bx;
          by = -by;
        }
        bx /= bl;
        by /= bl;
        // 작은 호
        const r = 16 * k;
        const a1 = Math.atan2(d1.y, d1.x);
        const a2 = Math.atan2(d2.y, d2.x);
        const bisA = Math.atan2(by, bx);
        const normA = (x: number) => {
          let v = x;
          while (v <= -Math.PI) v += 2 * Math.PI;
          while (v > Math.PI) v -= 2 * Math.PI;
          return v;
        };
        let dArc = normA(a2 - a1);
        const midCCW = a1 + dArc / 2;
        if (Math.abs(normA(midCCW - bisA)) > Math.PI / 2) dArc = dArc > 0 ? dArc - 2 * Math.PI : dArc + 2 * Math.PI;
        ctx.beginPath();
        ctx.arc(cur.x, cur.y, r, a1, a1 + dArc, dArc < 0);
        ctx.strokeStyle = "#7c3aed";
        ctx.lineWidth = 2 * k;
        ctx.stroke();
        // 각도 라벨
        const tx = cur.x + bx * 30 * k;
        const ty = cur.y + by * 30 * k;
        const txt = `${Math.round(angs[i])}°`;
        ctx.font = `bold ${12 * labelScale * k}px sans-serif`;
        const tw = ctx.measureText(txt).width;
        const ph = 4 * k;
        const bh = 12 * labelScale * k + ph * 2;
        ctx.fillStyle = "rgba(124,58,237,0.95)";
        ctx.fillRect(tx - tw / 2 - 4 * k, ty - bh / 2, tw + 8 * k, bh);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(txt, tx, ty);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
    }

    // 중앙 라벨: 칸 수(격자 시각화) 또는 넓이 배지 — 회전 점선 위에 그려 가독성 확보
    // ⚠️ 문제 모드(quizHiding)에서는 칸 수·넓이를 숨겨 직접 세도록 함(칸 채우기는 보조로 유지)
    const quizHiding = !!quiz && quiz.index < quiz.problems.length && quiz.result !== "correct" && quiz.result !== "shown";
    const inspecting = inspectId === s.id && !!s.ghosts && s.ghosts.length > 1;
    // 화면에서 도형이 너무 작으면 중앙 라벨(넓이·칸 수)을 생략해 겹침 방지 — 줌인하면 다시 표시
    const bb = boundsOf(s.points);
    const tooSmallForBadge = (bb.maxX - bb.minX) / k < 48 || (bb.maxY - bb.minY) / k < 34;
    // 칸세기 모드: 꽉 찬 칸/걸친 칸 개수를 보여줘 어림하게 (정확한 넓이는 숨김)
    const gcLabel = gcCells && !quizHiding ? `🟩 꽉 ${gcCells.full.length} · 걸친 ${gcCells.partial.length}칸` : null;
    const isCellLabel = !!cellInfo || cellCount != null || !!gcLabel;
    const centerLabel = tooSmallForBadge
      ? null
      : inspecting
      ? null
      : gcLabel
      ? gcLabel
      : quizHiding
      ? null
      : cellInfo
      ? `${cellInfo.cols} × ${cellInfo.rows} = ${cellInfo.cols * cellInfo.rows}칸`
      : cellCount != null
      ? `= ${cellCount}칸`
      : showAreaBadge
      ? circleDef
        ? (() => {
            // 원: 다각형 근사값 대신 정확한 πr²로 표기(정보 카드와 일치)
            const cc = polygonCentroid(s.points);
            const rr = s.points.reduce((sum, q) => sum + Math.hypot(q.x - cc.x, q.y - cc.y), 0) / s.points.length / GRID;
            return fmtArea(piMode * rr * rr);
          })()
        : fmtArea(polygonArea(s.points) / (GRID * GRID))
      : null;
    if (centerLabel) {
      const lf = (isCellLabel ? (boardMode ? 19 : 16) : boardMode ? 17 : 14) * labelScale * k;
      ctx.font = `bold ${lf}px sans-serif`;
      const tw = ctx.measureText(centerLabel).width;
      const padH = 8 * k;
      const boxH = lf + 9 * k;
      const bx = cx0.x - tw / 2 - padH;
      const by = cx0.y - boxH / 2;
      const bw = tw + padH * 2;
      if (isCellLabel) {
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2 * k;
        ctx.fillRect(bx, by, bw, boxH);
        ctx.strokeRect(bx, by, bw, boxH);
        ctx.fillStyle = "#0f172a";
      } else {
        ctx.fillStyle = s.color;
        ctx.fillRect(bx, by, bw, boxH);
        ctx.fillStyle = "#ffffff";
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(centerLabel, cx0.x, cx0.y);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // 조각 보기: 합쳐진 도형 속 원본 조각들을 색으로 구분하고 번호·넓이를 표시
    if (inspecting && s.ghosts) {
      s.ghosts.forEach((g, gi) => {
        if (g.length < 3) return;
        const col = COLORS[gi % COLORS.length];
        ctx.beginPath();
        ctx.moveTo(g[0].x, g[0].y);
        for (let i = 1; i < g.length; i++) ctx.lineTo(g[i].x, g[i].y);
        ctx.closePath();
        ctx.fillStyle = col + "77";
        ctx.fill();
        ctx.setLineDash([]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5 * k;
        ctx.stroke();
        const gc = polygonCentroid(g);
        const label = `${gi + 1} · ${fmtArea(polygonArea(g) / (GRID * GRID))}`;
        ctx.font = `bold ${(boardMode ? 16 : 13) * k}px sans-serif`;
        const tw = ctx.measureText(label).width;
        const padH = 7 * k;
        const boxH = (boardMode ? 16 : 13) * k + 8 * k;
        ctx.fillStyle = col;
        ctx.fillRect(gc.x - tw / 2 - padH, gc.y - boxH / 2, tw + padH * 2, boxH);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, gc.x, gc.y);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      });
    }
  }

  const totalArea = useMemo(
    () => shapes.filter((s) => !s.isReference).reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0),
    [shapes]
  );
  const totalPeri = useMemo(
    () => shapes.filter((s) => !s.isReference).reduce((a, s) => a + displayPerimeterCm(s.points), 0),
    [shapes]
  );

  const cursorClass =
    spaceRef.current
      ? "cursor-grab"
      : tool === "draw" || tool === "cut" || tool === "measure" || tool === "guide"
      ? "cursor-crosshair"
      : tool === "delete"
      ? "cursor-pointer"
      : "cursor-default";

  return (
    <div ref={wrapRef} className="relative h-full w-full select-none overflow-hidden bg-[#fbfcfe]">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${cursorClass}`}
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />

      {/* 글상자 편집 (textarea 오버레이) */}
      {editingTextId &&
        (() => {
          const note = texts.find((n) => n.id === editingTextId);
          if (!note) return null;
          const sx = note.x * cam.scale + cam.tx;
          const sy = note.y * cam.scale + cam.ty;
          const fs = 15 * labelScale * (note.scale ?? 1);
          const lines = Math.max(1, note.text.split("\n").length);
          return (
            <textarea
              ref={textAreaRef}
              autoFocus
              value={note.text}
              onChange={(e) => updateText(editingTextId, e.target.value)}
              onBlur={finishEditingText}
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              rows={lines}
              placeholder="설명을 써요…"
              style={{
                position: "absolute",
                left: sx,
                top: sy,
                fontSize: fs,
                lineHeight: 1.4,
                width: "min(60vw, 260px)",
                fontWeight: 600,
              }}
              className="z-30 resize-none overflow-hidden rounded border-2 border-amber-400 bg-amber-50 px-[9px] py-[7px] text-amber-900 shadow-lg outline-none"
            />
          );
        })()}

      {/* 회전 각도 배지 */}
      {rotInfo && (
        <div
          className={`pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 text-sm font-extrabold shadow-lg ring-2 ${
            rotInfo.snapped ? "bg-emerald-500 text-white ring-emerald-200" : "bg-slate-800 text-white ring-slate-300"
          }`}
          style={{ left: rotInfo.sx, top: rotInfo.sy }}
        >
          {rotInfo.snapped ? "🧲 " : "↻ "}
          {Math.abs(rotInfo.deg)}°
        </div>
      )}

      {/* 제출용 저장 대화상자 */}
      {saveOpen && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm" onClick={() => setSaveOpen(false)}>
          <div className="w-[min(92vw,380px)] rounded-2xl border-2 border-sky-200 bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-base font-extrabold text-sky-700">📤 제출하기 (이미지로 저장)</div>
            <div className="mb-3 text-xs leading-relaxed text-slate-500">도형과 <b>글상자 설명</b>이 이미지 한 장에 담겨요. 이름을 적으면 위쪽에 함께 저장돼요.</div>
            <label className="mb-1 block text-xs font-bold text-slate-600">이름</label>
            <input
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") confirmSave();
              }}
              placeholder="예: 5학년 3반 임하준"
              className="mb-3 w-full rounded-lg border-2 border-slate-300 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-sky-500"
            />
            <label className="mb-1 block text-xs font-bold text-slate-600">제목·메모 <span className="font-normal text-slate-400">(선택)</span></label>
            <input
              value={saveTitle}
              onChange={(e) => setSaveTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") confirmSave();
              }}
              placeholder="예: 사다리꼴을 평행사변형으로 바꾸기"
              className="mb-4 w-full rounded-lg border-2 border-slate-300 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-sky-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setSaveOpen(false)} className="rounded-lg px-3 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">취소</button>
              <button onClick={confirmSave} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-sky-700">💾 저장하기</button>
            </div>
          </div>
        </div>
      )}

      {/* 빈 화면 안내 — 좁은 화면에서는 왼쪽 도구 레일에 가리지 않게 오른쪽으로 비켜 배치 */}
      {shapes.length === 0 && draft.length === 0 && texts.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pl-[84px] pr-2 sm:px-0">
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-slate-200 bg-white/80 px-8 py-7 text-center shadow-xl backdrop-blur">
            <div className="text-4xl">📐✨</div>
            <div className="text-lg font-bold text-slate-800">다각형 체험을 시작해 볼까요?</div>
            <div className="text-sm leading-relaxed text-slate-500">
              왼쪽 <b>도구</b>로 직접 그리거나, 아래 버튼으로 기본 도형을 불러와요. 휠/손가락으로 자유롭게 확대·이동할 수 있어요.
            </div>
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => setDrawer("shapes")}
                className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white shadow hover:bg-slate-800"
              >
                📐 도형 추가
              </button>
              <button
                onClick={() => setDrawer("scenarios")}
                className="whitespace-nowrap rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-bold text-indigo-700 hover:bg-indigo-100"
              >
                📚 학습 예시
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 상단 바 */}
      {!boardMode && (
        <div ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-2 sm:p-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-lg backdrop-blur sm:px-3">
            <span className="whitespace-nowrap text-base font-extrabold tracking-tight text-slate-800">📐 <span className="hidden sm:inline">임선생의 도형학습</span></span>
            <span className="hidden text-xs text-slate-400 xl:inline">초등 5학년 · 둘레와 넓이</span>
            <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" />
            <DrawerToggle active={drawer === "shapes"} onClick={() => setDrawer(drawer === "shapes" ? null : "shapes")} icon="📐" label="도형 추가" />
            <DrawerToggle active={drawer === "scenarios"} onClick={() => setDrawer(drawer === "scenarios" ? null : "scenarios")} icon="📚" label="학습 예시" />
            <a
              href="/3d"
              title="입체도형(3D) 체험실로"
              className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-xs font-bold text-indigo-700 transition hover:bg-indigo-100 sm:px-2.5"
            >
              🧊 <span className="hidden sm:inline">입체도형</span>
            </a>
          </div>

          <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-lg backdrop-blur">
              <span className="hidden px-0.5 text-[11px] font-bold text-slate-400 lg:inline" title="모눈 칸 간격: 도형을 움직일 때 이 간격에 맞춰 딱 맞게 붙어요">격자</span>
              <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
                {([1, 0.5, 0] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSnapStep(s)}
                    disabled={integerMode && s !== 1}
                    title={
                      integerMode && s !== 1
                        ? "자연수 모드에서는 1칸으로 고정돼요"
                        : s === 0
                        ? "격자 맞춤 끄기 (자유롭게 이동)"
                        : `${s}칸 단위로 딱 맞게 이동`
                    }
                    className={`rounded-md px-1.5 py-1 text-xs font-semibold transition ${
                      snapStep === s ? "bg-white text-slate-900 shadow" : "text-slate-500 hover:text-slate-800"
                    } ${integerMode && s !== 1 ? "opacity-40" : ""}`}
                  >
                    {s === 0 ? "끄기" : s}
                  </button>
                ))}
              </div>
              <Chip active={magnetic} onClick={() => setMagnetic(!magnetic)} icon="🧲" label="자석" title="자석: 도형 변·꼭짓점이 가까워지면 착 달라붙어요 (합치기에 편해요)" />
              <Chip
                active={integerMode}
                onClick={() => {
                  if (learnMode) { setFlash("🎓 학습모드에서는 자연수 모드가 항상 켜져 있어요"); return; }
                  setIntegerMode(!integerMode);
                }}
                icon="🔒"
                label="자연수"
                title="자연수 모드: 모든 꼭짓점이 모눈 교차점(정수 cm)에만 놓이도록 강제. 격자 1cm 고정."
              />
              <Chip
                active={alphaMode}
                onClick={() => {
                  if (learnMode) { setFlash("🎓 학습모드에서는 딱맞춤이 항상 켜져 있어요"); return; }
                  setAlphaMode(!alphaMode);
                }}
                icon="🎯"
                label="딱맞춤"
                title="딱맞춤(알파) 모드: 넓이가 소수로 떨어지는 도형을 초등 학습에 맞게 ①모든 꼭짓점을 격자 교차점에 올리고 ②넓이가 정수가 되도록 자동 보정해요. 등변·등각으로 만들 때 자동 적용되고, 도형을 고르면 넓이 옆 '🎯 넓이 딱 맞추기' 버튼으로 언제든 맞출 수 있어요."
              />
              <Chip
                active={learnMode}
                onClick={toggleLearnMode}
                icon="🎓"
                label="학습모드"
                tone="sky"
                title="학습모드: 정해진(정합적인) 값들로만 학습하도록 안내해요 — ①자연수·딱맞춤 항상 켜짐 ②회전은 90°씩(격자 유지) ③도형을 만들거나 꼭짓점을 놓으면 변 길이·넓이가 딱 떨어지는 모양으로 자동으로 맞춰져요(예: 밑변 16 삼각형 → 17·17·16). 끄면 자유모드!"
              />
              <Chip active={showAreaBadge} onClick={() => setShowAreaBadge(!showAreaBadge)} icon="🔢" label="넓이" title="넓이 표시: 도형 가운데에 넓이(cm²)를 보여줄지 켜고 끄기" />
              <Chip active={gridCountMode} onClick={() => setGridCountMode(!gridCountMode)} icon="▦" label="칸세기" title="칸세기 모드(G): 어떤 도형이든 모눈 칸을 덮어 꽉 찬 칸/걸친 칸으로 세기 쉽게" />
              <Chip
                active={!showGrid}
                onClick={() => {
                  const next = !showGrid;
                  setShowGrid(next);
                  setFlash(next ? "▦ 격자를 다시 보여줘요" : "⬜ 무격자 모드: 칸을 세지 말고, 공식과 변 길이로 넓이를 구해 보세요!");
                }}
                icon="⬜"
                label="무격자"
                title="무격자 모드: 모눈(격자)을 숨겨요 — 칸을 세지 않고 공식·표시된 길이만으로 넓이를 구하는 연습! (스냅·자연수 모드는 그대로 유지)"
              />
              <Chip active={showAngles} onClick={() => setShowAngles(!showAngles)} icon="📐" label="각도" title="각도: 각 꼭짓점의 내각을 표시하고, 도형을 선택하면 삼각형으로 나눠 내각의 합 (n-2)×180°를 보여줘요" />
              <Chip active={showSymmetry} onClick={() => setShowSymmetry(!showSymmetry)} icon="🪞" label="대칭" title="대칭축: 선대칭도형의 대칭축을 점선으로 보여줘요 (정n각형, 마름모, 직사각형, 원)" />
              <Chip active={showEdgeLen} onClick={() => setShowEdgeLen(!showEdgeLen)} icon="📏" label="변길이" title="변 길이(cm) 라벨을 켜고 끄기" />
              <span className="hidden px-0.5 text-[11px] font-bold text-slate-400 lg:inline" title="변·넓이 숫자 크기 (수업용)">글자</span>
              <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5" title="변·넓이 숫자 크기 조절 (수업용)">
                <button
                  onClick={() => bumpLabelScale(-1)}
                  disabled={labelScale <= LABEL_STEPS[0]}
                  title="변·넓이 숫자 작게"
                  className="grid h-7 w-6 place-items-center rounded-md text-xs font-extrabold text-slate-500 hover:bg-white disabled:opacity-30"
                >
                  가<span className="text-[8px]">－</span>
                </button>
                <button
                  onClick={() => bumpLabelScale(1)}
                  disabled={labelScale >= LABEL_STEPS[LABEL_STEPS.length - 1]}
                  title="변·넓이 숫자 크게"
                  className="grid h-7 w-7 place-items-center rounded-md text-base font-extrabold text-slate-800 hover:bg-white disabled:opacity-30"
                >
                  가<span className="text-[10px]">＋</span>
                </button>
              </div>
            </div>

            <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-lg backdrop-blur">
              <IconBtn onClick={undo} disabled={past.length === 0} title="되돌리기 (Ctrl+Z)">
                ↶
              </IconBtn>
              <IconBtn onClick={redo} disabled={future.length === 0} title="다시하기 (Ctrl+Shift+Z)">
                ↷
              </IconBtn>
              <Chip active={boardMode} onClick={() => setBoardMode(true)} icon="📺" label="전자칠판" tone="sky" />
              <button
                onClick={exportSaveFile}
                className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 sm:px-2.5"
                title="작업을 파일(.json)로 저장 — 다음 시간에 이어서 작업할 수 있어요"
              >
                💾 <span className="hidden lg:inline">파일 저장</span>
              </button>
              <label
                className="flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 sm:px-2.5"
                title="저장된 작업 파일 불러오기"
              >
                📁 <span className="hidden lg:inline">열기</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importSaveFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={openSaveDialog}
                className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 sm:px-2.5"
                title="이름을 넣어 제출용 이미지로 저장"
              >
                📷 <span className="hidden lg:inline">제출</span>
              </button>
              <button
                onClick={resetPanelLayout}
                title="화면 정리: 옮겨 놓은 패널(도구·정보카드·줌·아래 메뉴)을 기본 위치로 되돌려요. 도형은 그대로!"
                className="whitespace-nowrap rounded-lg border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs font-bold text-sky-700 hover:bg-sky-100 sm:px-2.5"
              >
                🧹 <span className="hidden lg:inline">화면 정리</span>
              </button>
              <button
                onClick={clearAll}
                title="전체 초기화"
                className="whitespace-nowrap rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-100 sm:px-2.5"
              >
                <span className="lg:hidden">🗑</span><span className="hidden lg:inline">전체 초기화</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {boardMode && (
        <button
          onClick={() => setBoardMode(false)}
          className="absolute right-3 top-3 z-10 rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-sm font-bold text-slate-700 shadow-lg backdrop-blur hover:bg-white"
        >
          📺 전자칠판 끄기
        </button>
      )}

      {/* 왼쪽 도구 레일 (드래그 이동 가능) */}
      <div
        ref={railDrag.ref}
        style={railPos ? { left: railPos.x, top: railPos.y } : undefined}
        className={`absolute z-10 ${railPos ? "" : "left-3 top-1/2 -translate-y-1/2"}`}
      >
        <div className="flex flex-col gap-1.5 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-xl backdrop-blur">
          <Grip handle={railDrag.handle} onReset={() => setRailPos(null)} className="h-3" />
          {/* 접기/펴기 토글 */}
          <button
            onClick={() => setRailCollapsed((v) => !v)}
            title={railCollapsed ? "도구모음 펴기" : "도구모음 접기"}
            aria-label={railCollapsed ? "도구모음 펴기" : "도구모음 접기"}
            className="grid h-8 w-14 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-sm font-extrabold text-slate-500 hover:bg-slate-100"
          >
            {railCollapsed ? (
              <span className="flex items-center gap-1"><span>🧰</span><span className="text-[10px]">펴기</span></span>
            ) : (
              <span className="flex items-center gap-1"><span>◀</span><span className="text-[10px]">접기</span></span>
            )}
          </button>
          {!railCollapsed && TOOL_META.map((t) => {
            const active = tool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => activateTool(t.id)}
                title={`${t.label} (단축키 ${t.key})`}
                className={`group relative flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl transition ${
                  active ? "bg-slate-900 text-white shadow-md" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                }`}
              >
                <span
                  className={`absolute right-1 top-1 rounded px-1 text-[8px] font-bold leading-tight ${
                    active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-400"
                  }`}
                >
                  {t.key}
                </span>
                <span className="text-lg leading-none">{t.icon}</span>
                <span className={`text-[9px] font-bold leading-none ${active ? "text-white" : "text-slate-400"}`}>{t.label}</span>
              </button>
            );
          })}
          {/* 접었을 때 현재 도구만 표시(간단 조회) */}
          {railCollapsed && (() => {
            const cur = TOOL_META.find((t) => t.id === tool)!;
            return (
              <div className="grid h-14 w-14 place-items-center rounded-xl bg-slate-100 text-slate-500" title={`현재 도구: ${cur.label}`}>
                <span className="text-lg leading-none">{cur.icon}</span>
                <span className="text-[9px] font-bold leading-none text-slate-400">{cur.label}</span>
              </div>
            );
          })()}
        </div>
      </div>

      {/* 줌 컨트롤 (좌하단, 드래그 이동 가능) */}
      <div
        ref={zoomDrag.ref}
        style={zoomPos ? { left: zoomPos.x, top: zoomPos.y } : undefined}
        className={`absolute z-10 flex items-center gap-1 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-lg backdrop-blur ${zoomPos ? "" : "bottom-3 left-3"}`}
      >
        <Grip handle={zoomDrag.handle} onReset={() => setZoomPos(null)} className="w-3" />
        <IconBtn onClick={() => zoomCenter(1 / 1.2)} title="축소 ( − )">
          −
        </IconBtn>
        <button
          onClick={() => fitView()}
          className="min-w-[58px] rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
          title="전체 보기 (Fit)"
        >
          {Math.round(cam.scale * 100)}%
        </button>
        <IconBtn onClick={() => zoomCenter(1.2)} title="확대 ( + )">
          +
        </IconBtn>
        <span className="mx-0.5 h-5 w-px bg-slate-200" />
        <button
          onClick={() => fitView()}
          className="rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
          title="전체 보기"
        >
          ⤢ 맞춤
        </button>
      </div>

      {/* 정보 카드 (헤더 아래 우측 상단) — 퀴즈·레슨 중에는 전용 패널이 있어 숨김 */}
      {!quiz && !lesson && (
        <InfoCard
          selected={selectedIds.length > 1 ? null : selected}
          boardMode={boardMode}
          count={shapes.length}
          totalArea={totalArea}
          totalPeri={totalPeri}
          topPx={boardMode ? 64 : headerH + 8}
          pos={infoPos}
          onMove={setInfoPos}
          onResetPos={() => setInfoPos(null)}
          showAngles={showAngles}
          multi={
            selectedIds.length > 1
              ? {
                  count: selectedIds.length,
                  area: shapes.filter((s) => selectedIds.includes(s.id)).reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0),
                  peri: shapes.filter((s) => selectedIds.includes(s.id)).reduce((a, s) => a + displayPerimeterCm(s.points), 0),
                }
              : null
          }
          collapsed={infoCollapsed}
          piMode={piMode}
          onPiMode={setPiMode}
          onToggleCollapsed={() => setInfoCollapsed((v) => !v)}
          onSnapArea={snapNiceAreaSelected}
        />
      )}

      {/* 측정/가이드 정리 (우하단, 정보카드 위) */}
      {(measurements.length > 0 || guides.length > 0) && (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-2">
          {measurements.length > 0 && (
            <button
              onClick={() => setMeasurements([])}
              className="rounded-xl border border-purple-200 bg-purple-50/95 px-3 py-2 text-xs font-bold text-purple-700 shadow-lg backdrop-blur hover:bg-purple-100"
            >
              📏 측정선 지우기 ({measurements.length})
            </button>
          )}
          {guides.length > 0 && (
            <button
              onClick={() => setGuides([])}
              className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs font-bold text-slate-600 shadow-lg backdrop-blur hover:bg-slate-100"
            >
              📐 가이드 지우기 ({guides.length})
            </button>
          )}
        </div>
      )}

      {/* 선택 도형 컨텍스트 액션 (하단 중앙) */}
      {selected && (
        <ContextBar
          shape={selected}
          onRotate={(deg) => transformSelected((pts, c) => rotatePoints(pts, c, (deg * Math.PI) / 180))}
          onFlip={(axis) => transformSelected((pts, c) => flipPoints(pts, c, axis))}
          onScale={(f) =>
            transformSelected((pts, c) => {
              const scaled = scalePoints(pts, c, f, f);
              if (snapStep <= 0) return scaled;
              // 격자 정렬: 왼쪽·위 모서리를 격자 배수에 맞춤(모양은 유지)
              const step = snapStep * GRID;
              const minX = Math.min(...scaled.map((q) => q.x));
              const minY = Math.min(...scaled.map((q) => q.y));
              const dx = Math.round(minX / step) * step - minX;
              const dy = Math.round(minY / step) * step - minY;
              return scaled.map((q) => ({ x: q.x + dx, y: q.y + dy }));
            })
          }
          onColor={setSelectedColor}
          onDuplicate={duplicateSelected}
          onDelete={deleteSelected}
          merged={!!selected.ghosts && selected.ghosts.length > 1}
          inspecting={inspectId === selected.id}
          onToggleInspect={toggleInspect}
          onSplit={splitSelected}
          onEquilateralize={equilateralizeSelected}
          onEquiangularize={equiangularizeSelected}
          isCircle={typeof selected.defKind === "object" && selected.defKind !== null && "circle" in selected.defKind}
          dragRef={ctxDrag.ref}
          dragHandle={ctxDrag.handle}
          pos={ctxPos}
          onResetPos={() => setCtxPos(null)}
          collapsed={ctxCollapsed}
          onToggleCollapsed={() => setCtxCollapsed((v) => !v)}
        />
      )}

      {/* 도구 힌트 (하단 중앙, 컨텍스트바 없을 때) */}
      {!selected && !boardMode && shapes.length > 0 && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-0 -translate-x-1/2 rounded-full border border-slate-200 bg-white/85 px-4 py-1.5 text-xs text-slate-500 shadow backdrop-blur">
          {TOOL_HINT[tool]}
        </div>
      )}

      {/* 토스트 (상단 중앙) */}
      <div style={{ top: headerH + 8 }} className="pointer-events-none absolute left-1/2 z-20 flex w-[min(92vw,640px)] -translate-x-1/2 flex-col gap-2">
        {flash && (
          <div className="pointer-events-auto rounded-2xl border border-sky-200 bg-sky-50/95 px-4 py-2.5 text-sm text-sky-900 shadow-lg backdrop-blur">
            {flash}
          </div>
        )}
        {scenarioHint && !lesson && (
          <div className="pointer-events-auto flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/95 px-4 py-3 text-sm text-amber-900 shadow-lg backdrop-blur">
            <span>💡</span>
            <span className="flex-1">{scenarioHint}</span>
            <button className="shrink-0 text-xs font-bold text-amber-700 underline" onClick={() => setScenarioHint(null)}>
              닫기
            </button>
          </div>
        )}
      </div>

      {/* 탐구 레슨 패널 (상단 중앙) */}
      {lesson && (
        <LessonPanel
          topPx={headerH + 8}
          lesson={lesson}
          stepIndex={lessonStep}
          showHint={showHint}
          onToggleHint={() => setShowHint((v) => !v)}
          onNext={advanceLesson}
          onRestart={restartLesson}
          onExit={exitLesson}
          refArea={lessonReference.reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0)}
          curArea={shapes.filter((s) => !s.isReference).reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0)}
        />
      )}

      {/* 문제 구성 선택(G) */}
      {quizSetup && !quiz && (
        <QuizSetup topPx={headerH + 8} onStart={(cfg) => startQuiz(cfg)} onCancel={() => setQuizSetup(false)} bestPct={progress.quizBestPct} />
      )}

      {/* 문제 풀이 모드 패널 */}
      {quiz && (
        <QuizPanel
          topPx={headerH + 8}
          quiz={quiz}
          onChange={(s) => setQuiz(s)}
          onSubmit={submitQuiz}
          onNext={nextQuiz}
          onRestart={restartQuiz}
          onExit={exitQuiz}
          onReset={resetQuizShape}
          onGiveUp={giveUpQuiz}
          onRetryWrong={retryWrong}
          bestPct={progress.quizBestPct}
          muted={muted}
          onToggleMute={toggleMuted}
        />
      )}

      {/* 드로어 */}
      <Drawer side="left" open={drawer === "shapes"} title="📐 도형 추가" onClose={() => setDrawer(null)}>
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <ShapeThumb key={p.id} preset={p} onClick={() => addPreset(p)} />
          ))}
        </div>
      </Drawer>
      <Drawer side="right" open={drawer === "scenarios"} title="📚 학습 예시" onClose={() => setDrawer(null)}>
        <div className="flex flex-col gap-2">
          <div className="rounded-xl border-2 border-rose-300 bg-rose-50 p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-extrabold text-rose-900">🎮 문제 풀이 모드</span>
              {progress.quizBestPct > 0 && (
                <span className="rounded-full bg-rose-200 px-2 py-0.5 text-[10px] font-bold text-rose-800">최고 {progress.quizBestPct}%</span>
              )}
            </div>
            <div className="mb-2 text-xs text-rose-700">도형을 조작하며 넓이를 알아내고 정답을 입력해요.</div>
            <button
              onClick={() => {
                setDrawer(null);
                setQuizSetup(true);
              }}
              className="w-full rounded-lg bg-rose-600 px-3 py-2.5 text-center text-sm font-bold text-white shadow hover:bg-rose-700"
            >
              ▶ 문제 풀기 시작
            </button>
          </div>
          <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-3">
            <div className="mb-1 text-sm font-extrabold text-emerald-900">🧪 직접 만드는 공식 (탐구)</div>
            <div className="mb-2 text-xs text-emerald-700">도형을 직접 돌리고 붙여 공식을 스스로 발견해요.</div>
            {LESSONS.map((L) => (
              <button
                key={L.id}
                onClick={() => startLesson(L)}
                className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 text-left text-sm font-bold text-white shadow hover:bg-emerald-700"
              >
                <span className="flex-1">▶ {L.title}</span>
                {progress.lessonsDone.includes(L.id) && (
                  <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold">✓ 완료</span>
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 px-0.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">눈으로 보는 예시</div>
          {SCENARIO_GROUPS.map((g, gi) => (
            <details key={g.shape} open={gi === 0} className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-2">
              <summary className="flex min-h-[36px] cursor-pointer items-center text-sm font-bold text-indigo-900 marker:text-indigo-400">
                {g.shape}
              </summary>
              <div className="mt-1 text-xs font-medium text-indigo-700">공식: {g.formula}</div>
              <div className="mt-2 flex flex-col gap-1.5">
                {g.scenarios.map((sc) => (
                  <button
                    key={sc.label}
                    onClick={() => loadScenario(sc)}
                    className="rounded-md border border-indigo-200 bg-white px-2.5 py-2 text-left text-[13px] text-indigo-900 hover:bg-indigo-100"
                  >
                    {sc.label}
                  </button>
                ))}
              </div>
            </details>
          ))}
        </div>
      </Drawer>
    </div>
  );
}

// ====================== UI 부품 ======================

function IconBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="grid h-8 w-8 place-items-center rounded-lg text-lg font-bold text-slate-600 transition hover:bg-slate-100 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Chip({
  icon,
  label,
  active,
  onClick,
  tone,
  title,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "sky";
  title?: string;
}) {
  const activeCls = tone === "sky" ? "border-sky-600 bg-sky-600 text-white" : "border-slate-900 bg-slate-900 text-white";
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className={`flex items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
        active ? activeCls : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      <span>{icon}</span>
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function DrawerToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-bold transition sm:px-2.5 ${
        active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      <span>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function InfoCard({
  selected,
  boardMode,
  count,
  totalArea,
  totalPeri,
  hideArea,
  topPx,
  pos,
  onMove,
  onResetPos,
  showAngles,
  multi,
  collapsed,
  onToggleCollapsed,
  piMode,
  onPiMode,
  onSnapArea,
}: {
  selected: Shape | null;
  boardMode: boolean;
  count: number;
  totalArea: number;
  totalPeri: number;
  hideArea?: boolean;
  topPx: number;
  pos: { x: number; y: number } | null;
  onMove: (p: { x: number; y: number }) => void;
  onResetPos: () => void;
  showAngles?: boolean;
  multi?: { count: number; area: number; peri: number } | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  piMode?: 3 | 3.1 | 3.14;
  onPiMode?: (v: 3 | 3.1 | 3.14) => void;
  onSnapArea?: () => void;
}) {
  const kind = useMemo(() => (selected ? detectShapeKind(selected.points) : null), [selected]);
  const cardRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<{ ox: number; oy: number } | null>(null);
  function onDownDrag(e: React.PointerEvent) {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grabRef.current = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onMoveDrag(e: React.PointerEvent) {
    const g = grabRef.current;
    if (!g) return;
    const el = cardRef.current;
    const w = el?.offsetWidth ?? 300;
    const h = el?.offsetHeight ?? 120;
    const x = Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - g.ox));
    const y = Math.max(4, Math.min(window.innerHeight - h - 4, e.clientY - g.oy));
    onMove({ x, y });
  }
  function onUpDrag() {
    grabRef.current = null;
  }
  if (count === 0) return null;
  // 원(defKind.circle)이면 반지름 기반 원주율(piMode: 3/3.1/3.14) 공식으로 계산
  const circleDef = selected && typeof selected.defKind === "object" && selected.defKind !== null && "circle" in selected.defKind ? selected.defKind : null;
  const pi = piMode ?? 3.14;
  let area: number;
  let peri: number;
  let radiusCm: number | null = null;
  let rhombusDiag: { d1: number; d2: number } | null = null;
  if (circleDef) {
    const c = polygonCentroid(selected!.points);
    radiusCm = selected!.points.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / selected!.points.length / GRID;
    area = pi * radiusCm * radiusCm;
    peri = 2 * pi * radiusCm;
  } else {
    area = multi ? multi.area : selected ? polygonArea(selected.points) / (GRID * GRID) : totalArea;
    peri = multi ? multi.peri : selected ? displayPerimeterCm(selected.points) : totalPeri;
    // 마름모: 대각선 표시 → '대각선×대각선÷2 = 둘러싼 직사각형의 절반' 관계를 눈으로 확인
    if (selected && selected.defKind === "rhombus" && selected.points.length === 4) {
      const p = selected.points;
      rhombusDiag = {
        d1: Math.hypot(p[2].x - p[0].x, p[2].y - p[0].y) / GRID,
        d2: Math.hypot(p[3].x - p[1].x, p[3].y - p[1].y) / GRID,
      };
    }
  }
  const big = boardMode ? "text-4xl" : "text-2xl sm:text-3xl";
  if (collapsed) {
    return (
      <div
        ref={cardRef}
        style={pos ? { left: pos.x, top: pos.y } : { top: topPx }}
        className={`absolute z-10 rounded-full border border-slate-200 bg-white/95 shadow-xl backdrop-blur ${pos ? "" : "right-3"}`}
      >
        <div
          onPointerDown={onDownDrag}
          onPointerMove={onMoveDrag}
          onPointerUp={onUpDrag}
          className="flex cursor-move touch-none items-center gap-1 rounded-full px-2 py-1 text-slate-400"
          title="드래그해서 옮기기"
        >
          <span className="text-[10px] tracking-widest">⠿</span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onToggleCollapsed}
            className="rounded-full px-2 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-100"
            title="넓이·둘레 카드 펴기"
          >
            📊 넓이·둘레 ▸
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={cardRef}
      style={pos ? { left: pos.x, top: pos.y } : { top: topPx }}
      className={`absolute z-10 w-[min(64vw,300px)] rounded-2xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur ${pos ? "" : "right-3"}`}
    >
      {/* 드래그 손잡이 */}
      <div
        onPointerDown={onDownDrag}
        onPointerMove={onMoveDrag}
        onPointerUp={onUpDrag}
        className="flex cursor-move touch-none items-center justify-between rounded-t-2xl px-2 py-1 text-slate-300 hover:bg-slate-50"
        title="드래그해서 옮기기"
      >
        <span className="text-xs tracking-widest">⠿⠿</span>
        <div className="flex items-center gap-1">
          {pos && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onResetPos}
              className="rounded px-1 text-[10px] font-bold text-slate-400 hover:text-slate-600"
              title="기본 위치로"
            >
              ↺ 위치
            </button>
          )}
          {onToggleCollapsed && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onToggleCollapsed}
              className="rounded px-1 text-[11px] font-bold text-slate-400 hover:text-slate-600"
              title="넓이·둘레 카드 접기"
            >
              ▾
            </button>
          )}
        </div>
      </div>
      <div className="p-3 pt-1 sm:p-4 sm:pt-1">
      {multi ? (
        <div className="mb-3 text-base font-bold text-indigo-600">🧩 {multi.count}개 선택됨 · 합계</div>
      ) : selected && kind ? (
        <div className="mb-3 flex items-center gap-2.5">
          <span className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-black/5" style={{ backgroundColor: selected.color }} />
          <div className="leading-tight">
            <div className="text-lg font-extrabold text-slate-800">{circleDef ? "원" : selected.points.length >= 20 ? "곡선 도형" : kind.name}</div>
            <div className="text-xs font-medium text-amber-700">공식 · {circleDef ? `반지름 × 반지름 × ${pi}` : selected.points.length >= 20 ? "칸을 세어 어림해요" : kind.formula}</div>
          </div>
        </div>
      ) : (
        <div className="mb-3 text-base font-bold text-slate-500">📊 전체 도형 {count}개</div>
      )}
      {circleDef && radiusCm !== null && (
        <div className="mb-2 rounded-xl bg-sky-50 px-3.5 py-2 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-sky-500">반지름</div>
              <div className="text-xl font-extrabold text-sky-800">{fmtLen(radiusCm)}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-semibold text-sky-500">원주율</div>
              <div className="flex gap-0.5 rounded-lg bg-white p-0.5">
                {([3, 3.1, 3.14] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => onPiMode?.(v)}
                    className={`rounded-md px-1.5 py-0.5 text-xs font-bold transition ${
                      pi === v ? "bg-sky-600 text-white" : "text-sky-600 hover:bg-sky-100"
                    }`}
                    title={`원주율을 ${v}(으)로 어림하여 계산`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {rhombusDiag && (
        <div className="mb-2 rounded-xl bg-violet-50 px-3.5 py-2 text-sm">
          <div className="text-xs font-semibold text-violet-600">둘러싼 직사각형 (두 변 = 두 대각선)</div>
          <div className="text-xl font-extrabold text-violet-800">
            {fmtLen(rhombusDiag.d1).replace("cm", "")} × {fmtLen(rhombusDiag.d2)}
          </div>
          <div className="mt-0.5 text-xs font-medium text-violet-600">
            직사각형 넓이 {fmtArea(rhombusDiag.d1 * rhombusDiag.d2)} 의 <b>절반</b> = 마름모 넓이
          </div>
        </div>
      )}
      <div className="flex items-stretch gap-2.5">
        <div className="flex-1 rounded-xl bg-slate-50 px-3.5 py-2.5">
          <div className="text-xs font-semibold text-slate-400">넓이{circleDef ? ` (=r×r×${pi})` : rhombusDiag ? " (=대각선×대각선÷2)" : ""}</div>
          <div className={`font-extrabold leading-tight ${hideArea ? "text-slate-300" : "text-slate-900"} ${big}`}>
            {hideArea ? "?cm²" : fmtArea(area)}
          </div>
          {/* 넓이가 소수(무리수)로 떨어질 때 → 한 번에 딱 맞추기 */}
          {!hideArea && !circleDef && selected && selected.points.length >= 3 && !isAreaNice(area) && onSnapArea && (
            <button
              onClick={onSnapArea}
              title="도형을 살짝 조정해 넓이를 딱 떨어지는 값으로 자동으로 맞춰요"
              className="mt-1.5 w-full rounded-lg bg-amber-500 px-2 py-1.5 text-xs font-extrabold text-white shadow hover:bg-amber-600"
            >
              🎯 넓이 딱 맞추기
            </button>
          )}
        </div>
        <div className="flex-1 rounded-xl bg-slate-50 px-3.5 py-2.5">
          <div className="text-xs font-semibold text-slate-400">{circleDef ? `원주 (=지름×${pi})` : "둘레"}</div>
          <div className={`font-extrabold leading-tight text-slate-900 ${big}`}>{fmtLen(peri)}</div>
        </div>
      </div>
      {showAngles && selected && selected.points.length >= 3 && !circleDef && (
        <div className="mt-2.5 rounded-xl bg-violet-50 px-3.5 py-2.5">
          <div className="text-xs font-semibold text-violet-500">내각의 합</div>
          <div className="text-2xl font-extrabold text-violet-700">{(selected.points.length - 2) * 180}°</div>
          <div className="mt-0.5 text-xs font-medium text-violet-600">
            {selected.points.length}각형 → 삼각형 {selected.points.length - 2}개 × 180°
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function ContextBar({
  shape,
  onRotate,
  onFlip,
  onScale,
  onColor,
  onDuplicate,
  onDelete,
  merged,
  inspecting,
  onToggleInspect,
  onSplit,
  onEquilateralize,
  onEquiangularize,
  isCircle,
  dragRef,
  dragHandle,
  pos,
  onResetPos,
  collapsed,
  onToggleCollapsed,
}: {
  shape: Shape;
  onRotate: (deg: number) => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
  onScale: (f: number) => void;
  onColor: (color: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  merged: boolean;
  inspecting: boolean;
  onToggleInspect: () => void;
  onSplit: () => void;
  onEquilateralize: () => void;
  onEquiangularize: () => void;
  isCircle?: boolean;
  dragRef: React.RefObject<HTMLDivElement>;
  dragHandle: object;
  pos: XY | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onResetPos: () => void;
}) {
  const mini =
    "grid h-9 min-w-[38px] place-items-center rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
  if (collapsed) {
    return (
      <div
        ref={dragRef}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        className={`absolute z-10 ${pos ? "" : "bottom-[84px] left-1/2 -translate-x-1/2 sm:bottom-20"}`}
      >
        <div className="flex items-center gap-1 rounded-full border border-amber-200 bg-white/95 px-1 py-0.5 shadow-lg backdrop-blur">
          <Grip handle={dragHandle} onReset={onResetPos} className="h-6 w-3 self-center" />
          <button
            onClick={onToggleCollapsed}
            className="rounded-full px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-100"
            title="색상·회전 도구 펴기"
          >
            🎨 도형 도구 ▸
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={dragRef}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      className={`absolute z-10 max-w-[96vw] overflow-x-auto ${pos ? "" : "bottom-[84px] left-1/2 -translate-x-1/2 sm:bottom-20"}`}
    >
      <div className="flex w-max items-end gap-3 rounded-2xl border border-amber-200 bg-white/95 px-2 py-2 shadow-xl backdrop-blur">
        <Grip handle={dragHandle} onReset={onResetPos} className="h-9 w-3 self-center" />
        {onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="grid h-9 w-6 place-items-center self-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="색상·회전 도구 접기"
          >
            ▾
          </button>
        )}
        {merged && (
          <MiniGroup label="조각">
            <button
              className={`grid h-9 place-items-center gap-1 rounded-lg border px-2 text-sm font-semibold transition ${
                inspecting ? "border-violet-500 bg-violet-600 text-white" : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
              }`}
              onClick={onToggleInspect}
              title="합쳐진 도형 속 조각들을 색으로 구분해 보기"
            >
              🧩 보기
            </button>
            <button
              className="grid h-9 place-items-center rounded-lg border border-amber-200 bg-amber-50 px-2 text-sm font-semibold text-amber-700 hover:bg-amber-100"
              onClick={onSplit}
              title="원본 조각들로 다시 분리하기"
            >
              ✂️ 분리
            </button>
          </MiniGroup>
        )}
        {!isCircle && (
          <MiniGroup label="맞추기">
            <button
              className="grid h-9 place-items-center rounded-lg border border-sky-200 bg-sky-50 px-2 text-sm font-semibold text-sky-700 hover:bg-sky-100"
              onClick={onEquilateralize}
              title="모든 변의 길이를 같게 (마름모 / 정다각형). 변을 꾹 눌러도 됩니다."
            >
              🔷 등변
            </button>
            <button
              className="grid h-9 place-items-center rounded-lg border border-violet-200 bg-violet-50 px-2 text-sm font-semibold text-violet-700 hover:bg-violet-100"
              onClick={onEquiangularize}
              title="모든 각을 같게 (직사각형 / 정다각형). 각 부근을 꾹 눌러도 됩니다."
            >
              📐 등각
            </button>
          </MiniGroup>
        )}
        <MiniGroup label="색상">
          <div className="flex h-9 items-center gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => onColor(c)}
                title="색 바꾸기"
                className={`h-8 w-8 rounded-full ring-2 transition ${
                  shape.color === c ? "ring-slate-900" : "ring-transparent hover:ring-slate-300"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </MiniGroup>
        {!isCircle && (
          <MiniGroup label="회전">
            <button className={mini} onClick={() => onRotate(-90)} title="시계 반대 90° (Z)">
              ↶90°
            </button>
            <button className={mini} onClick={() => onRotate(90)} title="시계 90° (X)">
              ↷90°
            </button>
            <button className={mini} onClick={() => onRotate(180)} title="180°">
              180°
            </button>
          </MiniGroup>
        )}
        {!isCircle && (
          <MiniGroup label="뒤집기">
            <button className={mini} onClick={() => onFlip("horizontal")} title="좌우 뒤집기 (C)">
              ↔
            </button>
            <button className={mini} onClick={() => onFlip("vertical")} title="위아래 뒤집기 (V)">
              ↕
            </button>
          </MiniGroup>
        )}
        <MiniGroup label="크기">
          <button className={mini} onClick={() => onScale(0.5)} title="절반으로">
            ×½
          </button>
          <button className={mini} onClick={() => onScale(2)} title="2배로">
            ×2
          </button>
        </MiniGroup>
        <MiniGroup label="편집">
          <button className={mini} onClick={onDuplicate} title="복사">
            📋
          </button>
          <button
            className="grid h-9 min-w-[38px] place-items-center rounded-lg border border-rose-200 bg-rose-50 px-2 text-sm font-semibold text-rose-600 hover:bg-rose-100"
            onClick={onDelete}
            title="삭제 (Delete)"
          >
            🗑️
          </button>
        </MiniGroup>
      </div>
    </div>
  );
}

function MiniGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function LessonPanel({
  lesson,
  stepIndex,
  showHint,
  onToggleHint,
  onNext,
  onRestart,
  onExit,
  refArea,
  curArea,
  topPx,
}: {
  lesson: Lesson;
  stepIndex: number;
  showHint: boolean;
  onToggleHint: () => void;
  onNext: () => void;
  onRestart: () => void;
  onExit: () => void;
  refArea: number;
  curArea: number;
  topPx: number;
}) {
  const conserved = refArea > 0 && Math.abs(refArea - curArea) < 0.5;
  const step = lesson.steps[stepIndex];
  const isFinal = !!step?.final;
  const fill = step?.fill;
  const challenge = step?.challenge;
  // 학생 기기에서 실수로 닫아 설명이 사라지지 않도록: 그만두기는 확인 후, 접기로 잠시 숨기기 가능
  const [collapsed, setCollapsed] = useState(false);
  function confirmExit() {
    if (isFinal || window.confirm("학습을 그만둘까요? 진행한 단계가 사라져요.")) onExit();
  }

  const [fillVals, setFillVals] = useState<(string | null)[]>([]);
  const [activeBlank, setActiveBlank] = useState(0);
  const [fillChecked, setFillChecked] = useState(false);
  const [ans, setAns] = useState("");
  const [chResult, setChResult] = useState<"idle" | "correct" | "wrong">("idle");
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setFillVals(fill ? fill.answers.map(() => null) : []);
    setActiveBlank(0);
    setFillChecked(false);
    setAns("");
    setChResult("idle");
    setRevealed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, lesson.id]);

  const fillAllFilled = !!fill && fillVals.length === fill.answers.length && fillVals.every((v) => v !== null);
  const fillAllCorrect = !!fill && fillVals.length === fill.answers.length && fill.answers.every((a, i) => fillVals[i] === a);

  function pickChip(opt: string) {
    if (!fill) return;
    const next = [...fillVals];
    next[activeBlank] = opt;
    setFillVals(next);
    const empty = next.findIndex((v) => v === null);
    setActiveBlank(empty === -1 ? activeBlank : empty);
    setFillChecked(false);
  }
  function checkChallenge() {
    if (!challenge) return;
    const v = parseFloat(ans.replace(/[^0-9.\-]/g, ""));
    const tol = challenge.tolerance ?? 0.001;
    if (!isNaN(v) && Math.abs(v - challenge.answer) <= tol) {
      setChResult("correct");
      setRevealed(true);
    } else {
      setChResult("wrong");
    }
  }

  const blankCls = (i: number) => {
    if (fillVals[i] == null)
      return activeBlank === i ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-dashed border-slate-300 text-slate-300";
    if (fillChecked)
      return fillVals[i] === fill!.answers[i] ? "border-emerald-500 bg-emerald-100 text-emerald-800" : "border-rose-400 bg-rose-50 text-rose-600";
    return activeBlank === i ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-800";
  };

  if (collapsed) {
    // 접힌 상태: 얇은 막대 — 제목 + 펼치기 (설명이 '사라진' 게 아니라 여기 있음이 보이게)
    return (
      <div style={{ top: topPx }} className="pointer-events-none absolute left-1/2 z-30 w-[min(94vw,640px)] -translate-x-1/2">
        <button
          onClick={() => setCollapsed(false)}
          className="pointer-events-auto mx-auto flex items-center gap-2 rounded-full border-2 border-emerald-300 bg-white/95 px-4 py-2 text-sm font-extrabold text-emerald-800 shadow-xl backdrop-blur"
        >
          🧪 {lesson.title}
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">▼ 설명 펼치기</span>
        </button>
      </div>
    );
  }
  return (
    <div style={{ top: topPx }} className="pointer-events-none absolute left-1/2 z-30 w-[min(94vw,640px)] -translate-x-1/2">
      <div className="pointer-events-auto rounded-2xl border-2 border-emerald-300 bg-white/95 p-4 shadow-2xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-extrabold text-emerald-800">🧪 {lesson.title}</span>
            <div className="flex gap-1">
              {lesson.steps.map((_, i) => (
                <span
                  key={i}
                  className={`h-2 w-2 rounded-full ${
                    i < stepIndex ? "bg-emerald-500" : i === stepIndex ? "bg-emerald-600 ring-2 ring-emerald-200" : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setCollapsed(true)}
              title="설명을 잠시 접어요 (도형이 잘 보이게)"
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50"
            >
              ▲ 접기
            </button>
            <button onClick={confirmExit} className="rounded-lg px-2 py-1 text-xs font-bold text-slate-400 hover:bg-slate-50 hover:text-slate-600">
              그만두기 ✕
            </button>
          </div>
        </div>

        {refArea > 0 && !fill && !challenge && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
            <span className="text-slate-400">💎 원본 넓이</span>
            <b className="text-slate-700">{fmtArea(refArea)}</b>
            <span className="text-slate-300">→</span>
            <span className="text-slate-400">현재</span>
            <b className="text-slate-900">{fmtArea(curArea)}</b>
            {conserved && <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✓ 넓이 보존!</span>}
          </div>
        )}

        {isFinal ? (
          <div className="rounded-xl bg-emerald-50 p-3 text-center">
            <div className="text-sm font-bold text-emerald-700">🎉 직접 조작해서 알아냈어요!</div>
            <div className="mt-2 text-sm text-slate-600">{step?.prompt}</div>
            <div className="mt-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xl font-extrabold text-slate-900">{lesson.formula}</div>
            <div className="mt-3 flex justify-center gap-2">
              <button onClick={onRestart} className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-bold text-emerald-700 hover:bg-emerald-50">
                ↺ 다시 해보기
              </button>
              <button onClick={onExit} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                완료
              </button>
            </div>
          </div>
        ) : fill ? (
          <>
            <div className="mb-2 text-sm font-bold text-emerald-800">🖊️ 빈칸을 채워 ‘내 말로’ 정리해 볼까요?</div>
            <div className="text-[15px] leading-loose text-slate-800">
              {fill.parts.map((part, i) => (
                <span key={i}>
                  {part}
                  {i < fill.answers.length && (
                    <button
                      onClick={() => setActiveBlank(i)}
                      className={`mx-0.5 inline-flex min-w-[46px] items-center justify-center rounded-md border px-2 py-0.5 align-middle text-sm font-bold ${blankCls(i)}`}
                    >
                      {fillVals[i] ?? "?"}
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {fill.options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => pickChip(opt)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50"
                >
                  {opt}
                </button>
              ))}
            </div>
            {fillChecked && fillAllCorrect && <div className="mt-2 text-xs font-bold text-emerald-600">✓ 정확해요! 멋지게 정리했어요.</div>}
            {fillChecked && !fillAllCorrect && (
              <div className="mt-2 text-xs font-bold text-rose-600">빨간 칸을 다시 골라 볼까요? 칸을 눌러 바꿀 수 있어요.</div>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <button onClick={onRestart} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50">
                ↺ 처음부터
              </button>
              {fillChecked && fillAllCorrect ? (
                <button onClick={onNext} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                  다음 ▶
                </button>
              ) : (
                <button
                  onClick={() => setFillChecked(true)}
                  disabled={!fillAllFilled}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  확인
                </button>
              )}
            </div>
          </>
        ) : challenge ? (
          <>
            <div className="mb-2 text-sm font-bold text-emerald-800">🎯 적용 챌린지 — 공식을 직접 써 봐요</div>
            <div className="text-[15px] text-slate-800">{challenge.question}</div>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={ans}
                onChange={(e) => {
                  setAns(e.target.value);
                  setChResult("idle");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") checkChallenge();
                }}
                inputMode="numeric"
                placeholder="답"
                className="w-24 rounded-lg border-2 border-slate-300 px-3 py-2 text-lg font-bold text-slate-900 outline-none focus:border-emerald-500"
              />
              <span className="text-sm font-medium text-slate-500">{challenge.unit}</span>
              {chResult !== "correct" && (
                <button onClick={checkChallenge} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                  확인
                </button>
              )}
            </div>
            {chResult === "correct" && <div className="mt-2 text-sm font-bold text-emerald-600">🎉 정답! {challenge.solution}</div>}
            {chResult === "wrong" && !revealed && <div className="mt-2 text-sm font-bold text-rose-600">아쉬워요! 다시 한 번 계산해 볼까요?</div>}
            {revealed && chResult !== "correct" && <div className="mt-2 text-sm text-slate-700">풀이: {challenge.solution}</div>}
            <div className="mt-3 flex items-center justify-between gap-2">
              <button onClick={onRestart} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50">
                ↺ 처음부터
              </button>
              <div className="flex gap-1.5">
                {chResult !== "correct" && !revealed && (
                  <button
                    onClick={() => setRevealed(true)}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100"
                  >
                    정답 보기
                  </button>
                )}
                {(chResult === "correct" || revealed) && (
                  <button onClick={onNext} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                    다음 ▶
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm leading-relaxed text-slate-800">{step?.prompt}</div>
            {showHint && step?.hint && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">💡 {step.hint}</div>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex gap-1.5">
                {step?.hint && (
                  <button
                    onClick={onToggleHint}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100"
                  >
                    {showHint ? "힌트 숨기기" : "💡 힌트"}
                  </button>
                )}
                <button
                  onClick={onRestart}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50"
                >
                  ↺ 처음부터
                </button>
              </div>
              {step?.manual ? (
                <button onClick={onNext} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                  다음 ▶
                </button>
              ) : (
                <span className="text-xs font-medium text-emerald-600">조작하면 자동으로 넘어가요 ✨</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 정답 효과음 (WebAudio 2음 차임) — semi: 연속 정답일수록 음을 올려 신나게
function playDing(semi = 0) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const a = new Ctx();
    const mult = Math.pow(2, semi / 12);
    [880 * mult, 1320 * mult].forEach((f, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(g);
      g.connect(a.destination);
      const t0 = a.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      o.start(t0);
      o.stop(t0 + 0.28);
    });
    setTimeout(() => a.close(), 700);
  } catch {}
}

const CONFETTI = ["🎉", "⭐", "✨", "🎊", "🌟", "💛", "💙", "💚"];

function QuizSetup({
  onStart,
  onCancel,
  bestPct,
  topPx,
}: {
  onStart: (cfg: QuizConfig) => void;
  onCancel: () => void;
  bestPct: number;
  topPx: number;
}) {
  const [count, setCount] = useState(20);
  const [level, setLevel] = useState(1);
  const [kinds, setKinds] = useState<QuizKind[]>(["rect", "para", "tri", "trap", "compound"]);
  const allKinds: QuizKind[] = ["rect", "para", "tri", "trap", "compound"];
  const toggleKind = (k: QuizKind) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const seg = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-bold transition ${active ? "bg-rose-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"}`;
  return (
    <div style={{ top: topPx }} className="pointer-events-none absolute left-1/2 z-30 w-[min(94vw,520px)] -translate-x-1/2">
      <div className="pointer-events-auto rounded-2xl border-2 border-rose-300 bg-white/95 p-4 shadow-2xl backdrop-blur">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-base font-extrabold text-rose-700">🎮 문제 풀기 설정</span>
          {bestPct > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-700">최고 {bestPct}%</span>}
        </div>
        <div className="mb-3">
          <div className="mb-1 text-xs font-bold text-slate-400">문항 수</div>
          <div className="flex gap-1.5">
            {[10, 20, 30].map((c) => (
              <button key={c} onClick={() => setCount(c)} className={seg(count === c)}>
                {c}문제
              </button>
            ))}
          </div>
        </div>
        <div className="mb-3">
          <div className="mb-1 text-xs font-bold text-slate-400">난이도</div>
          <div className="flex gap-1.5">
            {["쉬움", "보통", "어려움"].map((lbl, i) => (
              <button key={lbl} onClick={() => setLevel(i)} className={seg(level === i)}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-4">
          <div className="mb-1 text-xs font-bold text-slate-400">유형 (탭하여 켜고 끄기)</div>
          <div className="flex flex-wrap gap-1.5">
            {allKinds.map((k) => (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                  kinds.includes(k) ? "border-rose-400 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-400"
                }`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
            취소
          </button>
          <button
            onClick={() => onStart({ count, level, kinds })}
            disabled={kinds.length === 0}
            className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-40"
          >
            시작 ▶
          </button>
        </div>
      </div>
    </div>
  );
}

function QuizPanel({
  quiz,
  onChange,
  onSubmit,
  onNext,
  onRestart,
  onExit,
  onReset,
  onGiveUp,
  onRetryWrong,
  bestPct,
  muted,
  onToggleMute,
  topPx,
}: {
  quiz: QuizState;
  onChange: (s: QuizState) => void;
  onSubmit: () => void;
  onNext: () => void;
  onRestart: () => void;
  onExit: () => void;
  onReset: () => void;
  onGiveUp: () => void;
  onRetryWrong: () => void;
  bestPct: number;
  muted: boolean;
  onToggleMute: () => void;
  topPx: number;
}) {
  const total = quiz.problems.length;
  const done = quiz.index >= total;
  const p = !done ? quiz.problems[quiz.index] : null;
  const [showMethod, setShowMethod] = useState(false);

  // 문제가 바뀌면 '푸는 방법' 펼침 초기화
  useEffect(() => {
    setShowMethod(false);
  }, [quiz.index]);

  // 정답/답공개 시 잠깐 답을 보여준 뒤 자동으로 다음 문제로 + 정답이면 효과음
  useEffect(() => {
    if (quiz.result === "correct" && !muted) {
      let streak = 0;
      for (let i = quiz.index; i >= 0; i--) {
        if (quiz.answered[i] === "correct") streak++;
        else break;
      }
      playDing(Math.min(Math.max(streak - 1, 0), 6)); // 연속 정답 1→0반음, 7+→+6반음
    }
    if (quiz.result === "correct" || quiz.result === "shown") {
      const t = setTimeout(onNext, quiz.result === "shown" ? 2400 : 1600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.result, quiz.index]);

  if (done) {
    const pct = Math.round((quiz.score / total) * 100);
    const stars = pct >= 90 ? "🏆" : pct >= 70 ? "🌟" : pct >= 50 ? "✨" : "🌱";
    const wrongCount = quiz.answered.filter((a) => a !== "correct").length;
    const newBest = pct >= bestPct;
    return (
      <div style={{ top: topPx }} className="pointer-events-none absolute left-1/2 z-30 w-[min(94vw,560px)] -translate-x-1/2">
        <div className="pointer-events-auto relative overflow-hidden rounded-2xl border-2 border-rose-300 bg-white/95 p-5 text-center shadow-2xl backdrop-blur">
          {pct >= 50 && (
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: 18 }).map((_, i) => (
                <span
                  key={i}
                  className="confetti-piece"
                  style={{ left: `${(i * 5.5 + 3) % 100}%`, animationDelay: `${(i % 6) * 0.12}s` }}
                >
                  {CONFETTI[i % CONFETTI.length]}
                </span>
              ))}
            </div>
          )}
          <div className="pop-in text-4xl">{stars}</div>
          <div className="mt-2 text-lg font-extrabold text-slate-800">완주! 정말 잘했어요</div>
          <div className="mt-2 text-3xl font-extrabold text-rose-600">
            {quiz.score} <span className="text-lg text-slate-500">/ {total}</span>
            <span className="ml-2 text-base text-slate-500">({pct}%)</span>
          </div>
          {newBest && <div className="mt-1 text-xs font-bold text-amber-600">🎖️ 최고 기록 갱신!</div>}
          {!newBest && bestPct > 0 && <div className="mt-1 text-xs font-medium text-slate-400">최고 기록 {bestPct}%</div>}
          <div className="mt-3 flex flex-wrap justify-center gap-1">
            {quiz.answered.map((a, i) => (
              <span
                key={i}
                className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${
                  a === "correct" ? "bg-emerald-500 text-white" : a === "wrong" ? "bg-rose-400 text-white" : "bg-slate-200 text-slate-500"
                }`}
                title={`${i + 1}번 ${KIND_LABEL[quiz.problems[i].kind]}: 정답 ${quiz.problems[i].answer}cm²`}
              >
                {i + 1}
              </span>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {wrongCount > 0 && (
              <button onClick={onRetryWrong} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white hover:bg-amber-600">
                ✏️ 틀린 {wrongCount}문제 다시
              </button>
            )}
            <button onClick={onRestart} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700">
              ↺ 새 문제
            </button>
            <button onClick={onExit} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
              종료
            </button>
          </div>
        </div>
      </div>
    );
  }
  const correct = quiz.result === "correct";
  const wrong = quiz.result === "wrong";
  const shown = quiz.result === "shown";
  const reveal = correct || shown;
  const stuck = quiz.attempts >= 3; // 3회 이상 오답 → 도움 제공
  return (
    <div style={{ top: topPx }} className="pointer-events-none absolute left-1/2 z-30 w-[min(94vw,620px)] -translate-x-1/2">
      <div className="pointer-events-auto rounded-2xl border-2 border-rose-300 bg-white/95 p-4 shadow-2xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-extrabold text-rose-700">🎮 문제 {quiz.index + 1} / {total}</span>
            <span className="rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">{KIND_LABEL[p!.kind]}</span>
            <span className="text-xs font-bold text-slate-500">점수 {quiz.score}</span>
          </div>
          <div className="flex items-center gap-2">
            {!reveal && (
              <button
                onClick={onReset}
                title="도형을 처음 상태로"
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50"
              >
                ↺ 도형 되돌리기
              </button>
            )}
            <button
              onClick={onToggleMute}
              title={muted ? "소리 켜기" : "소리 끄기"}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50"
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={() => {
                if (window.confirm("문제 풀기를 그만둘까요? 점수와 진행이 사라져요.")) onExit();
              }}
              className="shrink-0 text-xs font-bold text-slate-400 hover:text-slate-600"
            >
              그만두기 ✕
            </button>
          </div>
        </div>
        {/* 진행도 칩 */}
        <div className="mb-2 flex flex-wrap gap-0.5">
          {quiz.answered.map((a, i) => (
            <span
              key={i}
              className={`h-1.5 w-3 rounded-full ${
                a === "correct" ? "bg-emerald-500" : a === "wrong" ? "bg-rose-400" : i === quiz.index ? "bg-rose-300" : "bg-slate-200"
              }`}
            />
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-sm font-bold leading-relaxed text-slate-800">{p!.prompt}</div>
          {!reveal && (
            <button onClick={() => setShowMethod((v) => !v)} className="shrink-0 text-xs font-bold text-rose-500 hover:text-rose-700">
              {showMethod ? "방법 숨기기" : "💡 푸는 방법"}
            </button>
          )}
        </div>
        {!reveal && showMethod && (
          <div className="mt-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800">{KIND_HINT[p!.kind]}</div>
        )}
        {reveal ? (
          <div className={`relative mt-3 overflow-hidden rounded-xl px-4 py-3 text-center ${correct ? "bg-emerald-50" : "bg-amber-50"}`}>
            {correct && (
              <div className="pointer-events-none absolute inset-0">
                {Array.from({ length: 12 }).map((_, i) => (
                  <span key={i} className="confetti-piece" style={{ left: `${(i * 8.5 + 4) % 100}%`, animationDelay: `${(i % 5) * 0.1}s` }}>
                    {CONFETTI[i % CONFETTI.length]}
                  </span>
                ))}
              </div>
            )}
            <div className={`pop-in text-base font-extrabold ${correct ? "text-emerald-700" : "text-amber-700"}`}>
              {correct ? "🎉 정답!" : "답을 확인해요"}
            </div>
            <div className="mt-1 text-2xl font-extrabold text-slate-900">{p!.answer}cm²</div>
            <div className={`mt-1 text-xs font-medium ${correct ? "text-emerald-600" : "text-amber-600"}`}>
              {quiz.index + 1 < total ? "다음 문제로 넘어갈게요…" : "마지막 문제예요! 결과를 볼게요…"}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={quiz.userAnswer}
                onChange={(e) => onChange({ ...quiz, userAnswer: e.target.value, result: "idle" })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmit();
                }}
                inputMode="numeric"
                placeholder="답"
                className="w-28 rounded-lg border-2 border-slate-300 px-3 py-2 text-xl font-bold text-slate-900 outline-none focus:border-rose-500"
                autoFocus
              />
              <span className="text-sm font-medium text-slate-500">cm²</span>
              <button onClick={onSubmit} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700">
                확인
              </button>
            </div>
            {wrong && !stuck && (
              <div className="mt-2 text-sm font-bold text-rose-600">아쉬워요! 도형을 ✂️잘라 보거나 모눈 칸을 세어 다시 풀어 볼까요?</div>
            )}
            {wrong && stuck && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2">
                <div className="text-xs font-bold text-amber-800">💡 힌트 · {KIND_HINT[p!.kind]}</div>
                <button
                  onClick={onGiveUp}
                  className="mt-2 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100"
                >
                  답 확인하고 넘어가기
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Drawer({
  side,
  open,
  title,
  onClose,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {open && <div className="absolute inset-0 z-20 bg-slate-900/10" onClick={onClose} />}
      <div
        className={`absolute top-0 z-30 flex h-full w-[290px] max-w-[82vw] flex-col bg-white shadow-2xl transition-transform duration-200 ${
          side === "left" ? "left-0 border-r" : "right-0 border-l"
        } border-slate-200 ${open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <span className="font-bold text-slate-700">{title}</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </>
  );
}

function ShapeThumb({ preset, onClick }: { preset: Preset; onClick: () => void }) {
  const W = 110,
    H = 80,
    PAD = 8;
  const pts = preset.build();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const s = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh);
  const tx = (W - bw * s) / 2 - minX * s;
  const ty = (H - bh * s) / 2 - minY * s;
  const ptsStr = pts.map((p) => `${(p.x * s + tx).toFixed(1)},${(p.y * s + ty).toFixed(1)}`).join(" ");
  const gridStep = Math.max(8, GRID * s);
  const patternId = `g-${preset.id}`;
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-1 rounded-xl border border-slate-200 bg-white p-2 transition hover:border-sky-400 hover:bg-sky-50 active:bg-sky-100"
      title={preset.formula}
    >
      <svg width={W} height={H} className="overflow-hidden rounded-md">
        <defs>
          <pattern id={patternId} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
            <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} stroke="#e2e8f0" strokeWidth="1" fill="none" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={`url(#${patternId})`} />
        <polygon points={ptsStr} fill="#60a5fa66" stroke="#0ea5e9" strokeWidth="1.8" />
      </svg>
      <div className="text-[13px] font-bold text-slate-700 group-hover:text-sky-700">{preset.label}</div>
      <div className="text-center text-[11px] leading-tight text-slate-500">{preset.formula}</div>
    </button>
  );
}
