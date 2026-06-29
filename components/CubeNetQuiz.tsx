"use client";

import { useEffect, useState } from "react";
import { foldsToCube } from "@/lib/solid3d";

type Cells = [number, number][];

// 무작위 육각 폴리오미노(6칸 연결) 생성
function randomHexomino(rnd: () => number): Cells {
  const set = new Set<string>(["0,0"]);
  const cells: Cells = [[0, 0]];
  let guard = 0;
  while (cells.length < 6 && guard++ < 200) {
    const [bx, by] = cells[Math.floor(rnd() * cells.length)];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const [dx, dy] = dirs[Math.floor(rnd() * 4)];
    const k = `${bx + dx},${by + dy}`;
    if (!set.has(k)) {
      set.add(k);
      cells.push([bx + dx, by + dy]);
    }
  }
  return cells;
}

function normalize(cells: Cells): Cells {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY]);
}

function makeProblem(wantValid: boolean, rnd: () => number): Cells {
  let last: Cells = [];
  for (let i = 0; i < 80; i++) {
    const g = randomHexomino(rnd);
    if (g.length !== 6) continue;
    last = g;
    if (foldsToCube(g) === wantValid) return normalize(g);
  }
  return normalize(last);
}

export default function CubeNetQuiz({ onClose }: { onClose: () => void }) {
  const [cells, setCells] = useState<Cells>([]);
  const [result, setResult] = useState<"idle" | "right" | "wrong">("idle");
  const [score, setScore] = useState(0);
  const [total, setTotal] = useState(0);

  function next() {
    const wantValid = Math.random() < 0.5;
    let prng = Math.floor(Math.random() * 233280) + 1;
    const r = () => {
      prng = (prng * 9301 + 49297) % 233280;
      return prng / 233280;
    };
    setCells(makeProblem(wantValid, r));
    setResult("idle");
  }
  useEffect(() => {
    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const correct = cells.length === 6 ? foldsToCube(cells) : false;
  function respond(val: boolean) {
    if (result !== "idle") return;
    const ok = val === correct;
    setResult(ok ? "right" : "wrong");
    setTotal((t) => t + 1);
    if (ok) setScore((s) => s + 1);
  }

  const cols = cells.length ? Math.max(...cells.map((c) => c[0])) + 1 : 1;
  const rows = cells.length ? Math.max(...cells.map((c) => c[1])) + 1 : 1;
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="w-[min(94vw,420px)] rounded-2xl border-2 border-indigo-300 bg-white p-5 shadow-2xl">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-base font-extrabold text-indigo-700">🧩 전개도 맞추기</span>
          <button onClick={onClose} className="text-xs font-bold text-slate-400 hover:text-slate-600">닫기 ✕</button>
        </div>
        <div className="mb-3 text-sm text-slate-600">이 전개도를 접으면 <b>정육면체</b>가 될까요?</div>

        <div className="flex justify-center rounded-xl bg-slate-50 py-5">
          <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, 34px)` }}>
            {Array.from({ length: rows }).map((_, y) =>
              Array.from({ length: cols }).map((__, x) => {
                const on = set.has(`${x},${y}`);
                return (
                  <div
                    key={`${x}-${y}`}
                    className="h-[34px] w-[34px] rounded-[3px]"
                    style={{ backgroundColor: on ? "#6366f1" : "transparent", border: on ? "1px solid #4338ca" : "none" }}
                  />
                );
              })
            )}
          </div>
        </div>

        {result === "idle" ? (
          <div className="mt-4 flex gap-2">
            <button onClick={() => respond(true)} className="flex-1 rounded-xl bg-emerald-500 py-3 text-base font-extrabold text-white hover:bg-emerald-600">
              ⭕ 정육면체 돼요
            </button>
            <button onClick={() => respond(false)} className="flex-1 rounded-xl bg-rose-500 py-3 text-base font-extrabold text-white hover:bg-rose-600">
              ❌ 안 돼요
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <div className={`rounded-xl px-4 py-3 text-center text-base font-extrabold ${result === "right" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
              {result === "right" ? "🎉 정답!" : "아쉬워요!"} — 이 전개도는 {correct ? "정육면체가 돼요 ✅" : "정육면체가 안 돼요 ❌"}
            </div>
            <button onClick={next} className="mt-3 w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">
              다음 ▶
            </button>
          </div>
        )}

        <div className="mt-3 text-center text-xs font-bold text-slate-400">
          점수 {score} / {total} · 정육면체 전개도는 모두 <b className="text-slate-600">11가지</b>예요!
        </div>
      </div>
    </div>
  );
}
