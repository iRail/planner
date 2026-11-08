// Default: the iRail CDN's live LC 2.0-alpha timetable (NMBS/SNCB). Override at
// runtime with ?data=https://publisher/manifest.jsonld or set VITE_DATA_URL when
// building the playground. The bundled illustrative sample is at ?data=./data/.
export const defaultDataUrl = "https://irail.github.io/iRail-cdn/manifest.jsonld";
export const dataUrl = import.meta.env.VITE_DATA_URL || defaultDataUrl;
