import PolygonCanvas from "@/components/PolygonCanvas";

export default function Home() {
  return (
    <main className="mx-auto w-full px-2 sm:px-3 py-2">
      <header className="mb-2 flex items-baseline gap-3">
        <h1 className="text-lg sm:text-xl font-bold text-slate-900">
          다각형의 둘레와 넓이 체험실
        </h1>
        <span className="text-xs text-slate-500 hidden sm:inline">
          초등 5학년 · 도형을 자르고 합치고 돌리며 공식 익히기
        </span>
      </header>
      <PolygonCanvas />
    </main>
  );
}
