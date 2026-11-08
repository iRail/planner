export type StopRef = { sourceId: string; stopIdx: number };
export type Point = { lon: number; lat: number };
export type Endpoint = StopRef | Point;
export interface Source {
  id: string;
  name: string;
  color: string;
  manifest: {
    counts: {
      stops: number;
      trips: number;
      routes: number;
      transfers?: number;
    };
    schemaVersion: "2-alpha";
    releaseId: string;
    timeZone: string;
    coverageStart?: string;
    coverageEnd?: string;
  };
  stops: {
    id: string[];
    name: (string | null)[];
    lat: Float64Array;
    lon: Float64Array;
  };
  stopFamily: { searchable: number[] };
}
export interface PlannerOptions {
  dataUrl?: string;
  cacheBytes?: number;
  fetch?: typeof globalThis.fetch;
}
export interface JourneyQuery {
  origin: Endpoint;
  destination: Endpoint;
  /** UTC epoch seconds. */
  departureAfter: number;
  maxWalkMeters?: number;
  sourceIds?: string[];
  windowMode?: "adaptive" | "full";
}
export interface IsochroneQuery {
  origin: Point;
  departureAfter: number;
  maxWalkMeters?: number;
  maxDurationSeconds: number;
  sourceIds?: string[];
}
export interface Progress {
  phase?: string;
  completed?: number;
  total?: number;
  edges?: {
    from: [number, number];
    to: [number, number];
    kind: "walk" | "ride";
  }[];
  [key: string]: unknown;
}
export type OnProgress = (progress: Progress) => void;
export interface RideLeg {
  kind: "ride";
  sourceId: string;
  trip: number;
  serviceDate: number;
  stopSequence: number;
  lastStopSequence: number;
  boardStop: number;
  alightStop: number;
  boardTime: number;
  alightTime: number;
  routeName: string;
  routeType: number;
  headsign: string;
  tripIri: string;
  routeIri: string;
  connectionIri: string;
  boardStopIri: string;
  alightStopIri: string;
}
export interface WalkLeg {
  kind: "walk";
  from: Endpoint;
  to: Endpoint;
  boardTime: number;
  alightTime: number;
  distanceMeters: number;
}
export interface Journey {
  departure: number;
  arrival: number;
  transfers: number;
  legs: (RideLeg | WalkLeg)[];
}
export interface JourneyResult {
  found: boolean;
  options: Journey[];
  totalOptions: number;
  scanned: number;
  window: {
    mode: "adaptive" | "full";
    from: number;
    to: number;
    earliestArrival: number | null;
  };
  diagnostics: Record<string, unknown>;
}
export interface IsochroneResult {
  found: boolean;
  noAccess: boolean;
  origin: Point;
  points: (Point & {
    sourceId: string;
    networkName: string;
    networkColor: string;
    name: string;
    durationSeconds: number;
  })[];
  maxWalkMeters: number;
  scanned: number;
  pages: number;
  diagnostics: Record<string, unknown>;
}
export interface PlannerRequests {
  request(
    type: "init",
    payload: { dataUrl: string },
    onProgress?: OnProgress,
  ): Promise<Source[]>;
  request(
    type: "plan",
    payload: JourneyQuery & { maxWalkMeters: number },
    onProgress?: OnProgress,
  ): Promise<JourneyResult>;
  request(
    type: "isochrone",
    payload: IsochroneQuery & { maxWalkMeters: number },
    onProgress?: OnProgress,
  ): Promise<IsochroneResult>;
}
export class Planner implements PlannerRequests {
  constructor(options?: PlannerOptions);
  dataUrl?: string;
  sources: Source[];
  init(dataUrl?: string): Promise<Source[]>;
  plan(query: JourneyQuery, onProgress?: OnProgress): Promise<JourneyResult>;
  isochrone(
    query: IsochroneQuery,
    onProgress?: OnProgress,
  ): Promise<IsochroneResult>;
  request: PlannerRequests["request"];
}
export function createPlanner(options?: PlannerOptions): Planner;
export const LC_VERSION: "2-alpha";
