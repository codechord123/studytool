"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Point,
  Shape,
  cloneShapes,
  detectShapeKind,
  flipPoints,
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
  polygonPerimeter,
  pointInPolygon,
  rotatePoints,
  scalePoints,
  splitPolygonByLine,
  translatePoints,
  uid,
} from "@/lib/geometry";

type Tool = "draw" | "select" | "cut" | "delete" | "merge" | "measure" | "guide";

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
  return `약 ${r}cm`;
}
function fmtArea(cm2: number): string {
  const r = Math.round(cm2);
  if (Math.abs(cm2 - r) < 0.05) return `${r}cm²`;
  const h = Math.round(cm2 * 2) / 2;
  if (Math.abs(cm2 - h) < 0.05) return `${h}cm²`;
  return `약 ${r}cm²`;
}

type Camera = { scale: number; tx: number; ty: number };
type Measurement = { id: string; a: Point; b: Point };
type Guide = { id: string; a: Point; b: Point };
type Segment = Measurement; // {id,a,b} 공통 구조
type ActiveAux = { kind: "guide" | "measure"; id: string } | null;

// 되돌리기 단위 — 도형뿐 아니라 측정선·가이드까지 함께 스냅샷
type Snapshot = { shapes: Shape[]; measurements: Measurement[]; guides: Guide[] };
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
    }
  | { type: "vertex"; shapeId: string; vertexIndex: number }
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
  | { type: "auxMove"; kind: "guide" | "measure"; id: string; startA: Point; startB: Point; startPointer: Point };

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

type Preset = { id: string; label: string; formula: string; build: () => Point[] };

const PRESETS: Preset[] = [
  { id: "square", label: "정사각형", formula: "한 변 × 한 변", build: () => makeRectangle(0, 0, 4 * GRID, 4 * GRID) },
  { id: "rect", label: "직사각형", formula: "가로 × 세로", build: () => makeRectangle(0, 0, 8 * GRID, 4 * GRID) },
  { id: "rtri", label: "직각삼각형", formula: "밑변 × 높이 ÷ 2", build: () => makeRightTriangle(0, 0, 6 * GRID, 4 * GRID) },
  { id: "tri", label: "삼각형", formula: "밑변 × 높이 ÷ 2", build: () => makeTriangle(0, 0, 6 * GRID, 4 * GRID) },
  { id: "para", label: "평행사변형", formula: "밑변 × 높이", build: () => makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID) },
  { id: "trap", label: "사다리꼴", formula: "(윗변 + 아랫변) × 높이 ÷ 2", build: () => makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID) },
  { id: "rhom", label: "마름모", formula: "대각선 × 대각선 ÷ 2", build: () => makeRhombus(0, 0, 6 * GRID, 4 * GRID) },
  { id: "hex", label: "정육각형", formula: "여러 도형으로 나누기", build: () => makeHexagon(0, 0, 3 * GRID) },
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

const TOOL_META: { id: Tool; icon: string; label: string }[] = [
  { id: "select", icon: "🖱️", label: "선택·이동" },
  { id: "draw", icon: "✏️", label: "그리기" },
  { id: "cut", icon: "✂️", label: "자르기" },
  { id: "merge", icon: "🔗", label: "합치기" },
  { id: "measure", icon: "📏", label: "길이재기" },
  { id: "guide", icon: "📐", label: "가이드" },
  { id: "delete", icon: "🗑️", label: "삭제" },
];

const TOOL_HINT: Record<Tool, string> = {
  select: "도형을 눌러 선택 · 안쪽 드래그=이동 · 꼭짓점=변형 · 초록손잡이=회전 · 빈 곳 드래그=화면 이동",
  draw: "빈 곳을 클릭해 꼭짓점을 찍어요. 첫 점을 다시 누르거나 Enter로 도형 완성!",
  cut: "도형 위를 드래그해 잘라요. 가로·세로·대각선 모두 가능.",
  merge: "합칠 도형 두 개를 차례로 누르세요. 한 변이 맞붙어야 합쳐져요.",
  measure: "두 점을 드래그해 길이를 재요. 끝점·선을 잡아 옮기고, Delete로 지울 수 있어요.",
  guide: "점선 보조선을 그어요. 끝점·선을 잡아 옮기고 조절, Delete로 지우기. (자르기 전 ‘여기서 자를까?’)",
  delete: "지우고 싶은 도형을 누르세요.",
};

// =============================================================

export default function PolygonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeAux, setActiveAux] = useState<ActiveAux>(null);
  const [showAreaBadge, setShowAreaBadge] = useState(true);
  const [mergeFirstId, setMergeFirstId] = useState<string | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [snapStep, setSnapStep] = useState<0 | 0.2 | 0.5 | 1>(0.5);
  const [magnetic, setMagnetic] = useState(true);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const [scenarioHint, setScenarioHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [boardMode, setBoardMode] = useState(false);
  const [drawer, setDrawer] = useState<null | "shapes" | "scenarios">(null);

  const [cam, setCamState] = useState<Camera>({ scale: 1, tx: 0, ty: 0 });
  const camRef = useRef<Camera>({ scale: 1, tx: 0, ty: 0 });
  const setCam = useCallback((c: Camera) => {
    camRef.current = c;
    setCamState(c);
  }, []);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });

  const dragRef = useRef<DragMode>({ type: "none" });
  const alignGuidesRef = useRef<{ vx: number[]; hy: number[] }>({ vx: [], hy: [] });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startCam: Camera; startMid: { x: number; y: number } } | null>(null);
  const spaceRef = useRef(false);
  const colorIndexRef = useRef(0);
  const didInitRef = useRef(false);

  const selected = useMemo(() => shapes.find((s) => s.id === selectedId) ?? null, [shapes, selectedId]);

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
    return () => ro.disconnect();
  }, []);

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
    (list?: Shape[]) => {
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
      const pad = 80;
      const bw = Math.max(GRID, maxX - minX);
      const bh = Math.max(GRID, maxY - minY);
      const s = clamp(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh), MIN_SCALE, MAX_SCALE);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      setCam({ scale: s, tx: w / 2 - cx * s, ty: h / 2 - cy * s });
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
    (): Snapshot => ({ shapes: cloneShapes(shapes), measurements: cloneSegs(measurements), guides: cloneSegs(guides) }),
    [shapes, measurements, guides]
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
    setSelectedId((id) => (prev.shapes.find((s) => s.id === id) ? id : null));
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
    setSelectedId((id) => (next.shapes.find((s) => s.id === id) ? id : null));
    setActiveAux(null);
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
      if (pointInPolygon(p, shapes[i].points)) return shapes[i];
    }
    return null;
  }

  function rotationHandle(s: Shape, k: number): Point {
    const c = polygonCentroid(s.points);
    const minY = Math.min(...s.points.map((q) => q.y));
    return { x: c.x, y: minY - 40 * k };
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
    const k = 1 / camRef.current.scale;
    const raw = toWorld(sx, sy);
    const p = gridSnap(raw);

    // 화면 이동(팬): 스페이스, 가운데 버튼
    if (spaceRef.current || e.button === 1) {
      dragRef.current = { type: "pan", sx, sy, startCam: { ...camRef.current } };
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

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

    if (tool === "delete") {
      const target = topShapeAt(raw);
      if (target) {
        commitHistory();
        setShapes((all) => all.filter((s) => s.id !== target.id));
        if (selectedId === target.id) setSelectedId(null);
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
      setShapes((all) => {
        const remaining = all.filter((s) => s.id !== A.id && s.id !== hit.id);
        return [...remaining, { id: uid(), color: A.color, points: merged, ghosts }];
      });
      setMergeFirstId(null);
      setFlash("도형 두 개를 하나로 합쳤어요! 합쳐진 자국이 점선으로 보여요.");
      return;
    }

    // select
    if (selected) {
      const handle = rotationHandle(selected, k);
      if (Math.hypot(p.x - handle.x, p.y - handle.y) < 16 * k) {
        commitHistory();
        const center = polygonCentroid(selected.points);
        dragRef.current = {
          type: "rotate",
          shapeId: selected.id,
          center,
          startAngle: Math.atan2(p.y - center.y, p.x - center.x),
          startPoints: selected.points.map((q) => ({ ...q })),
          startGhosts: selected.ghosts?.map((g) => g.map((q) => ({ ...q }))),
        };
        return;
      }
      const vi = selected.points.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y) < 14 * k);
      if (vi !== -1) {
        commitHistory();
        dragRef.current = { type: "vertex", shapeId: selected.id, vertexIndex: vi };
        return;
      }
    }
    const hit = topShapeAt(raw);
    if (hit) {
      setSelectedId(hit.id);
      setActiveAux(null);
      commitHistory();
      dragRef.current = {
        type: "translate",
        shapeId: hit.id,
        startPointer: p,
        startPoints: hit.points.map((q) => ({ ...q })),
        startGhosts: hit.ghosts?.map((g) => g.map((q) => ({ ...q }))),
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
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== dm.shapeId) return s;
        if (dm.type === "translate") {
          const dx0 = p.x - dm.startPointer.x;
          const dy0 = p.y - dm.startPointer.y;
          const moved = dm.startPoints.map((q) => ({ x: q.x + dx0, y: q.y + dy0 }));
          // 1) 꼭짓점 자석 → 2) 모서리/중심 정렬(스마트 가이드)
          const mag = magnetTranslate(moved, dm.shapeId, 16 * k);
          const afterMag = moved.map((q) => ({ x: q.x + mag.dx, y: q.y + mag.dy }));
          const al = magnetic ? alignSnap(afterMag, all, dm.shapeId, 7 * k) : { dx: 0, dy: 0, vx: [], hy: [] };
          alignGuidesRef.current = { vx: al.vx, hy: al.hy };
          const tdx = mag.dx + al.dx;
          const tdy = mag.dy + al.dy;
          const finalPts = moved.map((q) => ({ x: q.x + tdx, y: q.y + tdy }));
          const finalGhosts = dm.startGhosts?.map((g) =>
            g.map((q) => ({ x: q.x + dx0 + tdx, y: q.y + dy0 + tdy }))
          );
          return { ...s, points: finalPts, ghosts: finalGhosts };
        }
        if (dm.type === "vertex") {
          const snapped = vertexSnap(p, dm.shapeId, 14 * k);
          return {
            ...s,
            points: s.points.map((q, i) => (i === dm.vertexIndex ? snapped : q)),
            ghosts: undefined,
          };
        }
        if (dm.type === "rotate") {
          const rawAng = Math.atan2(p.y - dm.center.y, p.x - dm.center.x) - dm.startAngle;
          // 15° 배수(15·30·45·90…)에 7° 이내면 자석 스냅
          const SNAP = Math.PI / 12;
          const near = Math.round(rawAng / SNAP) * SNAP;
          const ang = Math.abs(rawAng - near) < (Math.PI / 180) * 7 ? near : rawAng;
          return {
            ...s,
            points: rotatePoints(dm.startPoints, dm.center, ang),
            ghosts: dm.startGhosts?.map((g) => rotatePoints(g, dm.center, ang)),
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
    if (dm.type === "pan") {
      if (dm.maybeDeselect && !dm.moved) setSelectedId(null);
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
      if (e.key === "+" || e.key === "=") zoomCenter(1.2);
      else if (e.key === "-" || e.key === "_") zoomCenter(1 / 1.2);
      else if (e.key === "Escape") {
        setDraft([]);
        setMergeFirstId(null);
        setDrawer(null);
        dragRef.current = { type: "none" };
      } else if (e.key === "Enter" && tool === "draw" && draft.length >= 3) {
        finishDraft();
      } else if (e.key.startsWith("Arrow") && selectedId) {
        e.preventDefault();
        const base = (snapStep > 0 ? snapStep : 0.5) * GRID;
        const step = e.shiftKey ? GRID : base;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx || dy) {
          commitHistory();
          setShapes((all) =>
            all.map((s) =>
              s.id === selectedId
                ? { ...s, points: translatePoints(s.points, dx, dy), ghosts: s.ghosts?.map((g) => translatePoints(g, dx, dy)) }
                : s
            )
          );
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          commitHistory();
          setShapes((all) => all.filter((s) => s.id !== selectedId));
          setSelectedId(null);
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
  }, [tool, draft.length, selectedId, activeAux, snapStep, undo, redo, commitHistory, zoomCenter]);

  function transformSelected(fn: (pts: Point[], center: Point) => Point[]) {
    if (!selected) return;
    commitHistory();
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== selected.id) return s;
        const c = polygonCentroid(s.points);
        return { ...s, points: fn(s.points, c), ghosts: s.ghosts?.map((g) => fn(g, c)) };
      })
    );
  }

  function duplicateSelected() {
    if (!selected) return;
    commitHistory();
    const copy: Shape = {
      id: uid(),
      color: nextColor(),
      points: translatePoints(selected.points, GRID, GRID),
      ghosts: selected.ghosts?.map((g) => translatePoints(g, GRID, GRID)),
    };
    setShapes((all) => [...all, copy]);
    setSelectedId(copy.id);
  }

  function deleteSelected() {
    if (!selected) return;
    commitHistory();
    setShapes((all) => all.filter((s) => s.id !== selected.id));
    setSelectedId(null);
  }

  function addPreset(pr: Preset) {
    commitHistory();
    const { x: cx, y: cy } = viewCenterWorld();
    const s: Shape = { id: uid(), color: nextColor(), points: placeAtCenter(pr.build(), cx, cy) };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setTool("select");
  }

  function loadScenario(sc: Scenario) {
    commitHistory();
    const { x: cx, y: cy } = viewCenterWorld();
    const built = sc.build(cx, cy);
    setShapes(built);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setTool("select");
    setScenarioHint(sc.hint);
    setDrawer(null);
    requestAnimationFrame(() => fitView(built));
  }

  function clearAll() {
    commitHistory();
    setShapes([]);
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setScenarioHint(null);
    setMeasurements([]);
    setGuides([]);
  }

  function exportPNG() {
    const c = canvasRef.current;
    if (!c) return;
    try {
      const url = c.toDataURL("image/png");
      const a = document.createElement("a");
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(
        d.getHours()
      ).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      a.href = url;
      a.download = `다각형-${stamp}.png`;
      a.click();
      setFlash("현재 화면을 PNG 이미지로 저장했어요. 📷");
    } catch {
      setFlash("이미지 저장에 실패했어요. 다시 시도해 주세요.");
    }
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
    const bx0 = Math.floor(x0 / (GRID * 5)) * GRID * 5;
    const by0 = Math.floor(y0 / (GRID * 5)) * GRID * 5;
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

    for (const s of shapes) drawShape(ctx, s, s.id === selectedId, s.id === mergeFirstId, k);

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

    // 모눈 눈금 숫자 (화면 가장자리에 고정 = 자 느낌)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  }, [shapes, draft, hoverPt, selectedId, mergeFirstId, tool, cam, size, measurements, guides, boardMode, activeAux, showAreaBadge]);

  function drawShape(
    ctx: CanvasRenderingContext2D,
    s: Shape,
    isSelected: boolean,
    isMergeFirst: boolean,
    k: number
  ) {
    if (s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.fillStyle = isMergeFirst ? "#f59e0b55" : s.color + "55";
    ctx.fill();

    // 격자 칸 채우기 시각화 (선택된 축평행 직사각형) — 넓이 = 칸 수
    const rectCells = isSelected ? axisAlignedRect(s.points) : null;
    let cellInfo: { cols: number; rows: number } | null = null;
    if (rectCells) {
      const cols = Math.round(rectCells.w / GRID);
      const rows = Math.round(rectCells.h / GRID);
      if (
        cols >= 1 &&
        rows >= 1 &&
        cols * rows <= 600 &&
        Math.abs(rectCells.w - cols * GRID) < 2 &&
        Math.abs(rectCells.h - rows * GRID) < 2
      ) {
        cellInfo = { cols, rows };
        for (let i = 0; i < cols; i++)
          for (let j = 0; j < rows; j++) {
            ctx.fillStyle = (i + j) % 2 === 0 ? s.color + "33" : s.color + "1f";
            ctx.fillRect(rectCells.x + i * GRID, rectCells.y + j * GRID, GRID, GRID);
          }
        ctx.strokeStyle = s.color + "aa";
        ctx.lineWidth = 1 * k;
        ctx.beginPath();
        for (let i = 0; i <= cols; i++) {
          ctx.moveTo(rectCells.x + i * GRID, rectCells.y);
          ctx.lineTo(rectCells.x + i * GRID, rectCells.y + rectCells.h);
        }
        for (let j = 0; j <= rows; j++) {
          ctx.moveTo(rectCells.x, rectCells.y + j * GRID);
          ctx.lineTo(rectCells.x + rectCells.w, rectCells.y + j * GRID);
        }
        ctx.stroke();
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
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.strokeStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : s.color;
    ctx.lineWidth = (isMergeFirst || isSelected ? 3.5 : 2.5) * k;
    ctx.stroke();

    // 변 길이 라벨
    const baseFont = boardMode ? 20 : 16;
    ctx.font = `bold ${baseFont * k}px sans-serif`;
    const cx0 = polygonCentroid(s.points);
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const L = Math.hypot(ex, ey) || 1;
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
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    for (const v of s.points) {
      ctx.fillStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : s.color;
      ctx.beginPath();
      ctx.arc(v.x, v.y, (isSelected || isMergeFirst ? 6 : 4) * k, 0, Math.PI * 2);
      ctx.fill();
    }

    if (isSelected) {
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

    if (isMergeFirst) {
      ctx.fillStyle = "#d97706";
      ctx.font = `bold ${16 * k}px sans-serif`;
      ctx.fillText("1️⃣", s.points[0].x - 10 * k, s.points[0].y - 14 * k);
    }

    // 중앙 라벨: 칸 수(직사각형 시각화) 또는 넓이 배지 — 회전 점선 위에 그려 가독성 확보
    const centerLabel = cellInfo
      ? `${cellInfo.cols} × ${cellInfo.rows} = ${cellInfo.cols * cellInfo.rows}칸`
      : showAreaBadge
      ? fmtArea(polygonArea(s.points) / (GRID * GRID))
      : null;
    if (centerLabel) {
      const lf = (cellInfo ? (boardMode ? 19 : 16) : boardMode ? 17 : 14) * k;
      ctx.font = `bold ${lf}px sans-serif`;
      const tw = ctx.measureText(centerLabel).width;
      const padH = 8 * k;
      const boxH = lf + 9 * k;
      const bx = cx0.x - tw / 2 - padH;
      const by = cx0.y - boxH / 2;
      const bw = tw + padH * 2;
      if (cellInfo) {
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
  }

  const totalArea = useMemo(
    () => shapes.reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0),
    [shapes]
  );
  const totalPeri = useMemo(
    () => shapes.reduce((a, s) => a + polygonPerimeter(s.points) / GRID, 0),
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
      />

      {/* 빈 화면 안내 */}
      {shapes.length === 0 && draft.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-slate-200 bg-white/80 px-8 py-7 text-center shadow-xl backdrop-blur">
            <div className="text-4xl">📐✨</div>
            <div className="text-lg font-bold text-slate-800">다각형 체험을 시작해 볼까요?</div>
            <div className="text-sm leading-relaxed text-slate-500">
              왼쪽 <b>도구</b>로 직접 그리거나, 아래 버튼으로 기본 도형을 불러와요. 휠/손가락으로 자유롭게 확대·이동할 수 있어요.
            </div>
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => setDrawer("shapes")}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white shadow hover:bg-slate-800"
              >
                📐 도형 추가
              </button>
              <button
                onClick={() => setDrawer("scenarios")}
                className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-bold text-indigo-700 hover:bg-indigo-100"
              >
                📚 학습 예시
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 상단 바 */}
      {!boardMode && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-lg backdrop-blur">
            <span className="text-base font-extrabold tracking-tight text-slate-800">📐 다각형 체험실</span>
            <span className="hidden text-xs text-slate-400 md:inline">초등 5학년 · 둘레와 넓이</span>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <DrawerToggle active={drawer === "shapes"} onClick={() => setDrawer(drawer === "shapes" ? null : "shapes")} icon="📐" label="도형 추가" />
            <DrawerToggle active={drawer === "scenarios"} onClick={() => setDrawer(drawer === "scenarios" ? null : "scenarios")} icon="📚" label="학습 예시" />
          </div>

          <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-lg backdrop-blur">
              <span className="px-0.5 text-[11px] font-bold text-slate-400">격자</span>
              <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
                {([1, 0.5, 0.2, 0] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSnapStep(s)}
                    className={`rounded-md px-1.5 py-1 text-xs font-semibold transition ${
                      snapStep === s ? "bg-white text-slate-900 shadow" : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    {s === 0 ? "끄기" : s}
                  </button>
                ))}
              </div>
              <Chip active={magnetic} onClick={() => setMagnetic(!magnetic)} icon="🧲" label="자석" />
              <Chip active={showAreaBadge} onClick={() => setShowAreaBadge(!showAreaBadge)} icon="🔢" label="넓이" />
            </div>

            <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-lg backdrop-blur">
              <IconBtn onClick={undo} disabled={past.length === 0} title="되돌리기 (Ctrl+Z)">
                ↶
              </IconBtn>
              <IconBtn onClick={redo} disabled={future.length === 0} title="다시하기 (Ctrl+Shift+Z)">
                ↷
              </IconBtn>
              <Chip active={boardMode} onClick={() => setBoardMode(true)} icon="📺" label="전자칠판" tone="sky" />
              <button
                onClick={exportPNG}
                className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                title="현재 화면을 PNG 이미지로 저장"
              >
                📷 저장
              </button>
              <button
                onClick={clearAll}
                className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-100"
              >
                전체 초기화
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

      {/* 왼쪽 도구 레일 */}
      <div className="absolute left-3 top-1/2 z-10 -translate-y-1/2">
        <div className="flex flex-col gap-1.5 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-xl backdrop-blur">
          {TOOL_META.map((t) => {
            const active = tool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                title={t.label}
                className={`group relative flex h-12 w-12 items-center justify-center rounded-xl text-xl transition ${
                  active ? "bg-slate-900 text-white shadow-md" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                }`}
              >
                <span>{t.icon}</span>
                <span className="pointer-events-none absolute left-full ml-2 hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-xs font-semibold text-white group-hover:block">
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 줌 컨트롤 (좌하단) */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-lg backdrop-blur">
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

      {/* 정보 카드 (우하단) */}
      <InfoCard
        selected={selected}
        boardMode={boardMode}
        count={shapes.length}
        totalArea={totalArea}
        totalPeri={totalPeri}
      />

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
          onScale={(f) => transformSelected((pts, c) => scalePoints(pts, c, f, f))}
          onDuplicate={duplicateSelected}
          onDelete={deleteSelected}
        />
      )}

      {/* 도구 힌트 (하단 중앙, 컨텍스트바 없을 때) */}
      {!selected && !boardMode && shapes.length > 0 && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-0 -translate-x-1/2 rounded-full border border-slate-200 bg-white/85 px-4 py-1.5 text-xs text-slate-500 shadow backdrop-blur">
          {TOOL_HINT[tool]}
        </div>
      )}

      {/* 토스트 (상단 중앙) */}
      <div className="pointer-events-none absolute left-1/2 top-16 z-20 flex w-[min(92vw,640px)] -translate-x-1/2 flex-col gap-2">
        {flash && (
          <div className="pointer-events-auto rounded-2xl border border-sky-200 bg-sky-50/95 px-4 py-2.5 text-sm text-sky-900 shadow-lg backdrop-blur">
            {flash}
          </div>
        )}
        {scenarioHint && (
          <div className="pointer-events-auto flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/95 px-4 py-3 text-sm text-amber-900 shadow-lg backdrop-blur">
            <span>💡</span>
            <span className="flex-1">{scenarioHint}</span>
            <button className="shrink-0 text-xs font-bold text-amber-700 underline" onClick={() => setScenarioHint(null)}>
              닫기
            </button>
          </div>
        )}
      </div>

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
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "sky";
}) {
  const activeCls = tone === "sky" ? "border-sky-600 bg-sky-600 text-white" : "border-slate-900 bg-slate-900 text-white";
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
        active ? activeCls : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      <span>{icon}</span>
      {label}
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
      className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
        active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      <span>{icon}</span>
      {label}
    </button>
  );
}

function InfoCard({
  selected,
  boardMode,
  count,
  totalArea,
  totalPeri,
}: {
  selected: Shape | null;
  boardMode: boolean;
  count: number;
  totalArea: number;
  totalPeri: number;
}) {
  const kind = useMemo(() => (selected ? detectShapeKind(selected.points) : null), [selected]);
  if (count === 0) return null;
  const area = selected ? polygonArea(selected.points) / (GRID * GRID) : totalArea;
  const peri = selected ? polygonPerimeter(selected.points) / GRID : totalPeri;
  const big = boardMode ? "text-2xl" : "text-xl";
  return (
    <div className="absolute bottom-3 right-3 z-10 w-[min(86vw,260px)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
      {selected && kind ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="h-6 w-6 shrink-0 rounded-md ring-1 ring-black/5" style={{ backgroundColor: selected.color }} />
          <div className="leading-tight">
            <div className="font-extrabold text-slate-800">{kind.name}</div>
            {kind.formula && <div className="text-[11px] font-medium text-amber-700">공식 · {kind.formula}</div>}
          </div>
        </div>
      ) : (
        <div className="mb-2 text-sm font-bold text-slate-500">📊 전체 도형 {count}개</div>
      )}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-semibold text-slate-400">넓이</div>
          <div className={`font-extrabold text-slate-900 ${big}`}>{fmtArea(area)}</div>
        </div>
        <div className="flex-1 rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-semibold text-slate-400">둘레</div>
          <div className={`font-extrabold text-slate-900 ${big}`}>{fmtLen(peri)}</div>
        </div>
      </div>
    </div>
  );
}

function ContextBar({
  shape,
  onRotate,
  onFlip,
  onScale,
  onDuplicate,
  onDelete,
}: {
  shape: Shape;
  onRotate: (deg: number) => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
  onScale: (f: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const mini =
    "grid h-9 min-w-[38px] place-items-center rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
  return (
    <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-end gap-3 rounded-2xl border border-amber-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur">
        <MiniGroup label="회전">
          <button className={mini} onClick={() => onRotate(-90)} title="시계 반대 90°">
            ↶90°
          </button>
          <button className={mini} onClick={() => onRotate(90)} title="시계 90°">
            ↷90°
          </button>
          <button className={mini} onClick={() => onRotate(180)} title="180°">
            180°
          </button>
        </MiniGroup>
        <MiniGroup label="뒤집기">
          <button className={mini} onClick={() => onFlip("horizontal")} title="좌우 뒤집기">
            ↔
          </button>
          <button className={mini} onClick={() => onFlip("vertical")} title="위아래 뒤집기">
            ↕
          </button>
        </MiniGroup>
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
