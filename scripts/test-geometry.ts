// 간단한 단위 테스트 — node로 실행: npx tsx scripts/test-geometry.ts
import {
  splitPolygonByLine,
  mergePolygons,
  polygonArea,
  polygonPerimeter,
  makeRectangle,
  makeRightTriangle,
  makeTriangle,
  makeTrapezoid,
  makeParallelogram,
  makeRhombus,
  rotatePoints,
  scalePoints,
  flipPoints,
  pointInPolygon,
  polygonCentroid,
  ensureCW,
  signedArea,
} from "../lib/geometry";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fail++;
    console.log("  ✗ FAIL:", msg);
  }
}
function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}
function group(name: string, fn: () => void) {
  console.log("\n▶", name);
  fn();
}

const GRID = 40;

// ---------- 기본 도형 넓이/둘레 ----------
group("기본 도형 넓이·둘레 (1cm = 40px)", () => {
  const rect = makeRectangle(200, 200, 6 * GRID, 4 * GRID);
  assert(near(polygonArea(rect) / (GRID * GRID), 24), `6×4 직사각형 넓이 = 24cm² (got ${polygonArea(rect) / (GRID * GRID)})`);
  assert(near(polygonPerimeter(rect) / GRID, 20), `6×4 직사각형 둘레 = 20cm (got ${polygonPerimeter(rect) / GRID})`);

  const rtri = makeRightTriangle(200, 200, 6 * GRID, 4 * GRID);
  assert(near(polygonArea(rtri) / (GRID * GRID), 12), `직각삼각형 6×4 넓이 = 12cm²`);

  const trap = makeTrapezoid(200, 200, 2 * GRID, 6 * GRID, 4 * GRID);
  // (2+6)×4÷2 = 16
  assert(near(polygonArea(trap) / (GRID * GRID), 16), `사다리꼴(2,6,h=4) 넓이 = 16cm² (got ${polygonArea(trap) / (GRID * GRID)})`);

  const para = makeParallelogram(200, 200, 6 * GRID, 4 * GRID, 2 * GRID);
  // 밑변6 × 높이4 = 24
  assert(near(polygonArea(para) / (GRID * GRID), 24), `평행사변형 밑변6 높이4 넓이 = 24cm²`);

  const rhom = makeRhombus(200, 200, 6 * GRID, 4 * GRID);
  // 6×4÷2 = 12
  assert(near(polygonArea(rhom) / (GRID * GRID), 12), `마름모 대각선 6×4 넓이 = 12cm²`);
});

// ---------- 정수 꼭짓점 검사 (1cm 스냅 호환) ----------
group("프리셋 도형의 모든 꼭짓점이 정수 cm 위에 있는지", () => {
  function allInteger(name: string, pts: { x: number; y: number }[]) {
    const ok = pts.every((p) => near(p.x / GRID, Math.round(p.x / GRID), 0.001) && near(p.y / GRID, Math.round(p.y / GRID), 0.001));
    assert(ok, `${name} — 모든 꼭짓점이 정수 cm`);
  }
  allInteger("정사각형 4×4", makeRectangle(0, 0, 4 * GRID, 4 * GRID));
  allInteger("직사각형 8×4", makeRectangle(0, 0, 8 * GRID, 4 * GRID));
  allInteger("직각삼각형 6×4", makeRightTriangle(0, 0, 6 * GRID, 4 * GRID));
  allInteger("삼각형 6×4 (apex 정수 위치)", makeTriangle(0, 0, 6 * GRID, 4 * GRID));
  allInteger("평행사변형", makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID));
  allInteger("사다리꼴 (2,6,h=4)", makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID));
  allInteger("마름모 6×4", makeRhombus(0, 0, 6 * GRID, 4 * GRID));
});

// ---------- 자르기 ----------
group("splitPolygonByLine — 일반 자르기", () => {
  const sq = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // (0,0)~(160,160)
  // 세로선 x = 80
  const v = splitPolygonByLine(sq, { x: 80, y: -100 }, { x: 80, y: 300 });
  assert(v !== null && v.length === 2, "정사각형 세로 자르기 — 두 조각 반환");
  if (v) {
    const areas = v.map((p) => polygonArea(p) / (GRID * GRID));
    assert(near(areas[0] + areas[1], 16), `세로 자르기 두 조각 넓이 합 = 16 (got ${areas[0] + areas[1]})`);
    assert(near(areas[0], 8) && near(areas[1], 8), `세로 자르기 두 조각 각각 8cm²`);
  }
});

group("splitPolygonByLine — 가로 자르기", () => {
  const sq = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID);
  const h = splitPolygonByLine(sq, { x: -100, y: 80 }, { x: 300, y: 80 });
  assert(h !== null && h.length === 2, "가로 자르기 — 두 조각");
  if (h) {
    const areas = h.map((p) => polygonArea(p) / (GRID * GRID));
    assert(near(areas[0], 8) && near(areas[1], 8), "가로 자르기 두 조각 각각 8cm²");
  }
});

group("splitPolygonByLine — 모서리(꼭짓점) 경유 대각선 자르기 (이전 버그)", () => {
  const sq = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // (0,0)(160,0)(160,160)(0,160)
  // 대각선: (0,0) -> (160,160) — V0와 V2를 정확히 지남
  const d = splitPolygonByLine(sq, { x: 0, y: 0 }, { x: 160, y: 160 });
  assert(d !== null && d.length === 2, "대각선 자르기 — 두 조각 반환");
  if (d) {
    const areas = d.map((p) => polygonArea(p) / (GRID * GRID));
    assert(near(areas[0], 8) && near(areas[1], 8), `대각선 두 삼각형 각각 8cm² (got ${areas[0]}, ${areas[1]})`);
    assert(d[0].length === 3 && d[1].length === 3, "각 조각이 삼각형 (3개의 꼭짓점)");
  }
});

group("splitPolygonByLine — 자르기 안 되는 경우", () => {
  const sq = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID);
  // 도형 바깥의 평행선
  const out = splitPolygonByLine(sq, { x: -100, y: -100 }, { x: 300, y: -100 });
  assert(out === null, "도형 밖 자르기 — null");
  // V0=(0,0) 한 꼭짓점에서만 외부에서 접하는 사선 (다른 꼭짓점은 모두 한쪽)
  const tang = splitPolygonByLine(sq, { x: 0, y: 0 }, { x: -100, y: 100 });
  assert(tang === null, "한 꼭짓점만 스치는 외부 접선 — null");
});

// ---------- 합치기 ----------
group("mergePolygons — 두 직사각형", () => {
  const A = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // 0~160, 0~160
  const B = makeRectangle(6 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // 160~320, 0~160 (오른쪽에 인접)
  const m = mergePolygons(A, B);
  assert(m !== null, "변을 공유하는 두 직사각형 합치기 성공");
  if (m) {
    assert(near(polygonArea(m) / (GRID * GRID), 32), `합쳐진 직사각형 넓이 = 32cm²`);
    assert(m.length === 4, `중복 일직선 꼭짓점 제거되어 4개의 꼭짓점 (got ${m.length})`);
  }
});

group("mergePolygons — 두 직각삼각형 → 직사각형", () => {
  // 직각삼각형 A: (0,0)(160,0)(0,120)  CW (y-down)
  const A = [
    { x: 0, y: 0 },
    { x: 160, y: 0 },
    { x: 0, y: 120 },
  ];
  // 직각삼각형 B (180° 회전): (160,120)(0,120)(160,0) — 빗변을 A와 공유
  const B = [
    { x: 160, y: 120 },
    { x: 0, y: 120 },
    { x: 160, y: 0 },
  ];
  const m = mergePolygons(A, B);
  assert(m !== null, "두 직각삼각형 합치기 성공");
  if (m) {
    const area = polygonArea(m) / (GRID * GRID);
    assert(near(area, 12), `합쳐진 직사각형 넓이 = 12cm² (got ${area})`);
  }
});

group("mergePolygons — 변 공유 안 함", () => {
  const A = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID);
  const B = makeRectangle(10 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // 멀리 떨어진
  const m = mergePolygons(A, B);
  assert(m === null, "떨어져 있는 두 도형 — null");
});

// ---------- 회전·뒤집기·확대 ----------
group("rotatePoints / flipPoints / scalePoints", () => {
  const rect = makeRectangle(0, 0, 4 * GRID, 4 * GRID);
  const area0 = polygonArea(rect);
  const r90 = rotatePoints(rect, { x: 0, y: 0 }, Math.PI / 2);
  assert(near(polygonArea(r90), area0), "회전 후 넓이 보존");
  const fH = flipPoints(rect, { x: 0, y: 0 }, "horizontal");
  assert(near(polygonArea(fH), area0), "좌우 뒤집기 후 넓이 보존");
  const s2 = scalePoints(rect, { x: 0, y: 0 }, 2, 2);
  assert(near(polygonArea(s2), area0 * 4), "×2 확대 시 넓이 4배");
});

// ---------- pointInPolygon ----------
group("pointInPolygon", () => {
  const sq = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID);
  assert(pointInPolygon({ x: 80, y: 80 }, sq), "안쪽 점");
  assert(!pointInPolygon({ x: 200, y: 200 }, sq), "바깥 점");
});

// ---------- signedArea / ensureCW ----------
group("ensureCW", () => {
  const cw = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  assert(signedArea(cw) > 0, "캔버스 좌표(y-down)에서 CW가 양수 signedArea");
  const fixed = ensureCW([...cw].reverse());
  assert(signedArea(fixed) >= 0, "ensureCW 후 양수");
});

// ---------- 교육 시나리오 종단 테스트 ----------
group("시나리오 — 두 사다리꼴 → 평행사변형 (회전 후 합치기)", () => {
  // 사다리꼴 A 와 B (모두 윗변2, 아랫변6, 높이4)
  const A = makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID);
  // B 를 180° 회전 후 A 의 오른쪽 슬랜트 끝과 맞붙도록 이동
  // A 의 오른쪽 슬랜트: top-right(1,-2) → bottom-right(3,2) [정수 cm 단위]
  // B 를 회전 후 그 왼쪽 슬랜트가 A 의 오른쪽 슬랜트와 정확히 일치하려면 이동필요
  const Brot = rotatePoints(makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID), { x: 0, y: 0 }, Math.PI);
  // Brot 의 꼭짓점들: original (-1,-2)(1,-2)(3,2)(-3,2) → 180° 회전 → (1,2)(-1,2)(-3,-2)(3,-2)
  // 그 도형의 왼쪽 슬랜트는 (-3,-2) → (-1,2) [모서리 길이 sqrt(4+16) ≈ 4.47]
  // A 의 오른쪽 슬랜트는 (1,-2)→(3,2). 일치시키려면 B 를 (1-(-3), -2-(-2)) = (4, 0) 만큼 평행이동
  const Bplaced = Brot.map((p) => ({ x: p.x + 4 * GRID, y: p.y }));
  const merged = mergePolygons(A, Bplaced);
  assert(merged !== null, "회전 후 평행이동한 두 사다리꼴이 변 공유 시 합쳐짐");
  if (merged) {
    const area = polygonArea(merged) / (GRID * GRID);
    // (윗변+아랫변)×높이÷2 × 2 = (2+6)×4÷2 × 2 = 32
    assert(near(area, 32), `평행사변형 넓이 = 32cm² (got ${area})`);
    // 정확히 4개 꼭짓점 (평행사변형)
    assert(merged.length === 4, `평행사변형의 꼭짓점 4개 (got ${merged.length})`);
  }
});

group("시나리오 — 직사각형을 대각선 자른 두 직각삼각형 다시 합치기", () => {
  const rect = makeRectangle(2 * GRID, 2 * GRID, 4 * GRID, 4 * GRID); // (0,0)~(160,160)
  const parts = splitPolygonByLine(rect, { x: 0, y: 0 }, { x: 160, y: 160 });
  assert(parts !== null && parts.length === 2, "직사각형 대각선 자르기");
  if (parts) {
    const merged = mergePolygons(parts[0], parts[1]);
    assert(merged !== null, "자른 두 조각 다시 합치기 성공");
    if (merged) {
      const area = polygonArea(merged) / (GRID * GRID);
      assert(near(area, 16), `복원된 직사각형 넓이 = 16cm² (got ${area})`);
    }
  }
});

group("시나리오 — 평행사변형 끝부분 잘라 옮겨 → 직사각형", () => {
  // 평행사변형: 밑변6, 높이4, skew2 — 4 꼭짓점
  const para = makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID);
  // x = -3*GRID (왼쪽 끝 직각삼각형 자르기)
  const cut1 = splitPolygonByLine(para, { x: -2 * GRID, y: -100 }, { x: -2 * GRID, y: 100 });
  // 잘리는지 확인 — 평행사변형의 좌하단 꼭짓점은 (-4, 2), 좌상단 (-2, -2)
  // x=-80 (-2*GRID) 라인이 좌상단을 정확히 지남 → 새 vertex-on-line 알고리즘이 처리해야 함
  assert(cut1 !== null && cut1.length === 2, "평행사변형 끝 직각삼각형 자르기 (꼭짓점 경유)");
  if (cut1) {
    const areaSum = cut1.reduce((a, pts) => a + polygonArea(pts) / (GRID * GRID), 0);
    assert(near(areaSum, 24), `잘린 두 조각 넓이 합 = 평행사변형 넓이 24 (got ${areaSum})`);
  }
});

group("시나리오 — 사다리꼴 중간선에서 잘라 직사각형 만들기", () => {
  const trap = makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID);
  // 가운데(y=0) 가로선으로 자르기
  const parts = splitPolygonByLine(trap, { x: -200, y: 0 }, { x: 200, y: 0 });
  assert(parts !== null && parts.length === 2, "사다리꼴 가로 자르기");
  if (parts) {
    const areaSum = parts.reduce((a, pts) => a + polygonArea(pts) / (GRID * GRID), 0);
    assert(near(areaSum, 16), `잘린 두 조각 넓이 합 = 16cm² (사다리꼴 넓이)`);
  }
});

// ---------- 새 도형 + 자동 인식 ----------
import {
  makeHexagon,
  makeLShape,
  makeCross,
  detectShapeKind,
} from "../lib/geometry";

group("새 프리셋 도형 — 육각형/ㄴ자/십자", () => {
  const hex = makeHexagon(0, 0, 3 * GRID);
  assert(hex.length === 6, "정육각형 꼭짓점 6개");
  // 6개의 변 모두 동일 길이
  const hexSides: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = hex[i], b = hex[(i + 1) % 6];
    hexSides.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  assert(hexSides.every((s) => near(s, hexSides[0], 0.5)), "정육각형 모든 변 같은 길이");
  assert(near(hexSides[0] / GRID, 3, 0.02), `정육각형 변 길이 ≈ 3cm (got ${(hexSides[0] / GRID).toFixed(2)})`);

  const L = makeLShape(0, 0, 6 * GRID, 4 * GRID, 2 * GRID, 2 * GRID);
  assert(L.length === 6, "ㄴ자 꼭짓점 6개");
  const lArea = polygonArea(L) / (GRID * GRID);
  // 6×4 - 2×2 = 24 - 4 = 20
  assert(near(lArea, 20), `ㄴ자 넓이 = 20cm² (got ${lArea})`);
  const lPeri = polygonPerimeter(L) / GRID;
  // 외곽: 6+4+2+2+4+2 = 20
  assert(near(lPeri, 20), `ㄴ자 둘레 = 20cm (got ${lPeri})`);

  const X = makeCross(0, 0, 2 * GRID, 2 * GRID);
  assert(X.length === 12, "십자 꼭짓점 12개");
  const xArea = polygonArea(X) / (GRID * GRID);
  // 6×2 (가로) + 6×2 (세로) - 2×2 (중복) = 20
  assert(near(xArea, 20), `십자 넓이 = 20cm² (got ${xArea})`);
  const xPeri = polygonPerimeter(X) / GRID;
  // 모든 변 2cm × 12개 = 24cm
  assert(near(xPeri, 24), `십자 둘레 = 24cm (got ${xPeri})`);
});

group("detectShapeKind", () => {
  const sq = makeRectangle(0, 0, 4 * GRID, 4 * GRID);
  assert(detectShapeKind(sq).name === "정사각형", "정사각형 인식");
  const rect = makeRectangle(0, 0, 6 * GRID, 4 * GRID);
  assert(detectShapeKind(rect).name === "직사각형", "직사각형 인식");
  const rtri = makeRightTriangle(0, 0, 6 * GRID, 4 * GRID);
  assert(detectShapeKind(rtri).name === "직각삼각형", "직각삼각형 인식");
  const tri = makeTriangle(0, 0, 6 * GRID, 4 * GRID);
  assert(detectShapeKind(tri).name === "삼각형", `삼각형 인식 (got ${detectShapeKind(tri).name})`);
  const para = makeParallelogram(0, 0, 6 * GRID, 4 * GRID, 2 * GRID);
  assert(detectShapeKind(para).name === "평행사변형", `평행사변형 인식 (got ${detectShapeKind(para).name})`);
  const trap = makeTrapezoid(0, 0, 2 * GRID, 6 * GRID, 4 * GRID);
  assert(detectShapeKind(trap).name === "사다리꼴", `사다리꼴 인식 (got ${detectShapeKind(trap).name})`);
  const rhom = makeRhombus(0, 0, 6 * GRID, 4 * GRID);
  assert(detectShapeKind(rhom).name === "마름모", `마름모 인식 (got ${detectShapeKind(rhom).name})`);
  const hex = makeHexagon(0, 0, 3 * GRID);
  assert(detectShapeKind(hex).name === "육각형", "육각형 인식");
  const Lsh = makeLShape(0, 0, 6 * GRID, 4 * GRID, 2 * GRID, 2 * GRID);
  assert(detectShapeKind(Lsh).name === "육각형", `ㄴ자(6각형) 인식 (got ${detectShapeKind(Lsh).name})`);
});

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
if (fail > 0) process.exit(1);
