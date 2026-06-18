"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Point,
  Shape,
  cloneShapes,
  flipPoints,
  makeParallelogram,
  makeRectangle,
  makeRightTriangle,
  makeTrapezoid,
  makeTriangle,
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

type Tool = "draw" | "select" | "cut" | "delete";

const GRID = 40; // 1cm = 40px
const CANVAS_W = 960;
const CANVAS_H = 600;
const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
const HISTORY_LIMIT = 50;

type DragMode =
  | { type: "none" }
  | { type: "translate"; shapeId: string; last: Point }
  | { type: "vertex"; shapeId: string; vertexIndex: number }
  | { type: "rotate"; shapeId: string; center: Point; startAngle: number; startPoints: Point[] }
  | { type: "cut"; start: Point; current: Point };

export default function PolygonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [past, setPast] = useState<Shape[][]>([]);
  const [future, setFuture] = useState<Shape[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("draw");
  const [snap, setSnap] = useState(true);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const [scenarioHint, setScenarioHint] = useState<string | null>(null);
  const dragRef = useRef<DragMode>({ type: "none" });
  const colorIndexRef = useRef(0);

  const [cssScale, setCssScale] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setCssScale(Math.min(1, w / CANVAS_W));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selected = useMemo(
    () => shapes.find((s) => s.id === selectedId) ?? null,
    [shapes, selectedId]
  );

  // ----- 히스토리 -----
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

  // ----- 좌표 변환 -----
  const getPt = (e: React.PointerEvent): Point => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return maybeSnap({ x, y });
  };
  const maybeSnap = (p: Point): Point => {
    if (!snap) return p;
    const step = GRID / 2;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
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

  // ----- 마우스 이벤트 -----
  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = getPt(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    if (tool === "draw") {
      if (draft.length >= 3) {
        const first = draft[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) < 12) {
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
      // 드래그로 자르기 직선을 긋는다
      dragRef.current = { type: "cut", start: p, current: p };
      return;
    }

    if (tool === "select") {
      if (selected) {
        const handle = rotationHandle(selected);
        if (Math.hypot(p.x - handle.x, p.y - handle.y) < 14) {
          commitHistory();
          const center = polygonCentroid(selected.points);
          dragRef.current = {
            type: "rotate",
            shapeId: selected.id,
            center,
            startAngle: Math.atan2(p.y - center.y, p.x - center.x),
            startPoints: selected.points.map((q) => ({ ...q })),
          };
          return;
        }
        const vi = selected.points.findIndex(
          (v) => Math.hypot(v.x - p.x, v.y - p.y) < 12
        );
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
        dragRef.current = { type: "translate", shapeId: hit.id, last: p };
      } else {
        setSelectedId(null);
      }
    }
  }

  function handleCanvasPointerMove(e: React.PointerEvent) {
    const p = getPt(e);
    setHoverPt(p);
    const dm = dragRef.current;
    if (dm.type === "none") return;

    if (dm.type === "cut") {
      dragRef.current = { ...dm, current: p };
      return;
    }

    setShapes((all) =>
      all.map((s) => {
        if (s.id !== dm.shapeId) return s;
        if (dm.type === "translate") {
          const dx = p.x - dm.last.x;
          const dy = p.y - dm.last.y;
          dragRef.current = { ...dm, last: p };
          return { ...s, points: translatePoints(s.points, dx, dy) };
        }
        if (dm.type === "vertex") {
          const next = s.points.map((q, i) => (i === dm.vertexIndex ? p : q));
          return { ...s, points: next };
        }
        if (dm.type === "rotate") {
          const ang = Math.atan2(p.y - dm.center.y, p.x - dm.center.x) - dm.startAngle;
          return { ...s, points: rotatePoints(dm.startPoints, dm.center, ang) };
        }
        return s;
      })
    );
  }

  function handleCanvasPointerUp(e: React.PointerEvent) {
    const dm = dragRef.current;
    if (dm.type === "cut") {
      const p = getPt(e);
      const a = dm.start;
      const b = p;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4) {
        applyCut(a, b);
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

  // ----- 키보드 -----
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

  // ----- 변환 액션 -----
  function transformSelected(fn: (pts: Point[], center: Point) => Point[]) {
    if (!selected) return;
    commitHistory();
    setShapes((all) =>
      all.map((s) =>
        s.id === selected.id
          ? { ...s, points: fn(s.points, polygonCentroid(s.points)) }
          : s
      )
    );
  }

  function addPresetShape(points: Point[]) {
    commitHistory();
    const s: Shape = { id: uid(), color: nextColor(), points };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setTool("select");
  }

  function loadScenario(scenario: Scenario) {
    commitHistory();
    setShapes(scenario.build());
    setSelectedId(null);
    setDraft([]);
    setTool("select");
    setScenarioHint(scenario.hint);
  }

  function clearAll() {
    commitHistory();
    setShapes([]);
    setSelectedId(null);
    setDraft([]);
    setScenarioHint(null);
  }

  // ----- 렌더링 -----
  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
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
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1.5;
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
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    for (let x = GRID; x < CANVAS_W; x += GRID * 5) ctx.fillText(`${x / GRID}`, x + 2, 12);
    for (let y = GRID; y < CANVAS_H; y += GRID * 5) ctx.fillText(`${y / GRID}`, 2, y + 12);

    for (const s of shapes) drawShape(ctx, s, s.id === selectedId);

    // 그리기 중인 다각형
    if (draft.length > 0) {
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(draft[0].x, draft[0].y);
      for (let i = 1; i < draft.length; i++) ctx.lineTo(draft[i].x, draft[i].y);
      if (hoverPt && tool === "draw") ctx.lineTo(hoverPt.x, hoverPt.y);
      ctx.stroke();
      for (const v of draft) {
        ctx.fillStyle = "#0ea5e9";
        ctx.beginPath();
        ctx.arc(v.x, v.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (draft.length >= 3) {
        ctx.strokeStyle = "#0ea5e9";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(draft[0].x, draft[0].y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 자르기 미리보기 — 드래그 중인 직선 (양쪽으로 확장된 무한직선)
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
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x - ex, a.y - ey);
      ctx.lineTo(a.x + ex, a.y + ey);
      ctx.stroke();
      ctx.restore();
      // 실제 드래그 구간
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = "#dc2626";
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [shapes, draft, hoverPt, selectedId, tool]);

  function drawShape(ctx: CanvasRenderingContext2D, s: Shape, isSelected: boolean) {
    if (s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.fillStyle = s.color + "55";
    ctx.fill();
    ctx.strokeStyle = isSelected ? "#0f172a" : s.color;
    ctx.lineWidth = isSelected ? 2.5 : 2;
    ctx.stroke();

    ctx.fillStyle = "#334155";
    ctx.font = "12px sans-serif";
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) / GRID;
      ctx.fillText(`${len.toFixed(1)}cm`, mx + 4, my - 4);
    }

    for (const v of s.points) {
      ctx.fillStyle = isSelected ? "#0f172a" : s.color;
      ctx.beginPath();
      ctx.arc(v.x, v.y, isSelected ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const c = polygonCentroid(s.points);
    const area = polygonArea(s.points) / (GRID * GRID);
    const peri = polygonPerimeter(s.points) / GRID;
    const label = `넓이 ${area.toFixed(2)}cm²`;
    const label2 = `둘레 ${peri.toFixed(2)}cm`;
    ctx.font = "bold 12px sans-serif";
    const tw = Math.max(ctx.measureText(label).width, ctx.measureText(label2).width);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(c.x - tw / 2 - 6, c.y - 18, tw + 12, 32);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.fillText(label, c.x, c.y - 4);
    ctx.fillText(label2, c.x, c.y + 11);
    ctx.textAlign = "start";

    if (isSelected) {
      const h = rotationHandle(s);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(h.x, h.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#065f46";
      ctx.stroke();
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

  // ----- 캔버스 중심 좌표 -----
  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;

  return (
    <div className="flex flex-col gap-3">
      <Toolbar
        tool={tool}
        setTool={(t) => {
          setTool(t);
          setDraft([]);
          dragRef.current = { type: "none" };
        }}
        snap={snap}
        setSnap={setSnap}
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
          };
          setShapes((all) => [...all, copy]);
          setSelectedId(copy.id);
        }}
        hasSelection={!!selected}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onUndo={undo}
        onRedo={redo}
      />

      <PresetRow
        onAdd={addPresetShape}
        cx={cx}
        cy={cy}
      />

      <ScenarioRow onLoad={loadScenario} cx={cx} cy={cy} />

      {scenarioHint && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          💡 {scenarioHint}
          <button
            className="ml-3 text-xs text-amber-700 underline"
            onClick={() => setScenarioHint(null)}
          >
            닫기
          </button>
        </div>
      )}

      <div
        ref={wrapRef}
        className="w-full overflow-hidden rounded-2xl border border-slate-200 shadow-sm bg-white"
        style={{ touchAction: "none" }}
      >
        <div style={{ width: CANVAS_W * cssScale, height: CANVAS_H * cssScale }}>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{
              width: CANVAS_W * cssScale,
              height: CANVAS_H * cssScale,
              cursor:
                tool === "draw"
                  ? "crosshair"
                  : tool === "cut"
                  ? "crosshair"
                  : tool === "delete"
                  ? "not-allowed"
                  : "default",
              display: "block",
            }}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerUp}
          />
        </div>
      </div>

      {selected && (
        <TransformBar
          onRotate={(deg) =>
            transformSelected((pts, c) => rotatePoints(pts, c, (deg * Math.PI) / 180))
          }
          onFlip={(axis) => transformSelected((pts, c) => flipPoints(pts, c, axis))}
          onScale={(f) => transformSelected((pts, c) => scalePoints(pts, c, f, f))}
        />
      )}

      <InfoPanel
        selected={selected}
        totalArea={totalArea}
        totalPeri={totalPeri}
        shapeCount={shapes.length}
        tool={tool}
      />
    </div>
  );
}

// =================== UI 컴포넌트 ===================

function Toolbar(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  snap: boolean;
  setSnap: (b: boolean) => void;
  onFinishDraw: () => void;
  canFinish: boolean;
  onClear: () => void;
  onDuplicate: () => void;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const btn = (active: boolean) =>
    `px-3 py-2 rounded-lg text-sm font-medium border transition ${
      active
        ? "bg-slate-900 text-white border-slate-900"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
    }`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex gap-1.5">
        <button className={btn(props.tool === "draw")} onClick={() => props.setTool("draw")}>
          ✏️ 그리기
        </button>
        <button className={btn(props.tool === "select")} onClick={() => props.setTool("select")}>
          🖱️ 선택/이동
        </button>
        <button className={btn(props.tool === "cut")} onClick={() => props.setTool("cut")}>
          ✂️ 자르기
        </button>
        <button className={btn(props.tool === "delete")} onClick={() => props.setTool("delete")}>
          🗑️ 삭제
        </button>
      </div>
      <div className="ml-1 h-6 w-px bg-slate-200" />
      <button
        className="px-3 py-2 text-sm font-medium rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
        disabled={!props.canFinish}
        onClick={props.onFinishDraw}
      >
        ✅ 도형 완성
      </button>
      <button
        className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        disabled={!props.hasSelection}
        onClick={props.onDuplicate}
      >
        📋 복사
      </button>
      <div className="ml-1 h-6 w-px bg-slate-200" />
      <button
        className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        disabled={!props.canUndo}
        onClick={props.onUndo}
        title="Ctrl/Cmd+Z"
      >
        ↶ 되돌리기
      </button>
      <button
        className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        disabled={!props.canRedo}
        onClick={props.onRedo}
        title="Ctrl/Cmd+Shift+Z"
      >
        ↷ 다시하기
      </button>
      <label className="flex items-center gap-2 text-sm text-slate-600 px-2">
        <input
          type="checkbox"
          checked={props.snap}
          onChange={(e) => props.setSnap(e.target.checked)}
        />
        격자에 맞추기
      </label>
      <div className="ml-auto">
        <button
          className="px-3 py-2 text-sm font-medium rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
          onClick={props.onClear}
        >
          전체 초기화
        </button>
      </div>
    </div>
  );
}

function PresetRow(props: { onAdd: (pts: Point[]) => void; cx: number; cy: number }) {
  const { cx, cy, onAdd } = props;
  const items: { label: string; build: () => Point[] }[] = [
    { label: "정사각형 4×4", build: () => makeRectangle(cx, cy, 4 * GRID, 4 * GRID) },
    { label: "직사각형 6×3", build: () => makeRectangle(cx, cy, 6 * GRID, 3 * GRID) },
    { label: "직각삼각형 6×4", build: () => makeRightTriangle(cx, cy, 6 * GRID, 4 * GRID) },
    { label: "삼각형", build: () => makeTriangle(cx, cy, 6 * GRID, 4 * GRID) },
    {
      label: "평행사변형",
      build: () => makeParallelogram(cx, cy, 6 * GRID, 4 * GRID, 2 * GRID),
    },
    {
      label: "사다리꼴",
      build: () => makeTrapezoid(cx, cy, 3 * GRID, 6 * GRID, 4 * GRID),
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <span className="text-sm font-semibold text-slate-500 pr-2">도형 추가</span>
      {items.map((it) => (
        <button
          key={it.label}
          className="px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          onClick={() => onAdd(it.build())}
        >
          ➕ {it.label}
        </button>
      ))}
    </div>
  );
}

type Scenario = { label: string; hint: string; build: () => Shape[] };

function ScenarioRow(props: { onLoad: (s: Scenario) => void; cx: number; cy: number }) {
  const { cx, cy, onLoad } = props;
  const scenarios: Scenario[] = [
    {
      label: "사다리꼴 두 개 → 평행사변형",
      hint:
        "똑같은 사다리꼴 두 개를 준비했어요. 한 개를 180° 돌려서 다른 사다리꼴 옆에 붙여 보세요. 평행사변형이 되면 ‘(윗변+아랫변)×높이’가 평행사변형의 넓이가 돼요. 사다리꼴 한 개의 넓이는 그 절반!",
      build: () => {
        const A = makeTrapezoid(cx - 3.5 * GRID, cy, 3 * GRID, 6 * GRID, 4 * GRID);
        const B = makeTrapezoid(cx + 3.5 * GRID, cy, 3 * GRID, 6 * GRID, 4 * GRID);
        return [
          { id: uid(), color: COLORS[0], points: A },
          { id: uid(), color: COLORS[1], points: B },
        ];
      },
    },
    {
      label: "평행사변형 → 직사각형",
      hint:
        "평행사변형의 왼쪽(또는 오른쪽) 끝에서 직각삼각형 한 조각을 잘라(✂️ 자르기) 반대편으로 옮겨 붙여 보세요. 직사각형이 되죠? 그래서 평행사변형의 넓이는 ‘밑변×높이’예요.",
      build: () => {
        const P = makeParallelogram(cx, cy, 6 * GRID, 4 * GRID, 2 * GRID);
        return [{ id: uid(), color: COLORS[0], points: P }];
      },
    },
    {
      label: "직각삼각형 두 개 → 직사각형",
      hint:
        "똑같은 직각삼각형 두 개를 합쳐 보세요. 한 개를 180° 돌려서 빗변끼리 맞붙이면 직사각형이 돼요. 그래서 삼각형의 넓이는 ‘밑변×높이÷2’!",
      build: () => {
        const A = makeRightTriangle(cx - 3 * GRID, cy, 6 * GRID, 4 * GRID);
        const B = makeRightTriangle(cx + 3 * GRID, cy, 6 * GRID, 4 * GRID);
        return [
          { id: uid(), color: COLORS[0], points: A },
          { id: uid(), color: COLORS[1], points: B },
        ];
      },
    },
    {
      label: "삼각형 두 개 → 평행사변형",
      hint:
        "임의의 삼각형 두 개로도 평행사변형을 만들 수 있어요. 한 개를 180° 회전해서 한 변에 딱 맞춰 보세요.",
      build: () => {
        const A = makeTriangle(cx - 3 * GRID, cy, 6 * GRID, 4 * GRID);
        const B = makeTriangle(cx + 3 * GRID, cy, 6 * GRID, 4 * GRID);
        return [
          { id: uid(), color: COLORS[0], points: A },
          { id: uid(), color: COLORS[1], points: B },
        ];
      },
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3 shadow-sm">
      <span className="text-sm font-semibold text-indigo-700 pr-2">📚 학습 예시</span>
      {scenarios.map((sc) => (
        <button
          key={sc.label}
          className="px-3 py-2 text-sm rounded-lg border border-indigo-200 bg-white text-indigo-800 hover:bg-indigo-100"
          onClick={() => onLoad(sc)}
        >
          {sc.label}
        </button>
      ))}
    </div>
  );
}

function TransformBar(props: {
  onRotate: (deg: number) => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
  onScale: (factor: number) => void;
}) {
  const btn =
    "px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 shadow-sm">
      <span className="text-sm font-semibold text-emerald-800 pr-2">선택한 도형 변환</span>
      <div className="flex gap-1.5">
        <button className={btn} onClick={() => props.onRotate(-90)}>
          ↶ 90°
        </button>
        <button className={btn} onClick={() => props.onRotate(90)}>
          ↷ 90°
        </button>
        <button className={btn} onClick={() => props.onRotate(180)}>
          180°
        </button>
      </div>
      <div className="h-6 w-px bg-emerald-200" />
      <div className="flex gap-1.5">
        <button className={btn} onClick={() => props.onFlip("horizontal")}>
          ↔ 좌우 뒤집기
        </button>
        <button className={btn} onClick={() => props.onFlip("vertical")}>
          ↕ 위아래 뒤집기
        </button>
      </div>
      <div className="h-6 w-px bg-emerald-200" />
      <div className="flex gap-1.5">
        <button className={btn} onClick={() => props.onScale(0.5)}>
          🔻 ×0.5
        </button>
        <button className={btn} onClick={() => props.onScale(0.8)}>
          🔽 ×0.8
        </button>
        <button className={btn} onClick={() => props.onScale(1.25)}>
          🔼 ×1.25
        </button>
        <button className={btn} onClick={() => props.onScale(2)}>
          🔺 ×2
        </button>
      </div>
    </div>
  );
}

function InfoPanel(props: {
  selected: Shape | null;
  totalArea: number;
  totalPeri: number;
  shapeCount: number;
  tool: Tool;
}) {
  const tips: Record<Tool, string> = {
    draw:
      "캔버스를 클릭해서 꼭짓점을 차례대로 찍어 보세요. 첫 점을 다시 클릭하거나 ‘도형 완성’ 버튼을 누르면 다각형이 만들어져요. (ESC: 취소)",
    select:
      "도형을 클릭해서 선택해요. 도형 안쪽을 끌면 옮기고, 꼭짓점을 끌면 모양을 바꿔요. 위쪽 초록 점은 회전 손잡이예요.",
    cut: "도형 위에서 ‘드래그(누른 채로 끌기)’해서 잘라요. 가로·세로·비스듬한 직선 모두 가능해요.",
    delete: "지우고 싶은 도형을 클릭하세요.",
  };
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:col-span-2">
        <div className="text-sm font-semibold text-slate-500">사용 방법</div>
        <p className="mt-1 text-sm text-slate-700 leading-relaxed">{tips[props.tool]}</p>
        <p className="mt-2 text-xs text-slate-500">
          🔸 격자 한 칸 = 1cm · 굵은 선 = 5cm · Ctrl/Cmd+Z: 되돌리기 · Delete: 선택 도형 지우기
        </p>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold text-slate-500">전체 합계</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Stat label="도형 수" value={`${props.shapeCount}개`} />
          <Stat label="둘레 합" value={`${props.totalPeri.toFixed(2)}cm`} />
          <Stat label="넓이 합" value={`${props.totalArea.toFixed(2)}cm²`} />
          {props.selected && (
            <Stat
              label="선택 넓이"
              value={`${(polygonArea(props.selected.points) / (GRID * GRID)).toFixed(2)}cm²`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}
