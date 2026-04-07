export const TILES_QUERIES = {
  ALL_TILES: `
    SELECT DISTINCT
        data
    FROM \`s1_eternum-TileOpt\`
    ORDER BY alt, col, row;
  `,

  TILES_BY_COORDS: `
    SELECT
        data
    FROM \`s1_eternum-TileOpt\`
    WHERE (col, row) IN ({coords});
  `,

  TILES_COORDS_IN_BOUNDS: `
    SELECT
        col,
        row
    FROM \`s1_eternum-TileOpt\`
    WHERE col BETWEEN {minCol} AND {maxCol}
      AND row BETWEEN {minRow} AND {maxRow};
  `,

  TILES_ROWS_IN_BOUNDS: `
    SELECT
        internal_entity_id,
        alt,
        col,
        row,
        data
    FROM \`s1_eternum-TileOpt\`
    WHERE col BETWEEN {minCol} AND {maxCol}
      AND row BETWEEN {minRow} AND {maxRow};
  `,

  TILES_IN_BOUNDS: `
    SELECT
        data
    FROM \`s1_eternum-TileOpt\`
    WHERE col >= {minX}
      AND col <= {maxX}
      AND row >= {minY}
      AND row <= {maxY}
    ORDER BY alt, col, row;
  `,
} as const;
