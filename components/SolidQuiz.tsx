"use client";

import { useEffect, useRef, useState } from "react";
import { SolidSpec, buildSolid, rotate, cross, sub, norm, dot, V3, v } from "@/lib/solid3d";

type QType = "faces" | "edges" | "verts" | "surface" | "volume";
type Problem = { spec: SolidSpec; name: string; qtype: QType; answer: number; question: string; unit: string };

const KINDS = [
  { kind: "box" as const, n: 4 },
  { kind: "prism" as const, n: 3 },
  { kind: "prism" as const, n: 5 },
  { kind: "prism" as const, n: 6 },
  { kind: "pyramid" as const, n: 3 },
  { kind: "pyramid" as const, n: 4 },
  { kind: "pyramid" as const, n: 5 },
];
const ri = (lo: number, hi: number) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function makeProblem(): Problem {
  // 겉넓이·부피는 직육면체(정수), 구성요소 수는 모든 입체
  const countQ = Math.random() < 0.5;
  const qtype: QType = countQ
    ? (["faces", "edges", "verts"] as const)[ri(0, 2)]
    : (["surface", "volume"] as const)[ri(0, 1)];
  let spec: SolidSpec;
  if (qtype === "surface" || qtype === "volume") {
    spec = { kind: "box", n: 4, a: ri(2, 6), b: ri(2, 5), c: ri(2, 5), R: 0, h: 0 };
  } else {
    const k = KINDS[ri(0, KINDS.length - 1)];
    spec = k.kind === "box" ? { kind: "box", n: 4, a: ri(2, 5), b: ri(2, 5), c: ri(2, 5), R: 0, h: 0 } : { kind: k.kind, n: k.n, a: 0, b: 0, c: 0, R: 3, h: 3 };
  }
  const data = buildSolid(spec, "#60a5fa");
  const map: Record<QType, { q: string; ans: number; unit: string }> = {
    faces: { q: "면은 몇 개일까요?", ans: data.counts.faces, unit: "개" },
    edges: { q: "모서리는 몇 개일까요?", ans: data.counts.edges, unit: "개" },
    verts: { q: "꼭짓점은 몇 개일까요?", ans: data.counts.verts, unit: "개" },
    surface: { q: "겉넓이는 몇 cm²일까요?", ans: data.surface, unit: "cm²" },
    volume: { q: "부피는 몇 cm³일까요?", ans: data.volume, unit: "cm³" },
  };
  const dimText =
    spec.kind === "box"
      ? `가로 ${spec.a}, 세로 ${spec.b}, 높이 ${spec.c}cm인 ${data.name}`
      : `${data.name}`;
  const m = map[qtype];
  return { spec, name: data.name, qtype, answer: m.ans, question: `${dimText}의 ${m.q}`, unit: m.unit };
}

function Thumb({ spec }: { spec: SolidSpec }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 150;
    const Hh = 130;
    cv.width = W * dpr;
    cv.height = Hh * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    const data = buildSolid(spec, "#60a5fa");
    const yaw = -0.6;
    const pitch = 0.5;
    const maxDim = Math.max(spec.a, spec.b, spec.c, spec.R * 2, 4, spec.h);
    const sc = Math.min(W, Hh) / (maxDim * 2.6);
    const L = norm(v(-0.4, 0.7, 0.6));
    const proj = (p: V3) => {
      const r = rotate(p, yaw, pitch);
      const f = 9;
      const pe = f / (f - r.z / maxDim);
      return { x: W / 2 + r.x * sc * pe, y: Hh / 2 - r.y * sc * pe, depth: r.z };
    };
    const list = data.faces
      .map((fc) => {
        const nr = rotate(norm(cross(sub(fc.pts[1], fc.pts[0]), sub(fc.pts[2], fc.pts[0]))), yaw, pitch);
        const pr = fc.pts.map(proj);
        return { pr, depth: pr.reduce((s, p) => s + p.depth, 0) / pr.length, facing: nr.z > 0, bright: 0.6 + 0.45 * Math.abs(dot(nr, L)) };
      })
      .filter((d) => d.facing)
      .sort((x, y) => x.depth - y.depth);
    for (const d of list) {
      ctx.beginPath();
      ctx.moveTo(d.pr[0].x, d.pr[0].y);
      for (let i = 1; i < d.pr.length; i++) ctx.lineTo(d.pr[i].x, d.pr[i].y);
      ctx.closePath();
      const c = Math.min(255, Math.round(150 * d.bright));
      ctx.fillStyle = `rgb(${Math.round(c * 0.6)},${Math.round(c * 0.9)},255)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(15,23,42,0.5)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }, [spec]);
  return <canvas ref={ref} style={{ width: 150, height: 130 }} />;
}

export default function SolidQuiz({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<Problem | null>(null);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<"idle" | "right" | "wrong">("idle");
  const [score, setScore] = useState(0);
  const [total, setTotal] = useState(0);

  function next() {
    setP(makeProblem());
    setInput("");
    setResult("idle");
  }
  useEffect(() => {
    next();
  }, []);

  function check() {
    if (!p || result !== "idle" || !/[0-9]/.test(input)) return;
    const val = parseFloat(input.replace(/[^0-9.]/g, ""));
    const ok = Math.abs(val - p.answer) <= 0.05;
    setResult(ok ? "right" : "wrong");
    setTotal((t) => t + 1);
    if (ok) setScore((s) => s + 1);
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="w-[min(94vw,420px)] rounded-2xl border-2 border-indigo-300 bg-white p-5 shadow-2xl">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-base font-extrabold text-indigo-700">❓ 입체도형 퀴즈</span>
          <button onClick={onClose} className="text-xs font-bold text-slate-400 hover:text-slate-600">닫기 ✕</button>
        </div>
        {p && (
          <>
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-slate-50 p-1">
                <Thumb spec={p.spec} />
              </div>
              <div className="flex-1 text-sm font-bold leading-relaxed text-slate-800">{p.question}</div>
            </div>
            {result === "idle" ? (
              <div className="mt-4 flex items-center gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && check()}
                  inputMode="numeric"
                  placeholder="답"
                  autoFocus
                  className="w-28 rounded-lg border-2 border-slate-300 px-3 py-2 text-xl font-bold text-slate-900 outline-none focus:border-indigo-500"
                />
                <span className="text-sm font-medium text-slate-500">{p.unit}</span>
                <button onClick={check} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700">확인</button>
              </div>
            ) : (
              <div className="mt-4">
                <div className={`rounded-xl px-4 py-3 text-center text-base font-extrabold ${result === "right" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {result === "right" ? "🎉 정답!" : "아쉬워요!"} — 답은 <b>{p.answer}{p.unit}</b>
                </div>
                <button onClick={next} className="mt-3 w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">다음 ▶</button>
              </div>
            )}
            <div className="mt-3 text-center text-xs font-bold text-slate-400">점수 {score} / {total}</div>
          </>
        )}
      </div>
    </div>
  );
}
