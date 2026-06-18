export type Point = { x: number; y: number };

export type Shape = {
  id: string;
  points: Point[]; // 닫힌 다각형 (마지막 점이 첫 점과 자동 연결)
  color: string;
  ghosts?: Point[][]; // 합치기 전 원본 도형들의 외곽선 (희미하게 표시)
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

// 두 선분의 교점 (있을 때만 반환) — 무한직선 a~b 와 선분 c~d
function lineSegIntersect(
  a: Point,
  b: Point,
  c: Point,
  d: Point
): { p: Point; t: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  return {
    p: { x: c.x + u * s.x, y: c.y + u * s.y },
    t,
  };
}

/**
 * 무한 직선 lineA~lineB 로 볼록/오목 단순 다각형을 두 조각으로 자른다.
 * 단순한 다각형(자기교차 없음) 가정. 직선이 다각형과 정확히 2개의 변에서 교차할 때 동작.
 */
export function splitPolygonByLine(
  points: Point[],
  lineA: Point,
  lineB: Point
): Point[][] | null {
  const n = points.length;
  if (n < 3) return null;

  // 직선 방향에 대한 부호 함수
  const dirX = lineB.x - lineA.x;
  const dirY = lineB.y - lineA.y;
  const side = (p: Point) => (p.x - lineA.x) * dirY - (p.y - lineA.y) * dirX;

  // 교차점 위치 저장
  type Crossing = { edgeIndex: number; p: Point; t: number };
  const crossings: Crossing[] = [];

  // 결과 두 폴리곤
  const polyPos: Point[] = [];
  const polyNeg: Point[] = [];

  for (let i = 0; i < n; i++) {
    const cur = points[i];
    const nxt = points[(i + 1) % n];
    const sCur = side(cur);
    const sNxt = side(nxt);

    if (sCur >= 0) polyPos.push(cur);
    if (sCur <= 0) polyNeg.push(cur);

    // 부호가 다르면 교차점 계산
    if ((sCur > 0 && sNxt < 0) || (sCur < 0 && sNxt > 0)) {
      const hit = lineSegIntersect(lineA, lineB, cur, nxt);
      if (hit) {
        crossings.push({ edgeIndex: i, p: hit.p, t: hit.t });
        polyPos.push(hit.p);
        polyNeg.push(hit.p);
      }
    }
  }

  if (crossings.length !== 2) return null;
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
  return [
    { x: cx - base / 2, y: cy + h / 2 },
    { x: cx + base / 2, y: cy + h / 2 },
    { x: cx + base * 0.1, y: cy - h / 2 },
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
