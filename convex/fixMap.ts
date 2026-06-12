import { mutation } from './_generated/server';

// One-off maintenance: the map's tileSetUrl was seeded into the `maps` table with the old
// '/ai-town/assets/...' path (back when the app deployed under a /ai-town subpath). Now that we
// host at the root, that URL 404s and the map background doesn't render. Repoint it to /assets/.
// Safe to re-run; only patches rows still carrying the stale prefix.
export const fixTileSetUrls = mutation({
  args: {},
  handler: async (ctx) => {
    const maps = await ctx.db.query('maps').collect();
    let fixed = 0;
    for (const m of maps) {
      if (m.tileSetUrl.includes('/ai-town/assets/')) {
        await ctx.db.patch(m._id, {
          tileSetUrl: m.tileSetUrl.replace('/ai-town/assets/', '/assets/'),
        });
        fixed++;
      }
    }
    return { fixed, urls: (await ctx.db.query('maps').collect()).map((m) => m.tileSetUrl) };
  },
});
