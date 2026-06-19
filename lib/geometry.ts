export type Point = { x: number; y: number };

export type Shape = {
  id: string;
  points: Point[]; // 닫힌 다각형 (마지막 점이 첫 점과 자동 연결)
  color: string;
  ghosts?: Point[][]; // 합치기 전 원본 도형들의 외곽선 (희미하게 표시)
  edgeLabels?: string[]; // 변 i의 의미 라벨 (예: "윗변", "밑변") — 학습 모드용
  isReference?: boolean; // 원본 박제(읽기 전용, 점선 표시)
};

export function polygonArea(points: Point[]): number {
  // 신발끈 공식
  let s = 0;
  const n = points.length;
  if (n < 3) return 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(points: Point[]): number {
  let s = 0;
  const n = points.length;
  if (n < 2) return 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

export function polygonCentroid(points: Point[]): Point {
  // 무게중심 (면적 가중)
  let cx = 0,
    cy = 0,
    a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
    a += f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const avg = points.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
      { x: 0, y: 0 }
    );
    return { x: avg.x / n, y: avg.y / n };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function rotatePoints(points: Point[], origin: Point, angleRad: number): Point[] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return points.map((p) => ({
    x: origin.x + (p.x - origin.x) * c - (p.y - origin.y) * s,
    y: origin.y + (p.x - origin.x) * s + (p.y - origin.y) * c,
  }));
}

export function translatePoints(points: Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * 무한 직선 lineA~lineB 로 단순 다각형을 두 조각으로 자른다.
 * 꼭짓점이 정확히 선 위에 있는 경우(모서리 자르기)도 정확히 처리한다.
 */
export function splitPolygonByLine(
  points: Point[],
  lineA: Point,
  lineB: Point
): Point[][] | null {
  const n = points.length;
  if (n < 3) return null;

  const dirX = lineB.x - lineA.x;
  const dirY = lineB.y - lineA.y;
  if (Math.hypot(dirX, dirY) < 1e-6) return null;
  const side = (p: Point) => (p.x - lineA.x) * dirY - (p.y - lineA.y) * dirX;
  const EPS = 0.5; // 픽셀 단위 — 0.5px 이내면 “선 위”로 간주

  const sides: number[] = points.map(side);
  const polyPos: Point[] = [];
  const polyNeg: Point[] = [];
  let crossings = 0;

  for (let i = 0; i < n; i++) {
    const cur = points[i];
    const nxt = points[(i + 1) % n];
    const sCur = sides[i];
    const sNxt = sides[(i + 1) % n];

    if (sCur > EPS) {
      polyPos.push(cur);
    } else if (sCur < -EPS) {
      polyNeg.push(cur);
    } else {
      // 꼭짓점이 선 위에 있음 — 두 다각형 모두에 포함
      polyPos.push(cur);
      polyNeg.push(cur);
      // 이웃 꼭짓점들이 반대쪽이면 교차로 카운트
      const sPrev = sides[(i - 1 + n) % n];
      const prevPos = sPrev > EPS;
      const prevNeg = sPrev < -EPS;
      const nxtPos = sNxt > EPS;
      const nxtNeg = sNxt < -EPS;
      if ((prevPos && nxtNeg) || (prevNeg && nxtPos)) crossings++;
    }

    // 변(cur→nxt)이 선을 엄격히 가로지르면 교차점 계산
    if ((sCur > EPS && sNxt < -EPS) || (sCur < -EPS && sNxt > EPS)) {
      const r = { x: dirX, y: dirY };
      const s = { x: nxt.x - cur.x, y: nxt.y - cur.y };
      const denom = r.x * s.y - r.y * s.x;
      if (Math.abs(denom) > 1e-9) {
        const u = ((cur.x - lineA.x) * r.y - (cur.y - lineA.y) * r.x) / denom;
        const cu = Math.max(0, Math.min(1, u));
        const p = { x: cur.x + cu * s.x, y: cur.y + cu * s.y };
        polyPos.push(p);
        polyNeg.push(p);
        crossings++;
      }
    }
  }

  if (crossings !== 2) return null;
  if (polyPos.length < 3 || polyNeg.length < 3) return null;
  return [polyPos, polyNeg];
}

export function scalePoints(
  points: Point[],
  origin: Point,
  sx: number,
  sy: number
): Point[] {
  return points.map((p) => ({
    x: origin.x + (p.x - origin.x) * sx,
    y: origin.y + (p.y - origin.y) * sy,
  }));
}

export function flipPoints(
  points: Point[],
  origin: Point,
  axis: "horizontal" | "vertical"
): Point[] {
  // horizontal = 좌우 뒤집기 (수직축 기준 미러)
  return axis === "horizontal"
    ? scalePoints(points, origin, -1, 1)
    : scalePoints(points, origin, 1, -1);
}

export function cloneShapes(shapes: Shape[]): Shape[] {
  return shapes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
}

// ----- 프리셋 도형 (좌표는 픽셀 단위, 호출 측에서 GRID 곱해서 전달) -----
export function makeRectangle(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

export function makeRightTriangle(
  cx: number,
  cy: number,
  base: number,
  h: number
): Point[] {
  return [
    { x: cx - base / 2, y: cy + h / 2 },
    { x: cx + base / 2, y: cy + h / 2 },
    { x: cx - base / 2, y: cy - h / 2 },
  ];
}

export function makeTriangle(
  cx: number,
  cy: number,
  base: number,
  h: number
): Point[] {
  // 일반(부등변) 삼각형 — apex 를 base/6 만큼 중심 왼쪽으로
  // base=6cm 일 때 apex 가 정확히 -1cm (정수) 에 떨어지도록
  return [
    { x: cx - base / 2, y: cy + h / 2 },
    { x: cx + base / 2, y: cy + h / 2 },
    { x: cx - base / 6, y: cy - h / 2 },
  ];
}

export function makeTrapezoid(
  cx: number,
  cy: number,
  topW: number,
  bottomW: number,
  h: number
): Point[] {
  return [
    { x: cx - topW / 2, y: cy - h / 2 },
    { x: cx + topW / 2, y: cy - h / 2 },
    { x: cx + bottomW / 2, y: cy + h / 2 },
    { x: cx - bottomW / 2, y: cy + h / 2 },
  ];
}

export function makeParallelogram(
  cx: number,
  cy: number,
  base: number,
  h: number,
  skew: number
): Point[] {
  return [
    { x: cx - base / 2 + skew / 2, y: cy - h / 2 },
    { x: cx + base / 2 + skew / 2, y: cy - h / 2 },
    { x: cx + base / 2 - skew / 2, y: cy + h / 2 },
    { x: cx - base / 2 - skew / 2, y: cy + h / 2 },
  ];
}

export function makeRhombus(
  cx: number,
  cy: number,
  d1: number,
  d2: number
): Point[] {
  // d1 = 가로 대각선, d2 = 세로 대각선
  return [
    { x: cx, y: cy - d2 / 2 },
    { x: cx + d1 / 2, y: cy },
    { x: cx, y: cy + d2 / 2 },
    { x: cx - d1 / 2, y: cy },
  ];
}

// 정육각형 — 꼭짓점 거리 r, 각 변 길이 r
export function makeHexagon(cx: number, cy: number, r: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

// ㄴ 자 형태 — 6 꼭짓점 (오목 다각형), 모든 변 정수 cm
export function makeLShape(
  cx: number,
  cy: number,
  w: number,
  h: number,
  cutW: number,
  cutH: number
): Point[] {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  return [
    { x: x0, y: y0 },
    { x: x0 + (w - cutW), y: y0 },
    { x: x0 + (w - cutW), y: y0 + (h - cutH) },
    { x: x0 + w, y: y0 + (h - cutH) },
    { x: x0 + w, y: y0 + h },
    { x: x0, y: y0 + h },
  ];
}

// 십자 (+) — 12 꼭짓점
export function makeCross(
  cx: number,
  cy: number,
  armW: number,
  armLen: number
): Point[] {
  const a = armW / 2;
  const b = armW / 2 + armLen;
  return [
    { x: cx - a, y: cy - b },
    { x: cx + a, y: cy - b },
    { x: cx + a, y: cy - a },
    { x: cx + b, y: cy - a },
    { x: cx + b, y: cy + a },
    { x: cx + a, y: cy + a },
    { x: cx + a, y: cy + b },
    { x: cx - a, y: cy + b },
    { x: cx - a, y: cy + a },
    { x: cx - b, y: cy + a },
    { x: cx - b, y: cy - a },
    { x: cx - a, y: cy - a },
  ];
}

// ----- 도형 합치기 (인접 변 공유 시) -----
export function signedArea(points: Point[]): number {
  let s = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function ensureCW(points: Point[]): Point[] {
  // 캔버스 좌표계 (y가 아래로 증가) 기준 시계방향이 되도록
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

export function simplifyCollinear(points: Point[], tol = 0.6): Point[] {
  const n = points.length;
  if (n < 4) return points;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const cross =
      (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > tol) out.push(cur);
  }
  return out.length >= 3 ? out : points;
}

/**
 * 두 다각형이 한 변을 공유할 때 하나로 합친다.
 * 공유 변이 없으면 null.
 */
export function mergePolygons(A: Point[], B: Point[], tol = 6): Point[] | null {
  const a = ensureCW(A);
  const b = ensureCW(B);
  const nA = a.length;
  const nB = b.length;
  const eq = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) < tol;

  for (let i = 0; i < nA; i++) {
    const i2 = (i + 1) % nA;
    for (let j = 0; j < nB; j++) {
      const j2 = (j + 1) % nB;
      // A의 변 i→i2 와 B의 변 j2→j 가 같은 선분이어야 (반대 방향)
      if (eq(a[i], b[j2]) && eq(a[i2], b[j])) {
        const out: Point[] = [];
        // A를 i2부터 i까지 순회
        let k = i2;
        while (true) {
          out.push(a[k]);
          if (k === i) break;
          k = (k + 1) % nA;
        }
        // B를 j2+1부터 j 직전까지 순회
        k = (j2 + 1) % nB;
        while (k !== j) {
          out.push(b[k]);
          k = (k + 1) % nB;
        }
        return simplifyCollinear(out);
      }
    }
  }
  return null;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 도형 종류와 공식 자동 인식 (5학년 수준 휴리스틱)
export type ShapeKind = { name: string; formula: string };

export function detectShapeKind(points: Point[]): ShapeKind {
  const n = points.length;
  if (n < 3) return { name: "선", formula: "" };

  const sides: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sides.push(Math.hypot(b.x - a.x, b.y - a.y));
  }

  const angleDot = (i: number): number => {
    const a = points[(i - 1 + n) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    const v1x = a.x - b.x,
      v1y = a.y - b.y;
    const v2x = c.x - b.x,
      v2y = c.y - b.y;
    const L1 = Math.hypot(v1x, v1y) || 1;
    const L2 = Math.hypot(v2x, v2y) || 1;
    return (v1x * v2x + v1y * v2y) / (L1 * L2); // 정규화된 내적
  };
  const isRight = (i: number) => Math.abs(angleDot(i)) < 0.05;
  const allRight = () => {
    for (let i = 0; i < n; i++) if (!isRight(i)) return false;
    return true;
  };
  const sideEq = (a: number, b: number) => Math.abs(a - b) < Math.max(2, a * 0.04);
  const allSidesEq = sides.every((s) => sideEq(s, sides[0]));
  const oppSidesEq = n === 4 && sideEq(sides[0], sides[2]) && sideEq(sides[1], sides[3]);
  const parallel = (i1: number, i2: number, j1: number, j2: number) => {
    const ax = points[i2].x - points[i1].x;
    const ay = points[i2].y - points[i1].y;
    const bx = points[j2].x - points[j1].x;
    const by = points[j2].y - points[j1].y;
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    return Math.abs(cross / (la * lb)) < 0.03;
  };

  if (n === 3) {
    if (isRight(0) || isRight(1) || isRight(2))
      return { name: "직각삼각형", formula: "밑변 × 높이 ÷ 2" };
    return { name: "삼각형", formula: "밑변 × 높이 ÷ 2" };
  }
  if (n === 4) {
    const p01_23 = parallel(0, 1, 3, 2);
    const p12_30 = parallel(1, 2, 0, 3);
    if (allSidesEq && allRight()) return { name: "정사각형", formula: "한 변 × 한 변" };
    if (oppSidesEq && allRight()) return { name: "직사각형", formula: "가로 × 세로" };
    if (allSidesEq && p01_23 && p12_30)
      return { name: "마름모", formula: "한 대각선 × 다른 대각선 ÷ 2" };
    if (oppSidesEq && p01_23 && p12_30)
      return { name: "평행사변형", formula: "밑변 × 높이" };
    if (p01_23 || p12_30)
      return { name: "사다리꼴", formula: "(윗변 + 아랫변) × 높이 ÷ 2" };
    return { name: "사각형", formula: "여러 도형으로 나누어 더하기" };
  }
  if (n === 5) return { name: "오각형", formula: "여러 도형으로 나누어 더하기" };
  if (n === 6) return { name: "육각형", formula: "여러 도형으로 나누어 더하기" };
  if (n === 7) return { name: "칠각형", formula: "여러 도형으로 나누어 더하기" };
  if (n === 8) return { name: "팔각형", formula: "여러 도형으로 나누어 더하기" };
  return { name: `${n}각형`, formula: "여러 도형으로 나누어 더하기" };
}
