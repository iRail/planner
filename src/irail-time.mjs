// Belgian wall-clock time handling for the iRail calls: a vehicle is looked up
// by Belgian calendar day. Everything else in the library is UTC epoch seconds.

export const TIME_ZONE = "Europe/Brussels";

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(epochSeconds, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(epochSeconds * 1000));
  const value = Object.fromEntries(
    parts
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
  };
}

/** The instant (UTC epoch seconds) at which a time zone's clock shows the given time. */
export function zonedToEpoch(
  { year, month, day, hour = 0, minute = 0 },
  timeZone = TIME_ZONE,
) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // Correct by the offset the zone actually has at the guessed instant; two
  // rounds settle across a DST change.
  for (let round = 0; round < 2; round += 1) {
    const shown = zonedParts(guess / 1000, timeZone);
    guess +=
      wanted -
      Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  }
  return guess / 1000;
}

/** The `yyyymmdd` number LC 2.0-alpha uses for service dates. */
export function serviceDateOf(epochSeconds, timeZone = TIME_ZONE) {
  const p = zonedParts(epochSeconds, timeZone);
  return p.year * 10000 + p.month * 100 + p.day;
}
