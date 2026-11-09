// Headsigns (the destination a train shows) in several languages. The trips
// table has one text per trip, in the language of the operator's data (mostly
// French or Dutch, per place). iRail's CDN publishes the translations in a
// `headsigns.arrow` extension: one row per distinct headsign with
// `translationNl`, `translationDe` and `translationEn`.

import { loadExtensionRows } from "./irail-extensions.mjs";

const TRANSLATION_COLUMNS = {
  nl: "translationNl",
  de: "translationDe",
  en: "translationEn",
};

/** Rows of the manifest's `headsigns.arrow`, or null when it publishes none. */
export function loadHeadsignRows(manifestUrl, options = {}) {
  return loadExtensionRows(manifestUrl, "headsigns", {
    ...options,
    columns: ["headsign", ...Object.values(TRANSLATION_COLUMNS)],
  });
}

/**
 * `{ translate(headsign, language), all(headsign) }` for the rows of `headsigns.arrow` (none:
 * every headsign stays as published). The headsign itself answers `fr`, an
 * unknown language, and any headsign without a translation. `all` gives every
 * text there is, by language: `{ fr: headsign, nl, de, en }`.
 */
export function buildHeadsigns(rows = []) {
  const byHeadsign = new Map();
  for (const row of rows) {
    if (!row.headsign || byHeadsign.has(row.headsign)) continue;
    byHeadsign.set(
      row.headsign,
      Object.fromEntries(
        Object.entries(TRANSLATION_COLUMNS)
          .filter(([, column]) => row[column])
          .map(([language, column]) => [language, row[column]]),
      ),
    );
  }
  return {
    size: byHeadsign.size,
    translate: (headsign, language) =>
      (language && byHeadsign.get(headsign)?.[language]) || headsign,
    all: (headsign) => ({ fr: headsign, ...byHeadsign.get(headsign) }),
  };
}
