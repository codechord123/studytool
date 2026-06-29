"use client";

import { useEffect, useRef, useState } from "react";
import {
  V3,
  rotate,
  cross,
  sub,
  norm,
  dot,
  cuboidFaces,
  cuboidEdges,
  cuboidCorners,
  cuboidNetFaces,
  v,
  add,
} from "@/lib/solid3d";

type Mode = "view" | "stack" | "net";

const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185"];

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
  const [a, setA] = useState(4);
  const [b, setB] = useState(3);
  const [c, setC] = useState(2);
  const [cube, setCube] = useState(false); // 정육면체(정n) 잠금
  const [yaw, setYaw] = useState(-0.6);
  const [pitch, setPitch] = useState(0.5);
  const [auto, setAuto] = useState(true);
  const [foldT, setFoldT] = useState(0); // 전개도 접힘 0..1
  const [showFaces, setShowFaces] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [showVerts, setShowVerts] = useState(true);
  const [showNames, setShowNames] = useState(true);

  const color = COLORS[0];

  // 정육면체 잠금 시 한 변으로 동기화
  function setDim(which: "a" | "b" | "c", val: number) {
    if (cube) {
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

  // ----- 크기 추적 -----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ----- 자동 회전 -----
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

  // ----- 드래그로 회전 -----
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

  // ----- 렌더 -----
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
    const maxDim = Math.max(a, b, c, 3);
    const baseScale = Math.min(size.w, size.h) / (maxDim * 2.9);
    const L = norm(v(-0.4, 0.7, 0.6)); // 광원

    const project = (p: V3) => {
      const r = rotate(p, yaw, pitch);
      const f = 9;
      const persp = f / (f - r.z / maxDim); // 약한 원근
      return { x: cx + r.x * baseScale * persp, y: cy - r.y * baseScale * persp, depth: r.z };
    };
    const faceNormalRot = (pts: V3[]) => {
      const n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
      return rotate(n, yaw, pitch);
    };

    // 그릴 면 모으기
    type Draw = { pts: V3[]; color: string; label?: string; twoSided: boolean };
    let faces: Draw[] = [];
    if (mode === "view") {
      faces = cuboidFaces(a, b, c, color).map((f) => ({ ...f, twoSided: false }));
    } else if (mode === "net") {
      faces = cuboidNetFaces(a, b, c, foldT, color).map((f) => ({ ...f, twoSided: true }));
    } else {
      // 쌓기나무: 단위 정육면체 a×b×c개
      const hx = a / 2;
      const hy = b / 2;
      const hz = c / 2;
      for (let i = 0; i < a; i++)
        for (let j = 0; j < b; j++)
          for (let kk = 0; kk < c; kk++) {
            const o = v(i - hx, j - hy, kk - hz);
            const unit = cuboidFaces(1, 1, 1, color).map((f) => ({
              pts: f.pts.map((p) => add(p, add(o, v(0.5, 0.5, 0.5)))),
              color,
              twoSided: false,
            }));
            faces.push(...unit);
          }
    }

    // 면 그리기 (painter's: 먼 것부터)
    if (showFaces || mode !== "view") {
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

      for (const d of drawList) {
        if (!showFaces && mode === "view") break;
        ctx.beginPath();
        ctx.moveTo(d.proj[0].x, d.proj[0].y);
        for (let i = 1; i < d.proj.length; i++) ctx.lineTo(d.proj[i].x, d.proj[i].y);
        ctx.closePath();
        ctx.fillStyle = shade(d.f.color, Math.min(1.15, d.bright));
        ctx.globalAlpha = mode === "net" ? 0.92 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(15,23,42,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // 면 이름
        if (showNames && d.f.label && (d.facing || mode === "net")) {
          const ccx = d.proj.reduce((s, p) => s + p.x, 0) / d.proj.length;
          const ccy = d.proj.reduce((s, p) => s + p.y, 0) / d.proj.length;
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = "bold 13px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tw = ctx.measureText(d.f.label).width;
          ctx.fillStyle = "rgba(15,23,42,0.65)";
          ctx.fillRect(ccx - tw / 2 - 5, ccy - 9, tw + 10, 18);
          ctx.fillStyle = "#fff";
          ctx.fillText(d.f.label, ccx, ccy);
          ctx.textAlign = "start";
          ctx.textBaseline = "alphabetic";
        }
      }
    }

    // 모서리·꼭짓점 (입체보기에서 강조)
    if (mode === "view") {
      if (showEdges) {
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 2.5;
        for (const [p1, p2] of cuboidEdges(a, b, c)) {
          const s1 = project(p1);
          const s2 = project(p2);
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();
        }
      }
      if (showVerts) {
        for (const corner of cuboidCorners(a, b, c)) {
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
  }, [size, mode, a, b, c, yaw, pitch, foldT, showFaces, showEdges, showVerts, showNames, color]);

  const surface = 2 * (a * b + b * c + c * a);
  const volume = a * b * c;
  const isCube = a === b && b === c;

  const seg = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-bold transition ${active ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"}`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100">
      <div
        ref={wrapRef}
        className="absolute inset-0"
        style={{ touchAction: "none", cursor: dragRef.current ? "grabbing" : "grab" }}
      >
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} className="h-full w-full" />
      </div>

      {/* 상단 바 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-lg backdrop-blur">
          <a href="/" className="whitespace-nowrap text-sm font-bold text-slate-400 hover:text-slate-700" title="2D 다각형 체험실로">
            ← 평면
          </a>
          <span className="mx-1 h-5 w-px bg-slate-200" />
          <span className="whitespace-nowrap text-base font-extrabold text-slate-800">🧊 입체도형 체험실</span>
        </div>
        <div className="pointer-events-auto flex gap-1.5 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-lg backdrop-blur">
          <button onClick={() => setMode("view")} className={seg(mode === "view")}>📦 입체보기</button>
          <button onClick={() => setMode("stack")} className={seg(mode === "stack")}>🧊 쌓기나무</button>
          <button onClick={() => setMode("net")} className={seg(mode === "net")}>📄 전개도</button>
        </div>
      </div>

      {/* 좌하단: 크기 조절 */}
      <div className="pointer-events-auto absolute bottom-3 left-3 w-[min(86vw,300px)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-extrabold text-slate-700">📏 크기 (cm)</span>
          <button
            onClick={toggleCube}
            className={`rounded-lg px-2 py-1 text-xs font-bold ${cube ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
          >
            정육면체 {cube ? "ON" : "OFF"}
          </button>
        </div>
        {([
          ["가로", a, "a"],
          ["세로", b, "b"],
          ["높이", c, "c"],
        ] as const).map(([lbl, val, key]) => (
          <div key={key} className="mb-1.5 flex items-center gap-2">
            <span className="w-9 text-xs font-bold text-slate-500">{lbl}</span>
            <input
              type="range"
              min={1}
              max={6}
              value={val}
              onChange={(e) => setDim(key, parseInt(e.target.value))}
              className="flex-1 accent-indigo-600"
            />
            <span className="w-8 text-right text-sm font-extrabold text-slate-800">{val}</span>
          </div>
        ))}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => setAuto((v) => !v)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold ${auto ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
          >
            {auto ? "⏸ 자동회전 끄기" : "▶ 자동회전"}
          </button>
          <span className="text-[11px] text-slate-400">드래그=돌리기</span>
        </div>
      </div>

      {/* 우하단: 정보/도구 */}
      <div className="pointer-events-auto absolute bottom-3 right-3 w-[min(86vw,300px)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
        {mode === "net" ? (
          <>
            <div className="mb-2 text-sm font-extrabold text-slate-700">📄 전개도 접기</div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(foldT * 100)}
              onChange={(e) => setFoldT(parseInt(e.target.value) / 100)}
              className="w-full accent-indigo-600"
            />
            <div className="mt-1 flex justify-between text-xs font-bold text-slate-500">
              <button onClick={() => setFoldT(0)} className="hover:text-indigo-600">펼치기</button>
              <span>{Math.round(foldT * 100)}%</span>
              <button onClick={() => setFoldT(1)} className="hover:text-indigo-600">접기 ▶</button>
            </div>
            <div className="mt-2 text-xs leading-relaxed text-slate-500">
              슬라이더로 전개도가 상자로 접히는 걸 관찰해요. 면 6개가 어떻게 모이는지 보세요!
            </div>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-extrabold text-slate-700">{isCube ? "정육면체" : "직육면체"}</span>
              {mode === "stack" && <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">부피 = 쌓은 칸 수</span>}
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <Stat label="면" value="6" />
              <Stat label="모서리" value="12" />
              <Stat label="꼭짓점" value="8" />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <Stat label="겉넓이" value={`${surface}cm²`} big />
              <Stat label="부피" value={`${volume}cm³`} big />
            </div>
            {mode === "view" && (
              <div className="mt-2 flex flex-wrap gap-1">
                <Toggle on={showFaces} set={setShowFaces} label="면" />
                <Toggle on={showEdges} set={setShowEdges} label="모서리" />
                <Toggle on={showVerts} set={setShowVerts} label="꼭짓점" />
                <Toggle on={showNames} set={setShowNames} label="이름" />
              </div>
            )}
            {mode === "stack" && (
              <div className="mt-2 text-xs leading-relaxed text-slate-500">
                단위 쌓기나무 {a}×{b}×{c} = <b className="text-slate-800">{volume}개</b>. 한 층({a}×{b}={a * b}개)이 {c}층!
              </div>
            )}
          </>
        )}
      </div>
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

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => set(!on)}
      className={`rounded-lg border px-2 py-1 text-xs font-bold ${on ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-400"}`}
    >
      {label}
    </button>
  );
}
