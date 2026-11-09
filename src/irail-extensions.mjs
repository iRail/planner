// The iRail CDN publishes more than the Linked Connections tables: an
// `irail:extensions` link in the manifest points at an `irail.json` that names
// extra Arrow tables (`stations.arrow`, `headsigns.arrow`, …) of the same
// release. This loads one of them.

/**
 * Fetch the extension table `key` (`files[key].path` of irail.json). Resolves
 * to its rows, or null when the publisher offers no such extension. Throws for
 * an unreadable table, one of another release, or one missing a required
 * column, so callers can fall back to what the timetable itself says.
 * `tableFromIPC` is Apache Arrow's, passed in so this module stays
 * dependency-free; pass `manifest` when it is already parsed, to skip fetching
 * it again.
 */
export async function loadExtensionRows(
  manifestUrl,
  key,
  {
    fetch: fetchFn = globalThis.fetch,
    tableFromIPC,
    manifest: loaded,
    columns = [],
  } = {},
) {
  const json = async (url) => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return { data: await response.json(), url: response.url || url };
  };
  const { data: manifest, url: manifestBase } = loaded
    ? { data: loaded, url: manifestUrl }
    : await json(manifestUrl);
  const extension = manifest["irail:extensions"]?.["@id"];
  if (!extension) return null;
  const { data: info, url: infoUrl } = await json(
    new URL(extension, manifestBase).href,
  );
  const path = info.files?.[key]?.path;
  if (!path) return null;
  const tableUrl = new URL(path, infoUrl).href;
  const response = await fetchFn(tableUrl);
  if (!response.ok) throw new Error(`${tableUrl}: HTTP ${response.status}`);
  const table = tableFromIPC(new Uint8Array(await response.arrayBuffer()));
  const releaseId = table.schema.metadata.get("releaseId");
  if (releaseId && manifest.releaseId && releaseId !== manifest.releaseId)
    throw new Error(`${key}.arrow belongs to another release`);
  for (const column of columns)
    if (!table.getChild(column))
      throw new Error(`${key}.arrow has no ${column} column`);
  return Array.from({ length: table.numRows }, (_, i) => {
    const row = {};
    for (const field of table.schema.fields)
      row[field.name] = table.getChild(field.name).get(i);
    return row;
  });
}
