export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersectsRect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
