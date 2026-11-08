export function networkColor(id, configured) {
  if (/^#[0-9a-f]{6}$/iu.test(configured || "")) return configured;
  const known = {
    delijn: "#a16207",
    tec: "#b91c1c",
    nmbs: "#2563eb",
    "gtfs-nmbs": "#2563eb",
    mivb: "#7c3aed",
    "stib-mivb": "#7c3aed",
  };
  if (known[id]) return known[id];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 65%, 38%)`;
}
