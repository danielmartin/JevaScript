// Ordinary TypeScript: permissions and review policy remain exact application rules.
export const travelTools = [
  "plug type", "travel notification", "translate", "flight status",
  "international visa", "timezone", "exchange rate", "travel suggestion",
  "travel alert", "vaccines", "lost luggage", "book flight", "book hotel",
  "carry on", "car rental",
] as const;

type TravelTool = typeof travelTools[number];
type RouteResult =
  | { status: "accepted"; tool: TravelTool; probability: number }
  | { status: "review"; candidate: TravelTool; probability: number };

export function reviewRoute(
  choice: TravelTool, probabilities: Record<TravelTool, number>, threshold: number,
): RouteResult {
  const probability = probabilities[choice];
  return probability >= threshold
    ? { status: "accepted", tool: choice, probability }
    : { status: "review", candidate: choice, probability };
}

export function reviewThreshold(): number {
  const value = Number(process.env.TRAVEL_REVIEW_THRESHOLD ?? "0.90");
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("TRAVEL_REVIEW_THRESHOLD must be between 0 and 1");
  }
  return value;
}
