// 가벼운 3D 수학 — 의존성 없이 Canvas 2D로 다면체를 그리기 위한 최소 도구
export type V3 = { x: number; y: number; z: number };

export const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scaleV = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

// 카메라 회전 (yaw=Y축, pitch=X축)
export function rotate(p: V3, yaw: number, pitch: number): V3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const y1 = p.y * cx - z1 * sx;
  const z2 = p.y * sx + z1 * cx;
  return { x: x1, y: y1, z: z2 };
}

// 임의 축(axisDir, 단위벡터 아님 허용) 둘레로 점 회전 (Rodrigues) — 전개도 접기용
export function rotateAboutAxis(p: V3, axisPoint: V3, axisDir: V3, angle: number): V3 {
  const k = norm(axisDir);
  const r = sub(p, axisPoint);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // r*cos + (k×r)*sin + k*(k·r)*(1-cos)
  const kxr = cross(k, r);
  const kdr = dot(k, r);
  const rot = {
    x: r.x * c + kxr.x * s + k.x * kdr * (1 - c),
    y: r.y * c + kxr.y * s + k.y * kdr * (1 - c),
    z: r.z * c + kxr.z * s + k.z * kdr * (1 - c),
  };
  return add(axisPoint, rot);
}

export type Face = { pts: V3[]; color: string; label?: string };

// ===== 일반 입체(각기둥·각뿔) =====
export type SolidKind = "box" | "prism" | "pyramid";
export type SolidSpec = { kind: SolidKind; n: number; a: number; b: number; c: number; R: number; h: number };

export type SolidData = {
  faces: Face[];
  edges: [V3, V3][];
  corners: V3[];
  counts: { faces: number; edges: number; verts: number };
  surface: number;
  volume: number;
  surfaceText: string;
  volumeText: string;
  name: string;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

// ===== 정육면체 전개도 판별 (주사위 굴리기 BFS) =====
// 6칸 폴리오미노가 정육면체로 접히는지: 종이 위 칸을 따라 큐브를 굴려 각 칸이 닿는
// 면이 6개 모두 다르면 정육면체 전개도.
type Cube = { U: number; D: number; N: number; S: number; E: number; W: number };
function rollE(c: Cube): Cube {
  return { U: c.E, D: c.W, E: c.D, W: c.U, N: c.N, S: c.S };
}
function rollW(c: Cube): Cube {
  return { U: c.W, D: c.E, W: c.D, E: c.U, N: c.N, S: c.S };
}
function rollS(c: Cube): Cube {
  return { D: c.N, U: c.S, N: c.U, S: c.D, E: c.E, W: c.W };
}
function rollN(c: Cube): Cube {
  return { D: c.S, U: c.N, S: c.U, N: c.D, E: c.E, W: c.W };
}

export function foldsToCube(cells: [number, number][]): boolean {
  if (cells.length !== 6) return false;
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Map(cells.map(([x, y]) => [key(x, y), true]));
  // 연결성 확인
  const seen = new Set<string>();
  const start = cells[0];
  const stack = [start];
  seen.add(key(start[0], start[1]));
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = key(x + dx, y + dy);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push([x + dx, y + dy]);
      }
    }
  }
  if (seen.size !== 6) return false;
  // 굴리기 BFS: 각 칸의 큐브 방향 상태를 기록, 닿는 면(D) 수집
  const faceOf = new Map<string, number>();
  const init: Cube = { U: 0, D: 1, N: 2, S: 3, E: 4, W: 5 };
  const q: { x: number; y: number; cube: Cube }[] = [{ x: start[0], y: start[1], cube: init }];
  const visited = new Set<string>([key(start[0], start[1])]);
  faceOf.set(key(start[0], start[1]), init.D);
  while (q.length) {
    const { x, y, cube } = q.shift()!;
    const moves: [number, number, (c: Cube) => Cube][] = [
      [1, 0, rollE],
      [-1, 0, rollW],
      [0, 1, rollS],
      [0, -1, rollN],
    ];
    for (const [dx, dy, roll] of moves) {
      const k = key(x + dx, y + dy);
      if (!set.has(k) || visited.has(k)) continue;
      visited.add(k);
      const nc = roll(cube);
      faceOf.set(k, nc.D);
      q.push({ x: x + dx, y: y + dy, cube: nc });
    }
  }
  const faces = new Set(faceOf.values());
  return faces.size === 6;
}

// XZ평면 정n각형 (반지름 R, 높이 yy)
function nGon(n: number, R: number, yy: number): V3[] {
  const pts: V3[] = [];
  const off = -Math.PI / 2 + (n % 2 === 0 ? Math.PI / n : 0);
  for (let i = 0; i < n; i++) {
    const a = off + (i * 2 * Math.PI) / n;
    pts.push(v(R * Math.cos(a), yy, R * Math.sin(a)));
  }
  return pts;
}

export function buildSolid(spec: SolidSpec, color: string): SolidData {
  if (spec.kind === "box") {
    const { a, b, c } = spec;
    const surface = 2 * (a * b + b * c + c * a);
    const volume = a * b * c;
    const isCube = a === b && b === c;
    return {
      faces: cuboidFaces(a, b, c, color),
      edges: cuboidEdges(a, b, c),
      corners: cuboidCorners(a, b, c),
      counts: { faces: 6, edges: 12, verts: 8 },
      surface,
      volume,
      surfaceText: `${surface}cm²`,
      volumeText: `${volume}cm³`,
      name: isCube ? "정육면체" : "직육면체",
    };
  }
  const { n, R, h } = spec;
  const baseArea = 0.5 * n * R * R * Math.sin((2 * Math.PI) / n);
  const side = 2 * R * Math.sin(Math.PI / n);
  const apothem = R * Math.cos(Math.PI / n);
  const NAMES: Record<number, string> = { 3: "삼각", 4: "사각", 5: "오각", 6: "육각" };
  if (spec.kind === "prism") {
    const bot = nGon(n, R, -h / 2);
    const top = nGon(n, R, h / 2);
    const faces: Face[] = [];
    faces.push({ pts: [...bot].reverse(), color, label: "아래" });
    faces.push({ pts: top, color, label: "위" });
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push({ pts: [bot[i], bot[j], top[j], top[i]], color, label: i === 0 ? "옆면" : undefined });
    }
    const edges: [V3, V3][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      edges.push([bot[i], bot[j]], [top[i], top[j]], [bot[i], top[i]]);
    }
    const surface = 2 * baseArea + n * side * h;
    const volume = baseArea * h;
    return {
      faces,
      edges,
      corners: [...bot, ...top],
      counts: { faces: n + 2, edges: 3 * n, verts: 2 * n },
      surface: round1(surface),
      volume: round1(volume),
      surfaceText: `${round1(surface)}cm²`,
      volumeText: `${round1(volume)}cm³`,
      name: `${NAMES[n] ?? n}기둥`,
    };
  }
  // pyramid
  const base = nGon(n, R, -h / 2);
  const apex = v(0, h / 2, 0);
  const faces: Face[] = [];
  faces.push({ pts: [...base].reverse(), color, label: "밑면" });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push({ pts: [base[i], base[j], apex], color, label: i === 0 ? "옆면" : undefined });
  }
  const edges: [V3, V3][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push([base[i], base[j]], [base[i], apex]);
  }
  const slant = Math.sqrt(apothem * apothem + h * h);
  const surface = baseArea + 0.5 * n * side * slant;
  const volume = (baseArea * h) / 3;
  return {
    faces,
    edges,
    corners: [...base, apex],
    counts: { faces: n + 1, edges: 2 * n, verts: n + 1 },
    surface: round1(surface),
    volume: round1(volume),
    surfaceText: `${round1(surface)}cm²`,
    volumeText: `${round1(volume)}cm³`,
    name: `${NAMES[n] ?? n}뿔`,
  };
}

// 수평면(y=yc)으로 자른 단면 다각형 (입체의 면들과 모서리 교차 → 고리 정렬)
export function sectionAtY(faces: Face[], yc: number): V3[] {
  const segs: [V3, V3][] = [];
  for (const f of faces) {
    const pts = f.pts;
    const xs: V3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = a.y - yc;
      const db = b.y - yc;
      if ((da <= 0 && db > 0) || (da > 0 && db <= 0)) {
        const t = da / (da - db);
        xs.push(v(a.x + (b.x - a.x) * t, yc, a.z + (b.z - a.z) * t));
      }
    }
    if (xs.length === 2) segs.push([xs[0], xs[1]]);
  }
  if (segs.length < 3) return [];
  const near = (p: V3, q: V3) => Math.hypot(p.x - q.x, p.z - q.z) < 1e-4;
  const poly: V3[] = [segs[0][0], segs[0][1]];
  const used = new Array(segs.length).fill(false);
  used[0] = true;
  let guard = 0;
  while (guard++ < segs.length * 2 + 2) {
    const tail = poly[poly.length - 1];
    let found = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      if (near(segs[i][0], tail)) {
        poly.push(segs[i][1]);
        used[i] = true;
        found = true;
        break;
      }
      if (near(segs[i][1], tail)) {
        poly.push(segs[i][0]);
        used[i] = true;
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  if (poly.length > 1 && near(poly[0], poly[poly.length - 1])) poly.pop();
  return poly;
}

// XZ평면 다각형 넓이(신발끈) — 단면 넓이용
export function areaXZ(poly: V3[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

// 각기둥/각뿔의 평면 전개도(펼친 모양) — z=0 평면
export function prismNetFaces(n: number, R: number, h: number, color: string): Face[] {
  const side = 2 * R * Math.sin(Math.PI / n);
  const faces: Face[] = [];
  // 옆면: 가로로 이어진 n개의 직사각형 (각 side × h), 중앙 정렬
  const totalW = n * side;
  const x0 = -totalW / 2;
  for (let i = 0; i < n; i++) {
    const xl = x0 + i * side;
    const xr = xl + side;
    faces.push({
      pts: [v(xl, -h / 2, 0), v(xr, -h / 2, 0), v(xr, h / 2, 0), v(xl, h / 2, 0)],
      color,
      label: i === 0 ? "옆면" : undefined,
    });
  }
  // 위·아래 밑면: 가운데 직사각형 위/아래에 정n각형 부착
  const midL = x0 + Math.floor(n / 2) * side + side / 2;
  const topPoly = nGon(n, R, 0).map((p) => v(p.x + midL, p.z + (h / 2 + R), 0));
  const botPoly = nGon(n, R, 0).map((p) => v(p.x + midL, -(p.z + (h / 2 + R)), 0));
  faces.push({ pts: topPoly, color, label: "위" });
  faces.push({ pts: botPoly, color, label: "아래" });
  return faces;
}

export function pyramidNetFaces(n: number, R: number, h: number, color: string): Face[] {
  const apothem = R * Math.cos(Math.PI / n);
  const slant = Math.sqrt(apothem * apothem + h * h);
  const base = nGon(n, R, 0).map((p) => v(p.x, p.z, 0)); // XY평면으로
  const faces: Face[] = [];
  faces.push({ pts: base, color, label: "밑면" });
  // 각 밑변 바깥으로 이등변삼각형(밑변 side, 높이 slant)
  for (let i = 0; i < n; i++) {
    const A = base[i];
    const B = base[(i + 1) % n];
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    // 바깥 방향 = 중심(0,0)에서 mid로
    const dl = Math.hypot(mid.x, mid.y) || 1;
    const out = { x: mid.x / dl, y: mid.y / dl };
    const apexP = v(mid.x + out.x * slant, mid.y + out.y * slant, 0);
    faces.push({ pts: [A, B, apexP], color, label: i === 0 ? "옆면" : undefined });
  }
  return faces;
}

// 직육면체 (가로 a, 세로 b, 높이 c · 칸 단위), 원점 중심
export function cuboidFaces(a: number, b: number, c: number, color: string): Face[] {
  const hx = a / 2;
  const hy = b / 2;
  const hz = c / 2;
  const P = (sx: number, sy: number, sz: number) => v(sx * hx, sy * hy, sz * hz);
  // 각 면: 바깥에서 봤을 때 반시계
  return [
    { pts: [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], color, label: "앞" }, // +z
    { pts: [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], color, label: "뒤" }, // -z
    { pts: [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)], color, label: "오른쪽" }, // +x
    { pts: [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)], color, label: "왼쪽" }, // -x
    { pts: [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)], color, label: "위" }, // +y
    { pts: [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], color, label: "아래" }, // -y
  ];
}

// 직육면체 12 모서리 (꼭짓점 쌍)
export function cuboidEdges(a: number, b: number, c: number): [V3, V3][] {
  const hx = a / 2;
  const hy = b / 2;
  const hz = c / 2;
  const c8 = [
    v(-hx, -hy, -hz), v(hx, -hy, -hz), v(hx, hy, -hz), v(-hx, hy, -hz),
    v(-hx, -hy, hz), v(hx, -hy, hz), v(hx, hy, hz), v(-hx, hy, hz),
  ];
  const E: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return E.map(([i, j]) => [c8[i], c8[j]] as [V3, V3]);
}

export function cuboidCorners(a: number, b: number, c: number): V3[] {
  const hx = a / 2;
  const hy = b / 2;
  const hz = c / 2;
  return [
    v(-hx, -hy, -hz), v(hx, -hy, -hz), v(hx, hy, -hz), v(-hx, hy, -hz),
    v(-hx, -hy, hz), v(hx, -hy, hz), v(hx, hy, hz), v(-hx, hy, hz),
  ];
}

// 직육면체 전개도(십자형) 접기 — t: 0=완전히 펼침, 1=완전히 접힘(상자)
// 바닥(아래)면을 기준으로 4개 옆면이 세워지고, '위'면은 뒤 옆면에 붙어 두 번 접힘.
export function cuboidNetFaces(a: number, b: number, c: number, t: number, color: string): Face[] {
  const hx = a / 2;
  const hy = b / 2;
  const ang = (t * Math.PI) / 2; // 0..90°
  // 바닥면: z=0 평면, 중심 원점 (가로 a × 세로 b)
  const quad = (corners: V3[]): V3[] => corners;
  const bottom: V3[] = [v(-hx, -hy, 0), v(hx, -hy, 0), v(hx, hy, 0), v(-hx, hy, 0)];

  // 펼친 상태에서 각 옆면은 바닥 모서리 바깥으로 평평하게 누워있음 (z=0)
  // 접으면 해당 모서리(축) 둘레로 위(+z)로 ang 만큼 회전
  // 앞(front): y=-hy 모서리, 축 X(+x), 바깥(-y)으로 c 만큼
  const frontFlat: V3[] = [v(-hx, -hy, 0), v(hx, -hy, 0), v(hx, -hy - c, 0), v(-hx, -hy - c, 0)];
  const front = frontFlat.map((p) => rotateAboutAxis(p, v(0, -hy, 0), v(1, 0, 0), -ang));
  // 뒤(back): y=+hy 모서리, 축 X
  const backFlat: V3[] = [v(hx, hy, 0), v(-hx, hy, 0), v(-hx, hy + c, 0), v(hx, hy + c, 0)];
  const back = backFlat.map((p) => rotateAboutAxis(p, v(0, hy, 0), v(1, 0, 0), ang));
  // 왼쪽(left): x=-hx 모서리, 축 Y
  const leftFlat: V3[] = [v(-hx, hy, 0), v(-hx, -hy, 0), v(-hx - c, -hy, 0), v(-hx - c, hy, 0)];
  const left = leftFlat.map((p) => rotateAboutAxis(p, v(-hx, 0, 0), v(0, 1, 0), ang));
  // 오른쪽(right): x=+hx 모서리, 축 Y
  const rightFlat: V3[] = [v(hx, -hy, 0), v(hx, hy, 0), v(hx + c, hy, 0), v(hx + c, -hy, 0)];
  const right = rightFlat.map((p) => rotateAboutAxis(p, v(hx, 0, 0), v(0, 1, 0), -ang));

  // 위(top): 뒤 옆면 끝(y=hy+c)에 붙어 펼쳐짐. 두 번 접힘:
  //  1) 뒤 옆면 끝 모서리(y=hy+c) 둘레로 ang 만큼 (뒤 옆면 로컬에서 안쪽으로)
  //  2) 뒤 옆면이 세워지는 회전(바닥 뒤 모서리 둘레 ang)을 함께 적용
  const topFlat: V3[] = [v(hx, hy + c, 0), v(-hx, hy + c, 0), v(-hx, hy + c + b, 0), v(hx, hy + c + b, 0)];
  let top = topFlat.map((p) => rotateAboutAxis(p, v(0, hy + c, 0), v(1, 0, 0), ang));
  top = top.map((p) => rotateAboutAxis(p, v(0, hy, 0), v(1, 0, 0), ang));

  return [
    { pts: quad(bottom), color, label: "아래" },
    { pts: front, color, label: "앞" },
    { pts: back, color, label: "뒤" },
    { pts: left, color, label: "왼쪽" },
    { pts: right, color, label: "오른쪽" },
    { pts: top, color, label: "위" },
  ];
}
