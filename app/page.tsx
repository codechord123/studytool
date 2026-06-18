import PolygonCanvas from "@/components/PolygonCanvas";

export default function Home() {
  return (
    <main className="mx-auto max-w-[1400px] px-3 sm:px-4 py-4 sm:py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">
          다각형의 둘레와 넓이 체험실
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          도형을 자유롭게 그리고, 옮기고, 돌리고, 잘라 보면서 둘레와 넓이가 어떻게 변하는지
          살펴보세요.
        </p>
      </header>
      <PolygonCanvas />
      <footer className="mt-6 text-xs text-slate-400">
        초등학교 5학년 · 다각형 학습 도구
      </footer>
    </main>
  );
}
