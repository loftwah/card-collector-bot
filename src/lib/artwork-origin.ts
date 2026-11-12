export function artworkOriginLabel(origin?: string): string {
  switch (origin) {
    case "ai_assisted":
      return "AI-assisted artwork";
    case "ai_generated":
      return "AI-generated artwork";
    case "sourced":
      return "Sourced artwork";
    case "foilbury_original":
      return "Foilbury original";
    case "derived":
      return "Composed from source layers";
    default:
      return "Provenance review outstanding";
  }
}
