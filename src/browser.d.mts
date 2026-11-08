import type { PlannerRequests } from "./index.mjs";
export class PlannerClient implements PlannerRequests {
  constructor(worker: Worker);
  request: PlannerRequests["request"];
  close(): void;
}
export function createPlannerWorker(): Worker;
export const WALK_SPEED: number;
export function walkingRing(
  origin: { lon: number; lat: number },
  meters: number,
): [number, number][];
export function sampleIsoSurface(
  points: { lon: number; lat: number; durationSeconds: number }[],
  origin: { lon: number; lat: number },
  maxDurationSeconds: number,
  maxWalkMeters: number,
): {
  values: Float64Array;
  cols: number;
  rows: number;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
};
