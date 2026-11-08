export function resolveDataUrl(configured, pageUrl, baseUrl = pageUrl) {
  const override = new URL(pageUrl).searchParams.get("data");
  const directory = override || configured || "./";
  const url = new URL(directory, baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("The data URL must use HTTP or HTTPS");
  return url.href;
}
