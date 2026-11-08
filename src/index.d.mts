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
  /**
   * Keep searching later departures, for up to two days, until this many
   * alternatives are found. A single search returns fewer when its window is
   * short. The result then holds exactly this many, or all that exist.
   */
  minOptions?: number;
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
/** `nl`, `fr`, `en` or `de`; stations are labelled in it. */
export type Language = "nl" | "fr" | "en" | "de";
/** An instant: a `Date`, or epoch milliseconds like `Date.now()`. */
export type Instant = Date | number;

/** Parameters every iRail call accepts. */
export interface IrailQuery {
  /** Default `en`. */
  language?: Language;
  /** Which loaded source to ask, when several are loaded. Default: the first. */
  sourceId?: string;
}

/** A station, labelled in the query's language. */
export interface Station {
  /** `BE.NMBS.008892007`; accepted wherever a station is asked for. */
  id: string;
  /** `http://irail.be/stations/NMBS/008892007` */
  uri: string;
  /** The label in the query's language, or the standard name without a translation. */
  name: string;
  standardName: string;
  latitude: number | null;
  longitude: number | null;
}
/** A train, or a bus replacing one. */
export interface Vehicle {
  /** `BE.NMBS.IC508`; accepted by `vehicle()`. */
  id: string;
  uri: string;
  /** `IC`, `S51`, `BUS`, … */
  type: string;
  number: string;
  /** `IC 508` */
  name: string;
}
/**
 * A station named by id, URI, number or name in any language, or a Station
 * returned by an earlier call.
 */
export type StationRef = string | Pick<Station, "id">;

export interface LiveboardQuery extends IrailQuery {
  station: StationRef;
  /** The board covers the hour from here. Default: now. */
  time?: Instant;
  /** Default `departure`. */
  type?: "departure" | "arrival";
}
export interface LiveboardEntry {
  time: Date;
  /** Seconds. Always 0: the timetable is scheduled data. */
  delay: number;
  canceled: boolean;
  vehicle: Vehicle;
  /** `null` until the data has platforms. */
  platform: string | null;
}
export interface DepartureEntry extends LiveboardEntry {
  /** Where the train ends. */
  destination: Station;
}
export interface ArrivalEntry extends LiveboardEntry {
  /** Where the train started. */
  origin: Station;
}
export interface LiveboardResult<Entry> {
  station: Station;
  type: "departure" | "arrival";
  entries: Entry[];
}

export interface VehicleQuery extends IrailQuery {
  /** `BE.NMBS.IC508` or `IC508`. */
  id: string;
  /** Any instant of the Belgian day to look at. Default: today. */
  date?: Instant;
}
export interface VehicleStop {
  station: Station;
  /** `null` at the first stop. */
  arrival: Date | null;
  /** `null` at the last stop. */
  departure: Date | null;
  platform: string | null;
  /** Seconds. Always 0 for now. */
  arrivalDelay: number;
  departureDelay: number;
  canceled: boolean;
}
export interface VehicleResult {
  vehicle: Vehicle;
  stops: VehicleStop[];
}

export interface ConnectionsQuery extends IrailQuery {
  /** A station reference: id, URI, number or a name in any language. */
  from: StationRef;
  to: StationRef;
  /** Depart at or after this instant. Default: now. */
  time?: Instant;
  /** How many connections to return. Default 6, at most 12. */
  limit?: number;
  /** Walking between stations, in meters (0–5000). Default 0. */
  maxWalkMeters?: number;
  /** Arrive by `time` instead of leaving after it. Not supported yet. */
  arriveBy?: boolean;
  /** `all` is supported; `trains` and `domestic-trains` are not yet. */
  vehicles?: "all" | "trains" | "domestic-trains";
}
export interface LegEnd {
  station: Station;
  time: Date;
  platform: string | null;
  /** Seconds. Always 0 for now. */
  delay: number;
  canceled: boolean;
}
export interface IntermediateStop {
  station: Station;
  arrival: Date;
  departure: Date;
}
export interface ConnectionLeg {
  type: "ride" | "walk";
  from: LegEnd;
  to: LegEnd;
  /** `null` for walks. */
  vehicle: Vehicle | null;
  /** The vehicle's published destination; `null` for walks. */
  direction: string | null;
  /** Stops between the ends of a ride. */
  stops: IntermediateStop[];
  /** Walks only. */
  distanceMeters: number | null;
}
export interface Connection {
  departure: Date;
  arrival: Date;
  /** Seconds. */
  duration: number;
  transfers: number;
  legs: ConnectionLeg[];
}

/** An error response of the iRail-style API; `status` is the HTTP status the API would use. */
export class IrailApiError extends Error {
  constructor(status: number, message: string);
  status: number;
}
/** Thrown by calls the iRail API has but the planner cannot answer yet. `status` is 501. */
export class NotSupportedError extends IrailApiError {
  constructor(call: string, reason: string);
  call: string;
}

/**
 * The calls of the iRail API (https://docs.irail.be), answered from the
 * scheduled timetable, in plain JavaScript types. Rejections are IrailApiErrors.
 */
export interface IrailApi {
  stations(query?: IrailQuery): Promise<Station[]>;
  liveboard(
    query: LiveboardQuery & { type: "arrival" },
  ): Promise<LiveboardResult<ArrivalEntry>>;
  liveboard(
    query: LiveboardQuery & { type?: "departure" },
  ): Promise<LiveboardResult<DepartureEntry>>;
  connections(query: ConnectionsQuery): Promise<Connection[]>;
  vehicle(query: VehicleQuery): Promise<VehicleResult>;
  /** Not supported yet: always rejects with a NotSupportedError. */
  composition(query?: { vehicle?: string; language?: Language }): Promise<never>;
  /** Not supported yet: always rejects with a NotSupportedError. */
  disturbances(query?: { language?: Language }): Promise<never>;
  /** Not supported yet: always rejects with a NotSupportedError. */
  occupancyFeedback(query?: {
    vehicle?: string;
    station?: StationRef;
    time?: Instant;
    occupancy?: "low" | "medium" | "high";
  }): Promise<never>;
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
  request(type: "stations", payload: IrailQuery): Promise<Station[]>;
  request(
    type: "liveboard",
    payload: LiveboardQuery,
  ): Promise<LiveboardResult<DepartureEntry | ArrivalEntry>>;
  request(type: "connections", payload: ConnectionsQuery): Promise<Connection[]>;
  request(type: "vehicle", payload: VehicleQuery): Promise<VehicleResult>;
}
export class Planner implements PlannerRequests, IrailApi {
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
  stations: IrailApi["stations"];
  liveboard: IrailApi["liveboard"];
  connections: IrailApi["connections"];
  vehicle: IrailApi["vehicle"];
  composition: IrailApi["composition"];
  disturbances: IrailApi["disturbances"];
  occupancyFeedback: IrailApi["occupancyFeedback"];
}
export function createPlanner(options?: PlannerOptions): Planner;
export const LC_VERSION: "2-alpha";
