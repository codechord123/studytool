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
