import type { MetadataRoute } from "next";

// Private order links and the console should never be crawled. The pages already carry
// noindex metadata; this keeps crawlers from following them in the first place.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/orders"] }] };
}
