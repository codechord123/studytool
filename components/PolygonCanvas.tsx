"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// 1cm = 80px (이전 40px → 2배로 크게 보이도록)
const GRID = 80;
const CANVAS_W = 1600;
const CANVAS_H = 720; // 9cm 높이. 1080p 한 화면에 헤더+툴바+캔버스+힌트 모두 들어가도록
const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
const HISTORY_LIMIT = 50;

// 길이/넓이를 전자칠판에서 보기 좋게 (정수 ≒ → 정수, 반정수 ≒ → x.5, 그 외 → 약 X)
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
function fmtLenNum(cm: number): string {
  const r = Math.round(cm);
  if (Math.abs(cm - r) < 0.05) return `${r}`;
  const h = Math.round(cm * 2) / 2;
  if (Math.abs(cm - h) < 0.05) return `${h}`;
  return `~${r}`;
}

type Measurement = { id: string; a: Point; b: Point };
type Guide = { id: string; a: Point; b: Point };

type DragMode =
  | { type: "none" }
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
  | { type: "guide"; start: Point; current: Point };

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

// =============================================================

export default function PolygonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [past, setPast] = useState<Shape[][]>([]);
  const [future, setFuture] = useState<Shape[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mergeFirstId, setMergeFirstId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // 격자 스냅 단위 (cm). 0 = 끄기
  const [snapStep, setSnapStep] = useState<0 | 0.2 | 0.5 | 1>(0.5);
  const [magnetic, setMagnetic] = useState(true);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const [scenarioHint, setScenarioHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [magnifierOn, setMagnifierOn] = useState(false);
  const [magnifierPos, setMagnifierPos] = useState<Point | null>(null);
  const [boardMode, setBoardMode] = useState(false);
  const [showPalette, setShowPalette] = useState(true);
  const [showScenarios, setShowScenarios] = useState(false);
  const dragRef = useRef<DragMode>({ type: "none" });
  const colorIndexRef = useRef(0);

  const [cssScale, setCssScale] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const byW = w / CANVAS_W;
      // 컨테이너가 세로로 제한될 때(PC 한 화면 모드)는 높이에도 맞춤.
      // 높이 제약이 없는 모바일 흐름에서는 byH가 byW로 수렴해 가로 기준만 적용됨.
      const byH = h > 0 ? h / CANVAS_H : byW;
      setCssScale(Math.min(1, byW, byH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selected = useMemo(() => shapes.find((s) => s.id === selectedId) ?? null, [shapes, selectedId]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  const commitHistory = useCallback(() => {
    setPast((p) => {
      const next = [...p, cloneShapes(shapes)];
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    });
    setFuture([]);
  }, [shapes]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [cloneShapes(shapes), ...f]);
    setPast((p) => p.slice(0, -1));
    setShapes(prev);
    setSelectedId((id) => (prev.find((s) => s.id === id) ? id : null));
    setMergeFirstId(null);
    setDraft([]);
    dragRef.current = { type: "none" };
  }, [past, shapes]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, cloneShapes(shapes)]);
    setFuture((f) => f.slice(1));
    setShapes(next);
    setSelectedId((id) => (next.find((s) => s.id === id) ? id : null));
  }, [future, shapes]);

  const getPt = (e: React.PointerEvent): Point => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return gridSnap({ x, y });
  };
  const gridSnap = (p: Point): Point => {
    if (snapStep === 0) return p;
    const step = snapStep * GRID;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  };
  // 임의의 점을 가장 가까운 폴리곤 꼭짓점에 “자석” 스냅 (toler 이내일 때)
  const vertexSnap = (p: Point, excludeShapeId?: string, tol = 16): Point => {
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
  };
  // 도형 전체를 평행이동할 때, 가장 가까운 (자기 꼭짓점 ↔ 다른 도형 꼭짓점) 쌍을 찾아 보정
  const magnetTranslate = (pts: Point[], excludeShapeId: string, tol = 16): { dx: number; dy: number } => {
    if (!magnetic) return { dx: 0, dy: 0 };
    let bestD = tol;
    let best: { dx: number; dy: number } = { dx: 0, dy: 0 };
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
  };

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

  function rotationHandle(s: Shape): Point {
    const c = polygonCentroid(s.points);
    const minY = Math.min(...s.points.map((q) => q.y));
    return { x: c.x, y: minY - 40 };
  }

  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const p = getPt(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    if (tool === "draw") {
      if (draft.length >= 3) {
        const first = draft[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) < 14) {
          finishDraft();
          return;
        }
      }
      setDraft((d) => [...d, p]);
      return;
    }

    if (tool === "delete") {
      const target = topShapeAt(p);
      if (target) {
        commitHistory();
        setShapes((all) => all.filter((s) => s.id !== target.id));
        if (selectedId === target.id) setSelectedId(null);
      }
      return;
    }

    if (tool === "cut") {
      // 자르기 시작점도 가장 가까운 꼭짓점에 자석 스냅 (모서리끼리 자르기 지원)
      const startPt = vertexSnap(p, undefined, 16);
      dragRef.current = { type: "cut", start: startPt, current: startPt };
      return;
    }

    if (tool === "measure") {
      const startPt = vertexSnap(p, undefined, 16);
      dragRef.current = { type: "measure", start: startPt, current: startPt };
      return;
    }

    if (tool === "guide") {
      const startPt = vertexSnap(p, undefined, 16);
      dragRef.current = { type: "guide", start: startPt, current: startPt };
      return;
    }

    if (tool === "merge") {
      const hit = topShapeAt(p);
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

    if (tool === "select") {
      if (selected) {
        const handle = rotationHandle(selected);
        if (Math.hypot(p.x - handle.x, p.y - handle.y) < 16) {
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
        const vi = selected.points.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y) < 14);
        if (vi !== -1) {
          commitHistory();
          dragRef.current = { type: "vertex", shapeId: selected.id, vertexIndex: vi };
          return;
        }
      }
      const hit = topShapeAt(p);
      if (hit) {
        setSelectedId(hit.id);
        commitHistory();
        dragRef.current = {
          type: "translate",
          shapeId: hit.id,
          startPointer: p,
          startPoints: hit.points.map((q) => ({ ...q })),
          startGhosts: hit.ghosts?.map((g) => g.map((q) => ({ ...q }))),
        };
      } else {
        setSelectedId(null);
      }
    }
  }

  function handleCanvasPointerMove(e: React.PointerEvent) {
    const p = getPt(e);
    setHoverPt(p);
    if (magnifierOn) setMagnifierPos(p);
    const dm = dragRef.current;
    if (dm.type === "none") return;
    if (dm.type === "cut") {
      // 자르기 끝점도 꼭짓점에 자석 스냅
      const cur = vertexSnap(p, undefined, 16);
      dragRef.current = { ...dm, current: cur };
      return;
    }
    if (dm.type === "measure") {
      const cur = vertexSnap(p, undefined, 16);
      dragRef.current = { ...dm, current: cur };
      return;
    }
    if (dm.type === "guide") {
      const cur = vertexSnap(p, undefined, 16);
      dragRef.current = { ...dm, current: cur };
      return;
    }
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== dm.shapeId) return s;
        if (dm.type === "translate") {
          const dx0 = p.x - dm.startPointer.x;
          const dy0 = p.y - dm.startPointer.y;
          const moved = dm.startPoints.map((q) => ({ x: q.x + dx0, y: q.y + dy0 }));
          // 자석 보정 — 가장 가까운 꼭짓점 쌍이 정확히 만나도록
          const { dx: mdx, dy: mdy } = magnetTranslate(moved, dm.shapeId, 16);
          const finalPts = moved.map((q) => ({ x: q.x + mdx, y: q.y + mdy }));
          const finalGhosts = dm.startGhosts?.map((g) =>
            g.map((q) => ({ x: q.x + dx0 + mdx, y: q.y + dy0 + mdy }))
          );
          return { ...s, points: finalPts, ghosts: finalGhosts };
        }
        if (dm.type === "vertex") {
          // 꼭짓점 드래그도 다른 도형 꼭짓점에 자석 스냅
          const snapped = vertexSnap(p, dm.shapeId, 14);
          return {
            ...s,
            points: s.points.map((q, i) => (i === dm.vertexIndex ? snapped : q)),
            ghosts: undefined,
          };
        }
        if (dm.type === "rotate") {
          const ang = Math.atan2(p.y - dm.center.y, p.x - dm.center.x) - dm.startAngle;
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

  function handleCanvasPointerUp(e: React.PointerEvent) {
    const dm = dragRef.current;
    if (dm.type === "cut") {
      const raw = getPt(e);
      const b = vertexSnap(raw, undefined, 16);
      const a = dm.start;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4) applyCut(a, b);
    } else if (dm.type === "measure") {
      const raw = getPt(e);
      const b = vertexSnap(raw, undefined, 16);
      const a = dm.start;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 8) {
        setMeasurements((m) => [...m, { id: uid(), a, b }]);
      }
    } else if (dm.type === "guide") {
      const raw = getPt(e);
      const b = vertexSnap(raw, undefined, 16);
      const a = dm.start;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 8) {
        setGuides((g) => [...g, { id: uid(), a, b }]);
      }
    }
    dragRef.current = { type: "none" };
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.ctrlKey || e.metaKey;
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
      if (e.key === "Escape") {
        setDraft([]);
        setMergeFirstId(null);
        dragRef.current = { type: "none" };
      } else if (e.key === "Enter" && tool === "draw" && draft.length >= 3) {
        finishDraft();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        commitHistory();
        setShapes((all) => all.filter((s) => s.id !== selectedId));
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, draft.length, selectedId, undo, redo, commitHistory]);

  function transformSelected(fn: (pts: Point[], center: Point) => Point[]) {
    if (!selected) return;
    commitHistory();
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== selected.id) return s;
        const c = polygonCentroid(s.points);
        return {
          ...s,
          points: fn(s.points, c),
          ghosts: s.ghosts?.map((g) => fn(g, c)),
        };
      })
    );
  }

  function addPreset(p: Preset) {
    commitHistory();
    const cx = Math.round(CANVAS_W / 2 / GRID) * GRID;
    const cy = Math.round(CANVAS_H / 2 / GRID) * GRID;
    const s: Shape = { id: uid(), color: nextColor(), points: placeAtCenter(p.build(), cx, cy) };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setTool("select");
  }

  function loadScenario(sc: Scenario) {
    commitHistory();
    const cx = Math.round(CANVAS_W / 2 / GRID) * GRID;
    const cy = Math.round(CANVAS_H / 2 / GRID) * GRID;
    setShapes(sc.build(cx, cy));
    setSelectedId(null);
    setMergeFirstId(null);
    setDraft([]);
    setTool("select");
    setScenarioHint(sc.hint);
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


  // ----- 캔버스 렌더링 (DPR + cssScale 보정) -----
  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
    const needW = Math.round(CANVAS_W * dpr);
    const needH = Math.round(CANVAS_H * dpr);
    if (c.width !== needW) c.width = needW;
    if (c.height !== needH) c.height = needH;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 화면상 실제 픽셀로 보이는 크기를 일정하게 유지하기 위한 가독성 보정 계수
    const k = 1 / Math.max(0.45, cssScale);

    // ── 모눈종이 배경 ──
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1 * k;
    for (let x = 0; x <= CANVAS_W; x += GRID) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += GRID) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 2 * k;
    for (let x = 0; x <= CANVAS_W; x += GRID * 5) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += GRID * 5) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#475569";
    const gridFont = boardMode ? 18 : 14;
    ctx.font = `bold ${gridFont * k}px sans-serif`;
    for (let x = GRID * 5; x < CANVAS_W; x += GRID * 5) ctx.fillText(`${x / GRID}`, x + 3 * k, gridFont * k + 2 * k);
    for (let y = GRID * 5; y < CANVAS_H; y += GRID * 5) ctx.fillText(`${y / GRID}`, 3 * k, y + gridFont * k);

    for (const s of shapes) drawShape(ctx, s, s.id === selectedId, s.id === mergeFirstId, k);

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

    const dm = dragRef.current;
    if (tool === "cut" && dm.type === "cut") {
      const a = dm.start;
      const b = dm.current;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = (dx / len) * 2000;
      const ey = (dy / len) * 2000;
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
      ctx.beginPath();
      ctx.arc(a.x, a.y, 6 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6 * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // 측정선 (저장된 + 그리는 중)
    const drawRuler = (a: Point, b: Point, color: string) => {
      const dist = Math.hypot(b.x - a.x, b.y - a.y) / GRID;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // 양 끝 작은 직각 tick
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const tx = -dy / L;
      const ty = dx / L;
      const t = 9 * k;
      [a, b].forEach((p) => {
        ctx.beginPath();
        ctx.moveTo(p.x - tx * t, p.y - ty * t);
        ctx.lineTo(p.x + tx * t, p.y + ty * t);
        ctx.stroke();
      });
      // 1cm 마다 작은 눈금
      const cm = L / GRID;
      const steps = Math.floor(cm);
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
      // 라벨
      const mx = (a.x + b.x) / 2 + tx * 22 * k;
      const my = (a.y + b.y) / 2 + ty * 22 * k;
      const text = fmtLen(dist);
      const f = boardMode ? 24 : 20;
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
    };
    for (const m of measurements) drawRuler(m.a, m.b, "#7c3aed");
    if (tool === "measure" && dm.type === "measure") drawRuler(dm.start, dm.current, "#a855f7");

    // 가이드 직선 (자르기/생각하기 보조선)
    const drawGuide = (a: Point, b: Point, color: string, dashed: boolean) => {
      ctx.save();
      if (dashed) ctx.setLineDash([12 * k, 8 * k]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * k;
      // 양 끝을 살짝 확장한 직선
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
      // 양 끝 동그라미
      ctx.fillStyle = color;
      [a, b].forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * k, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    for (const g of guides) drawGuide(g.a, g.b, "#0f172a", true);
    if (tool === "guide" && dm.type === "guide") drawGuide(dm.start, dm.current, "#475569", true);

    // 돋보기 — 클립+확대로 다시 한 번 일부 영역을 그려 보여 줌
    if (magnifierOn && magnifierPos) {
      const r = 110;
      const zoom = 2;
      const mx = magnifierPos.x;
      const my = magnifierPos.y;
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.clip();
      // 확대된 좌표계 설정: 돋보기 중심을 기준으로 zoom
      ctx.translate(mx, my);
      ctx.scale(zoom, zoom);
      ctx.translate(-mx, -my);
      // 모눈 + 도형 다시 그리기 (간소화)
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1 * k;
      const startGx = Math.floor((mx - r) / GRID) * GRID;
      const endGx = Math.ceil((mx + r) / GRID) * GRID;
      const startGy = Math.floor((my - r) / GRID) * GRID;
      const endGy = Math.ceil((my + r) / GRID) * GRID;
      for (let x = startGx; x <= endGx; x += GRID) {
        ctx.beginPath();
        ctx.moveTo(x, startGy);
        ctx.lineTo(x, endGy);
        ctx.stroke();
      }
      for (let y = startGy; y <= endGy; y += GRID) {
        ctx.beginPath();
        ctx.moveTo(startGx, y);
        ctx.lineTo(endGx, y);
        ctx.stroke();
      }
      for (const s of shapes) drawShape(ctx, s, s.id === selectedId, s.id === mergeFirstId, k);
      ctx.restore();
      // 돋보기 테두리
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 4 * k;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#0f172a";
      ctx.font = `bold ${14 * k}px sans-serif`;
      ctx.fillText("🔍 ×2", mx - 24 * k, my - r - 8 * k);
    }
  }, [shapes, draft, hoverPt, selectedId, mergeFirstId, tool, cssScale, measurements, guides, magnifierOn, magnifierPos, boardMode]);

  function drawShape(
    ctx: CanvasRenderingContext2D,
    s: Shape,
    isSelected: boolean,
    isMergeFirst: boolean,
    k: number
  ) {
    if (s.points.length < 2) return;

    // 1) 채우기
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.fillStyle = isMergeFirst ? "#f59e0b55" : s.color + "55";
    ctx.fill();

    // 2) 합쳐진 자국 (희미한 점선)
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

    // 3) 외곽선
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.strokeStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : s.color;
    ctx.lineWidth = (isMergeFirst || isSelected ? 3.5 : 2.5) * k;
    ctx.stroke();

    // 4) 변 길이 라벨 (변 바깥쪽으로 약간 밀어 표시)
    const baseFont = boardMode ? 22 : 18;
    ctx.font = `bold ${baseFont * k}px sans-serif`;
    const cx0 = polygonCentroid(s.points);
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // 변에 수직, 도형 바깥 방향 단위벡터
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const L = Math.hypot(ex, ey) || 1;
      // 두 가지 후보 중 무게중심 반대 방향(외부) 선택
      const nA = { x: -ey / L, y: ex / L };
      const nB = { x: ey / L, y: -ex / L };
      const toCx = { x: cx0.x - mx, y: cx0.y - my };
      const dotA = nA.x * toCx.x + nA.y * toCx.y;
      const out = dotA > 0 ? nB : nA; // 무게중심 반대편
      const off = 18 * k; // 변 밖으로 띄우기
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
      const boxX = tx0 - tw / 2 - padH;
      const boxY = ty0 - boxH / 2;
      ctx.fillRect(boxX, boxY, tw + padH * 2, boxH);
      ctx.strokeRect(boxX, boxY, tw + padH * 2, boxH);
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, tx0, ty0);
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    // 5) 꼭짓점
    for (const v of s.points) {
      ctx.fillStyle = isMergeFirst ? "#d97706" : isSelected ? "#0f172a" : s.color;
      ctx.beginPath();
      ctx.arc(v.x, v.y, (isSelected || isMergeFirst ? 6 : 4) * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // 6) 도형 번호 작게 (상단 요약 바와 매칭) — 무게중심 부근에 작은 색 원
    const c = polygonCentroid(s.points);

    // 7) 회전 핸들 (점선 leader 선)
    if (isSelected) {
      const h = rotationHandle(s);
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
  }

  const totalArea = useMemo(
    () => shapes.reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0),
    [shapes]
  );
  const totalPeri = useMemo(
    () => shapes.reduce((a, s) => a + polygonPerimeter(s.points) / GRID, 0),
    [shapes]
  );

  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <Toolbar
        tool={tool}
        setTool={(t) => {
          setTool(t);
          setDraft([]);
          setMergeFirstId(null);
          dragRef.current = { type: "none" };
        }}
        snapStep={snapStep}
        setSnapStep={setSnapStep}
        magnetic={magnetic}
        setMagnetic={setMagnetic}
        onFinishDraw={finishDraft}
        canFinish={draft.length >= 3}
        onClear={clearAll}
        onDuplicate={() => {
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
        }}
        hasSelection={!!selected}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onUndo={undo}
        onRedo={redo}
        magnifierOn={magnifierOn}
        setMagnifierOn={(v) => {
          setMagnifierOn(v);
          if (!v) setMagnifierPos(null);
        }}
        boardMode={boardMode}
        setBoardMode={setBoardMode}
        onClearMeasurements={() => setMeasurements([])}
        measurementsCount={measurements.length}
        onClearGuides={() => setGuides([])}
        guidesCount={guides.length}
        showPalette={showPalette}
        setShowPalette={setShowPalette}
        showScenarios={showScenarios}
        setShowScenarios={setShowScenarios}
      />

      {flash && (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm sm:text-base text-sky-900 shadow-sm">
          {flash}
        </div>
      )}
      {scenarioHint && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm sm:text-base text-amber-900 shadow-sm">
          💡 {scenarioHint}
          <button
            className="ml-3 text-xs sm:text-sm text-amber-700 underline"
            onClick={() => setScenarioHint(null)}
          >
            닫기
          </button>
        </div>
      )}

      {selected && (
        <SelectedStrip
          shape={selected}
          boardMode={boardMode}
          onRotate={(deg) =>
            transformSelected((pts, c) => rotatePoints(pts, c, (deg * Math.PI) / 180))
          }
          onFlip={(axis) => transformSelected((pts, c) => flipPoints(pts, c, axis))}
          onScale={(f) => transformSelected((pts, c) => scalePoints(pts, c, f, f))}
        />
      )}

      <div
        className={`grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] ${
          boardMode
            ? ""
            : !showPalette && !showScenarios
            ? ""
            : showPalette && showScenarios
            ? "lg:grid-cols-[210px_minmax(0,1fr)_260px]"
            : showPalette
            ? "lg:grid-cols-[210px_minmax(0,1fr)]"
            : "lg:grid-cols-[minmax(0,1fr)_260px]"
        }`}
      >
        {!boardMode && showPalette && (
          <ShapePalette presets={PRESETS} onAdd={addPreset} />
        )}

        <div className="flex flex-col gap-3 min-w-0 lg:min-h-0">
          <SummaryBar
            shapes={shapes}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            boardMode={boardMode}
          />
          <div
            ref={wrapRef}
            className="flex w-full items-center justify-center overflow-hidden rounded-2xl border border-slate-200 shadow-sm bg-white lg:min-h-0 lg:flex-1"
            style={{ touchAction: "none" }}
          >
            <div style={{ width: CANVAS_W * cssScale, height: CANVAS_H * cssScale }}>
              <canvas
                ref={canvasRef}
                style={{
                  width: CANVAS_W * cssScale,
                  height: CANVAS_H * cssScale,
                  cursor:
                    magnifierOn
                      ? "none"
                      : tool === "draw" || tool === "cut" || tool === "measure" || tool === "guide"
                      ? "crosshair"
                      : tool === "delete"
                      ? "not-allowed"
                      : tool === "merge"
                      ? "pointer"
                      : "default",
                  display: "block",
                  touchAction: "none",
                }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
              />
            </div>
          </div>
        </div>

        {!boardMode && showScenarios && (
          <ScenariosAside groups={SCENARIO_GROUPS} onLoad={loadScenario} />
        )}
      </div>

      {!boardMode && <ToolHint tool={tool} mergeFirst={!!mergeFirstId} />}
    </div>
  );
}

// ====================== UI ======================

function Toolbar(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  snapStep: 0 | 0.2 | 0.5 | 1;
  setSnapStep: (s: 0 | 0.2 | 0.5 | 1) => void;
  magnetic: boolean;
  setMagnetic: (b: boolean) => void;
  onFinishDraw: () => void;
  canFinish: boolean;
  onClear: () => void;
  onDuplicate: () => void;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  magnifierOn: boolean;
  setMagnifierOn: (b: boolean) => void;
  boardMode: boolean;
  setBoardMode: (b: boolean) => void;
  onClearMeasurements: () => void;
  measurementsCount: number;
  onClearGuides: () => void;
  guidesCount: number;
  showPalette: boolean;
  setShowPalette: (b: boolean) => void;
  showScenarios: boolean;
  setShowScenarios: (b: boolean) => void;
}) {
  const btn = (active: boolean) =>
    `px-3 py-2.5 rounded-lg text-sm sm:text-base font-medium border transition min-h-[44px] ${
      active
        ? "bg-slate-900 text-white border-slate-900"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 active:bg-slate-100"
    }`;
  const ab =
    "px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 rounded-2xl border border-slate-200 bg-white p-2 sm:p-3 shadow-sm">
      <div className="flex gap-1.5 flex-wrap">
        <button className={btn(props.tool === "draw")} onClick={() => props.setTool("draw")}>✏️ 그리기</button>
        <button className={btn(props.tool === "select")} onClick={() => props.setTool("select")}>🖱️ 선택/이동</button>
        <button className={btn(props.tool === "cut")} onClick={() => props.setTool("cut")}>✂️ 자르기</button>
        <button className={btn(props.tool === "merge")} onClick={() => props.setTool("merge")}>🔗 합치기</button>
        <button className={btn(props.tool === "measure")} onClick={() => props.setTool("measure")}>📏 길이재기</button>
        <button className={btn(props.tool === "guide")} onClick={() => props.setTool("guide")}>📐 직선 가이드</button>
        <button className={btn(props.tool === "delete")} onClick={() => props.setTool("delete")}>🗑️ 삭제</button>
      </div>
      <div className="h-6 w-px bg-slate-200 hidden sm:block" />
      <button
        className={`${ab} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
        disabled={!props.canFinish}
        onClick={props.onFinishDraw}
      >✅ 도형 완성</button>
      <button
        className={`${ab} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}
        disabled={!props.hasSelection}
        onClick={props.onDuplicate}
      >📋 복사</button>
      <div className="h-6 w-px bg-slate-200 hidden sm:block" />
      <button
        className={`${ab} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}
        disabled={!props.canUndo}
        onClick={props.onUndo}
        title="Ctrl/Cmd+Z"
      >↶ 되돌리기</button>
      <button
        className={`${ab} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}
        disabled={!props.canRedo}
        onClick={props.onRedo}
        title="Ctrl/Cmd+Shift+Z"
      >↷ 다시하기</button>
      <div className="flex items-center gap-1.5 flex-wrap px-1">
        <span className="text-xs sm:text-sm text-slate-600 font-medium">격자 스냅</span>
        {([1, 0.5, 0.2, 0] as const).map((s) => (
          <button
            key={s}
            onClick={() => props.setSnapStep(s)}
            className={`px-2.5 py-1.5 text-xs sm:text-sm rounded-md border min-h-[36px] ${
              props.snapStep === s
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {s === 0 ? "끄기" : `${s}cm`}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm sm:text-base text-slate-700 px-2 min-h-[36px] cursor-pointer">
        <input
          type="checkbox"
          checked={props.magnetic}
          onChange={(e) => props.setMagnetic(e.target.checked)}
          className="w-4 h-4"
        />
        🧲 자석
      </label>
      <button
        onClick={() => props.setMagnifierOn(!props.magnifierOn)}
        className={`px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] ${
          props.magnifierOn
            ? "bg-amber-500 text-white border-amber-600"
            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
        }`}
      >🔍 돋보기</button>
      <button
        onClick={() => props.setBoardMode(!props.boardMode)}
        className={`px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] ${
          props.boardMode
            ? "bg-sky-600 text-white border-sky-700"
            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
        }`}
        title="전자칠판/프로젝터 모드 (큰 라벨, 사이드바 접기)"
      >📺 전자칠판</button>
      <button
        onClick={() => props.setShowPalette(!props.showPalette)}
        className={`px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] ${
          props.showPalette
            ? "bg-slate-900 text-white border-slate-900"
            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
        }`}
        title="도형 추가 패널 열기/닫기"
      >📐 도형 추가</button>
      <button
        onClick={() => props.setShowScenarios(!props.showScenarios)}
        className={`px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] ${
          props.showScenarios
            ? "bg-slate-900 text-white border-slate-900"
            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
        }`}
        title="학습 예시 패널 열기/닫기"
      >📚 학습 예시</button>
      {props.measurementsCount > 0 && (
        <button
          onClick={props.onClearMeasurements}
          className="px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100"
        >📏 측정선 지우기 ({props.measurementsCount})</button>
      )}
      {props.guidesCount > 0 && (
        <button
          onClick={props.onClearGuides}
          className="px-3 py-2.5 text-sm sm:text-base font-medium rounded-lg border min-h-[44px] border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
        >📐 가이드선 지우기 ({props.guidesCount})</button>
      )}
      <div className="sm:ml-auto">
        <button
          className={`${ab} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}
          onClick={props.onClear}
        >전체 초기화</button>
      </div>
    </div>
  );
}

function ShapePalette({ presets, onAdd }: { presets: Preset[]; onAdd: (p: Preset) => void }) {
  return (
    <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:min-h-0 lg:overflow-y-auto">
      <div className="mb-2 text-sm sm:text-base font-semibold text-slate-700">📐 도형 추가</div>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-2 gap-2">
        {presets.map((p) => (
          <ShapeThumb key={p.id} preset={p} onClick={() => onAdd(p)} />
        ))}
      </div>
    </aside>
  );
}

function ShapeThumb({ preset, onClick }: { preset: Preset; onClick: () => void }) {
  const W = 96, H = 72, PAD = 8;
  const pts = preset.build();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
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
      className="group flex flex-col items-center gap-1 rounded-xl border border-slate-200 bg-white p-2 hover:border-sky-400 hover:bg-sky-50 active:bg-sky-100 transition min-h-[44px]"
      title={preset.formula}
    >
      <svg width={W} height={H} className="rounded-md overflow-hidden">
        <defs>
          <pattern id={patternId} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
            <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} stroke="#e2e8f0" strokeWidth="1" fill="none" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={`url(#${patternId})`} />
        <polygon points={ptsStr} fill="#60a5fa66" stroke="#0ea5e9" strokeWidth="1.8" />
      </svg>
      <div className="text-[12px] sm:text-[13px] font-semibold text-slate-700 group-hover:text-sky-700">
        {preset.label}
      </div>
      <div className="text-[10px] sm:text-[11px] text-slate-500 text-center leading-tight">
        {preset.formula}
      </div>
    </button>
  );
}


function SummaryBar({
  shapes,
  selectedId,
  onSelect,
  boardMode,
}: {
  shapes: Shape[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  boardMode: boolean;
}) {
  if (shapes.length === 0) return null;
  const sizing = boardMode
    ? "text-base sm:text-lg lg:text-xl"
    : "text-sm sm:text-base";
  const headingSize = boardMode ? "text-lg sm:text-xl" : "text-base sm:text-lg";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-2 sm:p-3">
      <div className={`px-1 pb-1 font-semibold text-slate-600 ${headingSize}`}>
        📊 도형별 둘레와 넓이
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shapes.map((s, i) => {
          const area = polygonArea(s.points) / (GRID * GRID);
          const peri = polygonPerimeter(s.points) / GRID;
          const sel = s.id === selectedId;
          const sName = `${s.points.length}각형`;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`shrink-0 flex items-center gap-3 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl border-2 transition ${
                sel
                  ? "border-slate-900 bg-slate-50 ring-2 ring-slate-200"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              } ${sizing}`}
              style={{ borderLeftWidth: 8, borderLeftColor: s.color }}
            >
              <span className="font-bold text-slate-700">#{i + 1}</span>
              <span className="text-slate-500">{sName}</span>
              <span className="text-slate-300">|</span>
              <span>
                <span className="text-slate-500">넓이</span>{" "}
                <b className="text-slate-900">{fmtArea(area)}</b>
              </span>
              <span className="text-slate-300">|</span>
              <span>
                <span className="text-slate-500">둘레</span>{" "}
                <b className="text-slate-900">{fmtLen(peri)}</b>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScenariosAside({
  groups,
  onLoad,
}: {
  groups: ScenarioGroup[];
  onLoad: (sc: Scenario) => void;
}) {
  return (
    <aside className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3 shadow-sm lg:min-h-0 lg:max-h-full lg:overflow-y-auto">
      <div className="mb-2 text-sm sm:text-base font-semibold text-indigo-800">📚 학습 예시</div>
      <div className="flex flex-col gap-2">
        {groups.map((g, gi) => (
          <details
            key={g.shape}
            open={gi === 0}
            className="rounded-xl bg-white border border-indigo-100 px-3 py-2"
          >
            <summary className="cursor-pointer text-sm sm:text-base font-semibold text-indigo-900 marker:text-indigo-400 min-h-[40px] flex items-center">
              {g.shape}
            </summary>
            <div className="mt-1 text-[12px] sm:text-sm text-indigo-700 font-medium">
              공식: {g.formula}
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {g.scenarios.map((sc) => (
                <button
                  key={sc.label}
                  className="text-left text-[13px] sm:text-sm px-2.5 py-2 rounded-md border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 active:bg-indigo-200 text-indigo-900 min-h-[36px]"
                  onClick={() => onLoad(sc)}
                >
                  {sc.label}
                </button>
              ))}
            </div>
          </details>
        ))}
      </div>
    </aside>
  );
}

function SelectedStrip({
  shape,
  boardMode,
  onRotate,
  onFlip,
  onScale,
}: {
  shape: Shape;
  boardMode: boolean;
  onRotate: (deg: number) => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
  onScale: (f: number) => void;
}) {
  const kind = useMemo(() => detectShapeKind(shape.points), [shape]);
  const area = polygonArea(shape.points) / (GRID * GRID);
  const peri = polygonPerimeter(shape.points) / GRID;
  const txt = boardMode ? "text-base sm:text-lg" : "text-sm sm:text-base";
  const big = boardMode ? "text-xl sm:text-2xl" : "text-base sm:text-lg";
  const btn =
    "px-2.5 py-1.5 text-xs sm:text-sm rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 min-h-[36px]";
  return (
    <div
      className="flex flex-wrap items-center gap-2 sm:gap-3 rounded-2xl border-2 border-amber-300 bg-amber-50 px-3 py-2 shadow-sm"
      style={{ borderLeftWidth: 10, borderLeftColor: shape.color }}
    >
      <div className={`font-bold text-amber-900 ${big}`}>📐 {kind.name}</div>
      {kind.formula && (
        <div className={`${txt} text-amber-900`}>
          <span className="text-amber-700">공식</span>{" "}
          <span className="font-bold bg-white px-2 py-0.5 rounded border border-amber-200">
            {kind.formula}
          </span>
        </div>
      )}
      <div className={`${txt}`}>
        <span className="text-slate-500">넓이</span>{" "}
        <b className="text-slate-900">{fmtArea(area)}</b>
      </div>
      <div className={`${txt}`}>
        <span className="text-slate-500">둘레</span>{" "}
        <b className="text-slate-900">{fmtLen(peri)}</b>
      </div>
      <div className="ml-auto flex flex-wrap gap-1.5">
        <button className={btn} onClick={() => onRotate(-90)} title="시계 반대 90°">↶90°</button>
        <button className={btn} onClick={() => onRotate(90)} title="시계 90°">↷90°</button>
        <button className={btn} onClick={() => onRotate(180)}>180°</button>
        <button className={btn} onClick={() => onFlip("horizontal")} title="좌우 뒤집기">↔</button>
        <button className={btn} onClick={() => onFlip("vertical")} title="위아래 뒤집기">↕</button>
        <button className={btn} onClick={() => onScale(0.5)}>×½</button>
        <button className={btn} onClick={() => onScale(2)}>×2</button>
      </div>
    </div>
  );
}

function ToolHint({ tool, mergeFirst }: { tool: Tool; mergeFirst: boolean }) {
  const tips: Record<Tool, string> = {
    draw: "✏️ 캔버스를 클릭해 꼭짓점을 찍어요. 첫 점 다시 클릭하거나 ‘도형 완성’으로 마감.",
    select: "🖱️ 도형을 눌러 선택. 안쪽 드래그=이동, 꼭짓점 드래그=변형, 초록 손잡이=회전.",
    cut: "✂️ 드래그해서 도형을 자르세요. 가로/세로/대각선 모두 가능.",
    merge: mergeFirst
      ? "🔗 두 번째 도형을 누르세요. 한 변이 정확히 맞붙어야 합쳐져요."
      : "🔗 합칠 첫 번째 도형을 누르세요.",
    measure: "📏 두 점 드래그로 길이 재기. 1cm 눈금 표시. ‘측정선 지우기’로 초기화.",
    guide: "📐 자르기 전 ‘여기서 자를까’ 점선 가이드를 미리 그어 보세요.",
    delete: "🗑️ 지우고 싶은 도형을 누르세요.",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs sm:text-sm text-slate-600">
      {tips[tool]}
    </div>
  );
}
