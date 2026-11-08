import type { IrailApi, PlannerRequests } from "./index.mjs";
export class PlannerClient implements PlannerRequests, IrailApi {
  constructor(worker: Worker);
  request: PlannerRequests["request"];
  stations: IrailApi["stations"];
  liveboard: IrailApi["liveboard"];
  connections: IrailApi["connections"];
  vehicle: IrailApi["vehicle"];
  composition: IrailApi["composition"];
  disturbances: IrailApi["disturbances"];
  occupancyFeedback: IrailApi["occupancyFeedback"];
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
