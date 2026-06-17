export type Point = { x: number; y: number };

export type Shape = {
  id: string;
  points: Point[]; // 닫힌 다각형 (마지막 점이 첫 점과 자동 연결)
  color: string;
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

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
