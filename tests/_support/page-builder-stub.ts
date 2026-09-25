/**
 * A stand-in for getPageBuilderContext (src/lib/page-builder.functions.ts),
 * which is a server function (it would need a request to authenticate). The
 * offline copy of generation.functions.ts that tests/generation-flow.test.ts
 * builds imports this module instead, so the real startJob can be driven;
 * the test sets the cities it answers with.
 */
export const pageBuilderStub: {
  cities: Array<{ city: string; state: string | null; listingCount: number; hasPage: boolean }>;
  syncedListings: number;
  dominantCategory: string | null;
} = { cities: [], syncedListings: 0, dominantCategory: null };

export async function getPageBuilderContext(_: { data: { workspaceId: string } }) {
  return {
    cities: pageBuilderStub.cities,
    stats: { syncedListings: pageBuilderStub.syncedListings },
    dominantCategory: pageBuilderStub.dominantCategory,
  };
}
