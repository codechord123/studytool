import PolygonCanvas from "@/components/PolygonCanvas";

export default function Home() {
  return (
    <main className="mx-auto w-full px-2 sm:px-3 py-2">
      <header className="mb-2 flex items-baseline gap-3 relative">
        <h1 className="text-lg sm:text-xl font-bold text-slate-900">
          다각형의 둘레와 넓이 체험실
        </h1>
        <span className="text-xs text-slate-500 hidden sm:inline">
          초등 5학년 · 도형을 자르고 합치고 돌리며 공식 익히기
        </span>
        <details className="sm:hidden ml-auto group">
          <summary className="text-xs text-slate-500 cursor-pointer list-none px-2 py-1 rounded-md border border-slate-200 bg-white">
            ❓ 안내
          </summary>
          <div className="absolute right-0 mt-1 z-30 w-[280px] rounded-lg border border-slate-200 bg-white shadow-lg p-3 text-xs text-slate-600 leading-relaxed">
            초등 5학년 · 도형을 자르고 합치고 돌리며 둘레와 넓이의 공식을 직관적으로
            익혀 보세요. 도형 추가 · 학습 예시 패널은 툴바에서 열고 닫을 수 있어요.
          </div>
        </details>
      </header>
      <PolygonCanvas />
    </main>
  );
}
