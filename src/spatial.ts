import type { Vec2 } from './types.js';

export interface SpatialCircle {
  pos: Vec2;
  radius: number;
}

export class SpatialHash<T extends SpatialCircle> {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, T[]>();

  constructor(cellSize: number) {
    this.cellSize = Math.max(16, cellSize);
  }

  clear(): void {
    this.buckets.clear();
  }

  rebuild(items: readonly T[], include: (item: T) => boolean = () => true): void {
    this.clear();
    for (const item of items) {
      if (!include(item)) continue;
      this.insert(item);
    }
  }

  insert(item: T): void {
    const minX = this.cell(item.pos.x - item.radius);
    const maxX = this.cell(item.pos.x + item.radius);
    const minY = this.cell(item.pos.y - item.radius);
    const maxY = this.cell(item.pos.y + item.radius);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const key = `${cx},${cy}`;
        let bucket = this.buckets.get(key);
        if (!bucket) {
          bucket = [];
          this.buckets.set(key, bucket);
        }
        bucket.push(item);
      }
    }
  }

  queryCircle(pos: Vec2, radius: number): T[] {
    const out: T[] = [];
    const seen = new Set<T>();
    const minX = this.cell(pos.x - radius);
    const maxX = this.cell(pos.x + radius);
    const minY = this.cell(pos.y - radius);
    const maxY = this.cell(pos.y + radius);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.buckets.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const item of bucket) {
          if (seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  }

  private cell(v: number): number {
    return Math.floor(v / this.cellSize);
  }
}
