/** The service day of a leg (YYYYMMDD) as an instant on that Belgian day. */
export function serviceDayInstant(serviceDate) {
  if (!serviceDate) return undefined;
  const year = Math.floor(serviceDate / 10000);
  const month = Math.floor(serviceDate / 100) % 100;
  return new Date(Date.UTC(year, month - 1, serviceDate % 100, 12));
}
