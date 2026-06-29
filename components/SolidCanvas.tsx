"use client";

import { useEffect, useRef, useState } from "react";
import {
  V3,
  SolidSpec,
  rotate,
  cross,
  sub,
  norm,
  dot,
  cuboidFaces,
  cuboidNetFaces,
  prismNetFaces,
  pyramidNetFaces,
  buildSolid,
  sectionAtY,
  areaXZ,
  v,
  add,
} from "@/lib/solid3d";
import CubeNetQuiz from "@/components/CubeNetQuiz";
import SolidQuiz from "@/components/SolidQuiz";

type Mode = "view" | "stack" | "net" | "section";

const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185"];

const SOLIDS = [
  { id: "box", label: "직육면체", kind: "box" as const, n: 4 },
  { id: "prism3", label: "삼각기둥", kind: "prism" as const, n: 3 },
  { id: "prism5", label: "오각기둥", kind: "prism" as const, n: 5 },
  { id: "prism6", label: "육각기둥", kind: "prism" as const, n: 6 },
  { id: "pyr3", label: "삼각뿔", kind: "pyramid" as const, n: 3 },
  { id: "pyr4", label: "사각뿔", kind: "pyramid" as const, n: 4 },
  { id: "pyr5", label: "오각뿔", kind: "pyramid" as const, n: 5 },
];

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function shade(hex: string, f: number) {
  const { r, g, b } = hexToRgb(hex);
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

export default function SolidCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const [mode, setMode] = useState<Mode>("view");
  const [solidId, setSolidId] = useState("box");
  const [a, setA] = useState(4);
  const [b, setB] = useState(3);
  const [c, setC] = useState(2);
  const [cube, setCube] = useState(false);
  const [yaw, setYaw] = useState(-0.6);
  const [pitch, setPitch] = useState(0.5);
  const [auto, setAuto] = useState(true);
  const [foldT, setFoldT] = useState(0);
  const [showFaces, setShowFaces] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [showVerts, setShowVerts] = useState(true);
  const [showNames, setShowNames] = useState(true);
  // 쌓기나무 높이맵 (a×b 칸, 각 칸의 쌓은 높이 0..6)
  const [heights, setHeights] = useState<number[][]>(() => Array.from({ length: 4 }, () => Array(3).fill(1)));
  const [netQuiz, setNetQuiz] = useState(false);
  const [cutY, setCutY] = useState(0); // 단면 자르기 높이(-1..1 비율)
  const [solidQuiz, setSolidQuiz] = useState(false);

  const color = COLORS[0];
  const solid = SOLIDS.find((s) => s.id === solidId)!;
  const isBox = solid.kind === "box";

  // 현재 입체 사양 (각기둥·각뿔은 a=밑면 크기, c=높이)
  const spec: SolidSpec = isBox
    ? { kind: "box", n: 4, a, b, c, R: 0, h: 0 }
    : { kind: solid.kind, n: solid.n, a: 0, b: 0, c: 0, R: a, h: c };
  const data = buildSolid(spec, color);
  const yHalf = Math.max(0.5, ...data.corners.map((p) => Math.abs(p.y)));
  const cutWorldY = cutY * (yHalf - 0.02);
  const sectionPoly = mode === "section" ? sectionAtY(data.faces, cutWorldY) : [];
  const sectionArea = sectionPoly.length >= 3 ? Math.round(areaXZ(sectionPoly) * 10) / 10 : 0;

  function setDim(which: "a" | "b" | "c", val: number) {
    if (cube && isBox) {
      setA(val);
      setB(val);
      setC(val);
      return;
    }
    if (which === "a") setA(val);
    else if (which === "b") setB(val);
    else setC(val);
  }
  function toggleCube() {
    setCube((on) => {
      if (!on) {
        const m = Math.round((a + b + c) / 3);
        setA(m);
        setB(m);
        setC(m);
      }
      return !on;
    });
  }

  // 가로(a)·세로(b)가 바뀌면 높이맵 크기 맞춤(기존 값 유지)
  useEffect(() => {
    setHeights((prev) => Array.from({ length: a }, (_, i) => Array.from({ length: b }, (_, j) => prev[i]?.[j] ?? 1)));
  }, [a, b]);

  const stackVolume = heights.reduce((s, col) => s + col.reduce((t, h) => t + h, 0), 0);
  const stackMaxH = Math.max(1, ...heights.flat());
  const frontMax = Array.from({ length: a }, (_, i) => Math.max(0, ...(heights[i] ?? []).map((h) => h)));
  const sideMax = Array.from({ length: b }, (_, j) => Math.max(0, ...heights.map((col) => col[j] ?? 0)));
  function bumpCell(i: number, j: number, dir: 1 | -1) {
    setHeights((prev) => prev.map((col, ci) => (ci === i ? col.map((h, cj) => (cj === j ? Math.max(0, Math.min(6, h + dir)) : h)) : col)));
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!auto) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setYaw((y) => y + dt * 0.5);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [auto]);

  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  function onDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch };
    setAuto(false);
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setYaw(d.yaw + (e.clientX - d.x) * 0.01);
    setPitch(Math.max(-1.4, Math.min(1.4, d.pitch + (e.clientY - d.y) * 0.01)));
  }
  function onUp() {
    dragRef.current = null;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const cx = size.w / 2;
    const cy = size.h / 2;
    const stackBox = mode === "stack" && isBox;
    const stackMaxH = Math.max(1, ...heights.flat());
    const maxDim = Math.max(a, b, stackBox ? stackMaxH : c, isBox ? 3 : a + 2, 3);
    const baseScale = Math.min(size.w, size.h) / (maxDim * 2.9);
    const L = norm(v(-0.4, 0.7, 0.6));

    const project = (p: V3) => {
      const r = rotate(p, yaw, pitch);
      const f = 9;
      const persp = f / (f - r.z / maxDim);
      return { x: cx + r.x * baseScale * persp, y: cy - r.y * baseScale * persp, depth: r.z };
    };
    const faceNormalRot = (pts: V3[]) => {
      if (pts.length < 3) return v(0, 0, 1);
      return rotate(norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))), yaw, pitch);
    };

    type Draw = { pts: V3[]; color: string; label?: string; twoSided: boolean };
    let faces: Draw[] = [];
    const isNet = mode === "net";
    const isSection = mode === "section";
    if (mode === "view" || (mode === "stack" && !isBox) || isSection) {
      faces = data.faces.map((f) => ({ ...f, twoSided: isSection }));
    } else if (isNet) {
      if (isBox) faces = cuboidNetFaces(a, b, c, foldT, color).map((f) => ({ ...f, twoSided: true }));
      else if (solid.kind === "prism") faces = prismNetFaces(solid.n, a, c, color).map((f) => ({ ...f, twoSided: true }));
      else faces = pyramidNetFaces(solid.n, a, c, color).map((f) => ({ ...f, twoSided: true }));
    } else if (stackBox) {
      const hx = a / 2;
      const hy = b / 2;
      const maxH = Math.max(1, ...heights.flat());
      const hz = maxH / 2;
      for (let i = 0; i < a; i++)
        for (let j = 0; j < b; j++) {
          const col = heights[i]?.[j] ?? 0;
          for (let kk = 0; kk < col; kk++) {
            const o = v(i - hx, j - hy, kk - hz);
            cuboidFaces(1, 1, 1, color).forEach((f) =>
              faces.push({ pts: f.pts.map((p) => add(p, add(o, v(0.5, 0.5, 0.5)))), color, twoSided: false })
            );
          }
        }
    }

    const drawList = faces
      .map((f) => {
        const nr = faceNormalRot(f.pts);
        const proj = f.pts.map(project);
        const depth = proj.reduce((s, p) => s + p.depth, 0) / proj.length;
        const facing = nr.z > 0;
        const bright = 0.55 + 0.5 * Math.abs(dot(nr, L));
        return { f, proj, depth, facing, bright };
      })
      .filter((d) => d.f.twoSided || d.facing)
      .sort((x, y) => x.depth - y.depth);

    if (showFaces || mode !== "view") {
      for (const d of drawList) {
        ctx.beginPath();
        ctx.moveTo(d.proj[0].x, d.proj[0].y);
        for (let i = 1; i < d.proj.length; i++) ctx.lineTo(d.proj[i].x, d.proj[i].y);
        ctx.closePath();
        ctx.fillStyle = shade(d.f.color, Math.min(1.15, d.bright));
        ctx.globalAlpha = isSection ? 0.22 : isNet ? 0.92 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = isSection ? "rgba(15,23,42,0.25)" : "rgba(15,23,42,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (showNames && !isSection && d.f.label && (d.facing || isNet)) {
          const ccx = d.proj.reduce((s, p) => s + p.x, 0) / d.proj.length;
          const ccy = d.proj.reduce((s, p) => s + p.y, 0) / d.proj.length;
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tw = ctx.measureText(d.f.label).width;
          ctx.fillStyle = "rgba(15,23,42,0.6)";
          ctx.fillRect(ccx - tw / 2 - 5, ccy - 9, tw + 10, 18);
          ctx.fillStyle = "#fff";
          ctx.fillText(d.f.label, ccx, ccy);
          ctx.textAlign = "start";
          ctx.textBaseline = "alphabetic";
        }
      }
    }

    if (mode === "view") {
      if (showEdges) {
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 2.5;
        for (const [p1, p2] of data.edges) {
          const s1 = project(p1);
          const s2 = project(p2);
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();
        }
      }
      if (showVerts) {
        for (const corner of data.corners) {
          const s = project(corner);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#f59e0b";
          ctx.fill();
          ctx.strokeStyle = "#92400e";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    if (isSection) {
      // 자르는 평면(반투명 사각형) + 단면 다각형(굵은 외곽 + 채움)
      const xs = data.corners.map((p) => p.x);
      const zs = data.corners.map((p) => p.z);
      const minX = Math.min(...xs) - 0.2;
      const maxX = Math.max(...xs) + 0.2;
      const minZ = Math.min(...zs) - 0.2;
      const maxZ = Math.max(...zs) + 0.2;
      const plane = [v(minX, cutWorldY, minZ), v(maxX, cutWorldY, minZ), v(maxX, cutWorldY, maxZ), v(minX, cutWorldY, maxZ)].map(project);
      ctx.beginPath();
      ctx.moveTo(plane[0].x, plane[0].y);
      for (let i = 1; i < plane.length; i++) ctx.lineTo(plane[i].x, plane[i].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(148,163,184,0.18)";
      ctx.fill();
      ctx.strokeStyle = "rgba(100,116,139,0.5)";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      if (sectionPoly.length >= 3) {
        const sp = sectionPoly.map(project);
        ctx.beginPath();
        ctx.moveTo(sp[0].x, sp[0].y);
        for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
        ctx.closePath();
        ctx.fillStyle = "rgba(244,63,94,0.5)";
        ctx.fill();
        ctx.strokeStyle = "#e11d48";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }, [size, mode, solidId, a, b, c, yaw, pitch, foldT, showFaces, showEdges, showVerts, showNames, color, isBox, solid.kind, solid.n, data, heights, cutY, cutWorldY, sectionPoly]);

  const seg = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-bold transition ${active ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"}`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100">
      <div ref={wrapRef} className="absolute inset-0" style={{ touchAction: "none", cursor: dragRef.current ? "grabbing" : "grab" }}>
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} className="h-full w-full" />
      </div>

      {/* 상단 바 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-lg backdrop-blur">
          <a href="/" className="whitespace-nowrap text-sm font-bold text-slate-400 hover:text-slate-700" title="2D 다각형 체험실로">← 평면</a>
          <span className="mx-1 h-5 w-px bg-slate-200" />
          <span className="whitespace-nowrap text-base font-extrabold text-slate-800">🧊 입체도형 체험실</span>
        </div>
        <div className="pointer-events-auto flex gap-1.5 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-lg backdrop-blur">
          <button onClick={() => setMode("view")} className={seg(mode === "view")}>📦 입체보기</button>
          <button onClick={() => setMode("stack")} className={seg(mode === "stack")}>🧊 쌓기나무</button>
          <button onClick={() => setMode("net")} className={seg(mode === "net")}>📄 전개도</button>
          <button onClick={() => setMode("section")} className={seg(mode === "section")}>✂️ 단면</button>
          <button onClick={() => setSolidQuiz(true)} className="rounded-lg bg-rose-500 px-3 py-1.5 text-sm font-bold text-white hover:bg-rose-600">❓ 퀴즈</button>
        </div>
      </div>

      {/* 입체 종류 선택 (상단 중앙) */}
      <div className="pointer-events-auto absolute left-1/2 top-16 z-10 flex max-w-[94vw] -translate-x-1/2 flex-wrap justify-center gap-1 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-lg backdrop-blur">
        {SOLIDS.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setSolidId(s.id);
              if (s.id !== "box") setCube(false);
            }}
            className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${solidId === s.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 좌하단: 크기 조절 */}
      <div className="pointer-events-auto absolute bottom-3 left-3 w-[min(86vw,300px)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-extrabold text-slate-700">📏 크기 (cm)</span>
          {isBox && (
            <button onClick={toggleCube} className={`rounded-lg px-2 py-1 text-xs font-bold ${cube ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}>
              정육면체 {cube ? "ON" : "OFF"}
            </button>
          )}
        </div>
        {(isBox
          ? mode === "stack"
            ? ([["가로", a, "a"], ["세로", b, "b"]] as const)
            : ([["가로", a, "a"], ["세로", b, "b"], ["높이", c, "c"]] as const)
          : ([["밑면 크기", a, "a"], ["높이", c, "c"]] as const)
        ).map(([lbl, val, key]) => (
          <div key={key} className="mb-1.5 flex items-center gap-2">
            <span className="w-16 text-xs font-bold text-slate-500">{lbl}</span>
            <input type="range" min={1} max={6} value={val} onChange={(e) => setDim(key, parseInt(e.target.value))} className="flex-1 accent-indigo-600" />
            <span className="w-8 text-right text-sm font-extrabold text-slate-800">{val}</span>
          </div>
        ))}
        {mode === "stack" && isBox && (
          <div className="mt-1 rounded-xl bg-slate-50 p-2">
            <div className="mb-1 text-[11px] font-bold text-slate-500">위에서 본 칸 — 탭하면 ↑쌓기, 우클릭 ↓허물기</div>
            <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `repeat(${a}, minmax(0,1fr))` }}>
              {Array.from({ length: b }).map((_, j) =>
                Array.from({ length: a }).map((__, i) => {
                  const h = heights[i]?.[j] ?? 0;
                  return (
                    <button
                      key={`${i}-${j}`}
                      onClick={() => bumpCell(i, j, 1)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        bumpCell(i, j, -1);
                      }}
                      className="grid h-7 w-7 place-items-center rounded text-xs font-extrabold"
                      style={{ backgroundColor: h ? `rgba(96,165,250,${0.25 + h * 0.12})` : "#e2e8f0", color: h ? "#1e3a8a" : "#94a3b8" }}
                    >
                      {h || ""}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => setAuto((v) => !v)} className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold ${auto ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}>
            {auto ? "⏸ 자동회전 끄기" : "▶ 자동회전"}
          </button>
          <span className="text-[11px] text-slate-400">드래그=돌리기</span>
        </div>
      </div>

      {/* 우하단: 정보/도구 */}
      <div className="pointer-events-auto absolute bottom-3 right-3 w-[min(86vw,300px)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
        {mode === "net" ? (
          <>
            <div className="mb-2 text-sm font-extrabold text-slate-700">📄 {data.name} 전개도</div>
            {isBox ? (
              <>
                <input type="range" min={0} max={100} value={Math.round(foldT * 100)} onChange={(e) => setFoldT(parseInt(e.target.value) / 100)} className="w-full accent-indigo-600" />
                <div className="mt-1 flex justify-between text-xs font-bold text-slate-500">
                  <button onClick={() => setFoldT(0)} className="hover:text-indigo-600">펼치기</button>
                  <span>{Math.round(foldT * 100)}%</span>
                  <button onClick={() => setFoldT(1)} className="hover:text-indigo-600">접기 ▶</button>
                </div>
                <div className="mt-2 text-xs leading-relaxed text-slate-500">슬라이더로 전개도가 상자로 접히는 걸 관찰해요. 면 {data.counts.faces}개가 어떻게 모이는지 보세요!</div>
                <button
                  onClick={() => setNetQuiz(true)}
                  className="mt-2 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700"
                >
                  🧩 전개도 맞추기 퀴즈 (11가지)
                </button>
              </>
            ) : (
              <div className="text-xs leading-relaxed text-slate-500">
                펼친 전개도예요. 옆면 <b className="text-slate-800">{solid.n}개</b> + 밑면이 모여 {data.name}을 만들어요. <span className="text-slate-400">(접기 애니메이션은 직육면체에서)</span>
              </div>
            )}
          </>
        ) : mode === "section" ? (
          <>
            <div className="mb-2 text-sm font-extrabold text-slate-700">✂️ 단면 (수평으로 자르기)</div>
            <input type="range" min={-95} max={95} value={Math.round(cutY * 100)} onChange={(e) => setCutY(parseInt(e.target.value) / 100)} className="w-full accent-rose-500" />
            <div className="mt-1 flex justify-between text-[11px] font-bold text-slate-400"><span>아래</span><span>가운데</span><span>위</span></div>
            <div className="mt-2 flex items-center gap-3">
              <div className="rounded-xl border border-slate-200 bg-white p-1">
                <SectionShape poly={sectionPoly} />
              </div>
              <div>
                <div className="text-[10px] font-semibold text-slate-400">단면 넓이</div>
                <div className="text-xl font-extrabold text-rose-600">{sectionArea}cm²</div>
              </div>
            </div>
            <div className="mt-2 text-[11px] leading-relaxed text-slate-400">
              {solid.kind === "pyramid" ? "뿔은 위로 갈수록 단면이 작아져요." : isBox || solid.kind === "prism" ? "기둥은 어디를 잘라도 단면이 똑같아요!" : ""}
            </div>
          </>
        ) : mode === "stack" && isBox ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-extrabold text-slate-700">🧊 쌓기나무</span>
              <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">부피 = 쌓은 칸 수</span>
            </div>
            <Stat label="쌓은 쌓기나무(부피)" value={`${stackVolume}개 = ${stackVolume}cm³`} big />
            <div className="mt-2 text-[11px] font-bold text-slate-500">세 방향에서 본 모양</div>
            <div className="mt-1 flex gap-2">
              <ViewBox title="위">
                <NumGrid cols={a} rows={b} val={(i, j) => heights[i]?.[j] ?? 0} />
              </ViewBox>
              <ViewBox title="앞">
                <SilGrid cols={a} maxH={stackMaxH} colH={(i) => frontMax[i]} />
              </ViewBox>
              <ViewBox title="옆">
                <SilGrid cols={b} maxH={stackMaxH} colH={(j) => sideMax[j]} />
              </ViewBox>
            </div>
            <div className="mt-2 text-[11px] leading-relaxed text-slate-400">위 칸을 탭해 쌓고, 세 방향 그림자가 어떻게 바뀌는지 보세요!</div>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-extrabold text-slate-700">{data.name}</span>
              {mode === "stack" && !isBox && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">쌓기나무는 직육면체</span>}
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <Stat label="면" value={`${data.counts.faces}`} />
              <Stat label="모서리" value={`${data.counts.edges}`} />
              <Stat label="꼭짓점" value={`${data.counts.verts}`} />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <Stat label="겉넓이" value={data.surfaceText} big />
              <Stat label="부피" value={data.volumeText} big />
            </div>
            {mode === "view" && (
              <div className="mt-2 flex flex-wrap gap-1">
                <Toggle on={showFaces} set={setShowFaces} label="면" />
                <Toggle on={showEdges} set={setShowEdges} label="모서리" />
                <Toggle on={showVerts} set={setShowVerts} label="꼭짓점" />
                <Toggle on={showNames} set={setShowNames} label="이름" />
              </div>
            )}
          </>
        )}
      </div>

      {netQuiz && <CubeNetQuiz onClose={() => setNetQuiz(false)} />}
      {solidQuiz && <SolidQuiz onClose={() => setSolidQuiz(false)} />}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 px-2 py-1.5">
      <div className="text-[10px] font-semibold text-slate-400">{label}</div>
      <div className={`font-extrabold text-slate-900 ${big ? "text-lg" : "text-base"}`}>{value}</div>
    </div>
  );
}

function SectionShape({ poly }: { poly: { x: number; z: number }[] }) {
  const S = 70;
  if (poly.length < 3) return <div className="grid h-[70px] w-[70px] place-items-center text-[10px] text-slate-300">없음</div>;
  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const w = Math.max(0.5, maxX - minX);
  const h = Math.max(0.5, maxZ - minZ);
  const sc = (S - 12) / Math.max(w, h);
  const pts = poly.map((p) => `${6 + (p.x - minX) * sc},${6 + (p.z - minZ) * sc}`).join(" ");
  return (
    <svg width={S} height={S}>
      <polygon points={pts} fill="rgba(244,63,94,0.4)" stroke="#e11d48" strokeWidth="2" />
    </svg>
  );
}

function ViewBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-bold text-slate-500">{title}</span>
      <div className="rounded-lg border border-slate-200 bg-white p-1">{children}</div>
    </div>
  );
}

function NumGrid({ cols, rows, val }: { cols: number; rows: number; val: (i: number, j: number) => number }) {
  return (
    <div className="inline-grid gap-px" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {Array.from({ length: rows }).map((_, j) =>
        Array.from({ length: cols }).map((__, i) => {
          const h = val(i, j);
          return (
            <div
              key={`${i}-${j}`}
              className="grid h-4 w-4 place-items-center rounded-[2px] text-[9px] font-bold"
              style={{ backgroundColor: h ? `rgba(96,165,250,${0.3 + h * 0.1})` : "#f1f5f9", color: h ? "#1e3a8a" : "#cbd5e1" }}
            >
              {h || ""}
            </div>
          );
        })
      )}
    </div>
  );
}

function SilGrid({ cols, maxH, colH }: { cols: number; maxH: number; colH: (i: number) => number }) {
  return (
    <div className="inline-grid gap-px" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {Array.from({ length: maxH }).map((_, r) =>
        Array.from({ length: cols }).map((__, i) => {
          const fromBottom = maxH - 1 - r; // 위에서부터 그리되 아래가 채워지도록
          const filled = fromBottom < colH(i);
          return (
            <div
              key={`${i}-${r}`}
              className="h-4 w-4 rounded-[2px]"
              style={{ backgroundColor: filled ? "#60a5fa" : "#f1f5f9" }}
            />
          );
        })
      )}
    </div>
  );
}

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <button onClick={() => set(!on)} className={`rounded-lg border px-2 py-1 text-xs font-bold ${on ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-400"}`}>
      {label}
    </button>
  );
}
