"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Point,
  Shape,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  pointInPolygon,
  rotatePoints,
  splitPolygonByLine,
  translatePoints,
  uid,
} from "@/lib/geometry";

type Tool = "draw" | "select" | "cut" | "delete";

const GRID = 40; // 1cm = 40px
const CANVAS_W = 960;
const CANVAS_H = 600;
const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];

type DragMode =
  | { type: "none" }
  | { type: "translate"; shapeId: string; last: Point }
  | { type: "vertex"; shapeId: string; vertexIndex: number }
  | { type: "rotate"; shapeId: string; center: Point; startAngle: number; startPoints: Point[] };

export default function PolygonCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("draw");
  const [snap, setSnap] = useState(true);
  const [draft, setDraft] = useState<Point[]>([]);
  const [cutDraft, setCutDraft] = useState<Point[]>([]);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const dragRef = useRef<DragMode>({ type: "none" });
  const colorIndexRef = useRef(0);

  // 화면 크기에 따른 CSS 스케일 (좌표는 항상 캔버스 픽셀 기준)
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

  // 마우스 → 캔버스 좌표
  const getPt = (e: React.PointerEvent): Point => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return maybeSnap({ x, y });
  };
  const maybeSnap = (p: Point): Point => {
    if (!snap) return p;
    return {
      x: Math.round(p.x / (GRID / 2)) * (GRID / 2),
      y: Math.round(p.y / (GRID / 2)) * (GRID / 2),
    };
  };

  // ---------- 그리기 ----------
  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = getPt(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    if (tool === "draw") {
      // 첫 점 근처 다시 클릭 → 도형 완성
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
        setShapes((all) => all.filter((s) => s.id !== target.id));
        if (selectedId === target.id) setSelectedId(null);
      }
      return;
    }

    if (tool === "cut") {
      if (cutDraft.length === 0) setCutDraft([p]);
      else {
        const a = cutDraft[0];
        const b = p;
        applyCut(a, b);
        setCutDraft([]);
      }
      return;
    }

    // select / 변형 / 회전
    if (tool === "select") {
      // 회전 핸들 우선
      if (selected) {
        const handle = rotationHandle(selected);
        if (Math.hypot(p.x - handle.x, p.y - handle.y) < 14) {
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
        // 꼭짓점 잡기
        const vi = selected.points.findIndex(
          (v) => Math.hypot(v.x - p.x, v.y - p.y) < 12
        );
        if (vi !== -1) {
          dragRef.current = { type: "vertex", shapeId: selected.id, vertexIndex: vi };
          return;
        }
      }
      const hit = topShapeAt(p);
      if (hit) {
        setSelectedId(hit.id);
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

  function handleCanvasPointerUp() {
    dragRef.current = { type: "none" };
  }

  function finishDraft() {
    if (draft.length < 3) return;
    const color = COLORS[colorIndexRef.current % COLORS.length];
    colorIndexRef.current += 1;
    const s: Shape = { id: uid(), points: draft, color };
    setShapes((all) => [...all, s]);
    setSelectedId(s.id);
    setDraft([]);
    setTool("select");
  }

  function applyCut(a: Point, b: Point) {
    setShapes((all) => {
      const out: Shape[] = [];
      for (const s of all) {
        const parts = splitPolygonByLine(s.points, a, b);
        if (parts) {
          parts.forEach((pts, i) => {
            out.push({ id: uid(), points: pts, color: i === 0 ? s.color : nextColor() });
          });
        } else {
          out.push(s);
        }
      }
      return out;
    });
    setSelectedId(null);
  }
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
    // 가장 위쪽 점 위에 핸들 배치
    const minY = Math.min(...s.points.map((q) => q.y));
    return { x: c.x, y: minY - 40 };
  }

  // ESC 키로 그리기/자르기 취소
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDraft([]);
        setCutDraft([]);
        dragRef.current = { type: "none" };
      } else if (e.key === "Enter" && tool === "draw" && draft.length >= 3) {
        finishDraft();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        setShapes((all) => all.filter((s) => s.id !== selectedId));
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, draft.length, selectedId]);

  // ---------- 렌더링 ----------
  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 격자
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
    // 굵은 5cm 선
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
    // cm 라벨
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    for (let x = GRID; x < CANVAS_W; x += GRID * 5) {
      ctx.fillText(`${x / GRID}`, x + 2, 12);
    }
    for (let y = GRID; y < CANVAS_H; y += GRID * 5) {
      ctx.fillText(`${y / GRID}`, 2, y + 12);
    }

    // 도형
    for (const s of shapes) {
      drawShape(ctx, s, s.id === selectedId);
    }

    // 그리기 중인 도형
    if (draft.length > 0) {
      ctx.strokeStyle = "#0ea5e9";
      ctx.fillStyle = "rgba(14,165,233,0.1)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(draft[0].x, draft[0].y);
      for (let i = 1; i < draft.length; i++) ctx.lineTo(draft[i].x, draft[i].y);
      if (hoverPt && tool === "draw") ctx.lineTo(hoverPt.x, hoverPt.y);
      ctx.stroke();
      // 꼭짓점
      for (const v of draft) {
        ctx.fillStyle = "#0ea5e9";
        ctx.beginPath();
        ctx.arc(v.x, v.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // 첫 점 강조 (닫기 가능)
      if (draft.length >= 3) {
        ctx.strokeStyle = "#0ea5e9";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(draft[0].x, draft[0].y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 자르기 미리보기 (무한 직선)
    if (tool === "cut" && cutDraft.length === 1 && hoverPt) {
      const a = cutDraft[0];
      const b = hoverPt;
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
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [shapes, draft, cutDraft, hoverPt, selectedId, tool]);

  function drawShape(
    ctx: CanvasRenderingContext2D,
    s: Shape,
    isSelected: boolean
  ) {
    if (s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.fillStyle = s.color + "55"; // 알파
    ctx.fill();
    ctx.strokeStyle = isSelected ? "#0f172a" : s.color;
    ctx.lineWidth = isSelected ? 2.5 : 2;
    ctx.stroke();

    // 변의 길이 표시
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

    // 꼭짓점 표시 (선택된 경우 크게)
    for (const v of s.points) {
      ctx.fillStyle = isSelected ? "#0f172a" : s.color;
      ctx.beginPath();
      ctx.arc(v.x, v.y, isSelected ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 면적/둘레 라벨
    const c = polygonCentroid(s.points);
    const area = polygonArea(s.points) / (GRID * GRID);
    const peri = polygonPerimeter(s.points) / GRID;
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 12px sans-serif";
    const label = `넓이 ${area.toFixed(2)}cm²`;
    const label2 = `둘레 ${peri.toFixed(2)}cm`;
    const tw = Math.max(ctx.measureText(label).width, ctx.measureText(label2).width);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(c.x - tw / 2 - 6, c.y - 18, tw + 12, 32);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.fillText(label, c.x, c.y - 4);
    ctx.fillText(label2, c.x, c.y + 11);
    ctx.textAlign = "start";

    // 회전 핸들
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

  // 합계 (선택 도형들)
  const totalArea = useMemo(
    () => shapes.reduce((a, s) => a + polygonArea(s.points) / (GRID * GRID), 0),
    [shapes]
  );
  const totalPeri = useMemo(
    () => shapes.reduce((a, s) => a + polygonPerimeter(s.points) / GRID, 0),
    [shapes]
  );

  return (
    <div className="flex flex-col gap-3">
      <Toolbar
        tool={tool}
        setTool={(t) => {
          setTool(t);
          setDraft([]);
          setCutDraft([]);
        }}
        snap={snap}
        setSnap={setSnap}
        onFinishDraw={finishDraft}
        canFinish={draft.length >= 3}
        onClear={() => {
          setShapes([]);
          setSelectedId(null);
          setDraft([]);
          setCutDraft([]);
        }}
        onDuplicate={() => {
          if (!selected) return;
          const copy: Shape = {
            id: uid(),
            color: nextColor(),
            points: translatePoints(selected.points, GRID, GRID),
          };
          setShapes((all) => [...all, copy]);
          setSelectedId(copy.id);
        }}
        hasSelection={!!selected}
      />

      <div
        ref={wrapRef}
        className="w-full overflow-hidden rounded-2xl border border-slate-200 shadow-sm bg-white"
        style={{ touchAction: "none" }}
      >
        <div
          style={{
            width: CANVAS_W * cssScale,
            height: CANVAS_H * cssScale,
          }}
        >
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
      <div className="ml-2 h-6 w-px bg-slate-200" />
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
    cut:
      "도형을 가로지르는 직선을 그어 잘라요. 두 점을 클릭하면 그 직선을 따라 도형이 두 조각으로 나뉘어요.",
    delete: "지우고 싶은 도형을 클릭하세요.",
  };
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:col-span-2">
        <div className="text-sm font-semibold text-slate-500">사용 방법</div>
        <p className="mt-1 text-sm text-slate-700 leading-relaxed">{tips[props.tool]}</p>
        <p className="mt-2 text-xs text-slate-500">
          🔸 격자 한 칸 = 1cm · 굵은 선 = 5cm · 선택한 도형은 Delete/Backspace 키로도 지울 수
          있어요.
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
