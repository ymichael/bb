import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { events } from "../schema.js";

const INLINE_OUTPUT_JSON_PATHS = [
  "$.item.aggregatedOutput",
  "$.item.result",
  "$.item.resultText",
] as const;

const NOOP_JSON_PATH = "$.__bb_timeline_truncation_noop__";

function truncationMarkerSql(originalLength: SQL, max: number): SQL {
  return sql`char(10) || '…[' || printf('%,d', ${originalLength} - ${max}) || ' more characters truncated]'`;
}

export function truncatedEventDataColumn(
  maxInlineOutputChars: number,
): SQL<string> {
  const pairs: SQL[] = [];
  for (const path of INLINE_OUTPUT_JSON_PATHS) {
    const value = sql`json_extract(${events.data}, ${path})`;
    const overflows = sql`json_type(${events.data}, ${path}) = 'text' AND length(${value}) > ${maxInlineOutputChars}`;
    pairs.push(
      sql`CASE WHEN ${overflows} THEN ${path} ELSE ${NOOP_JSON_PATH} END`,
      sql`substr(${value}, 1, ${maxInlineOutputChars}) || ${truncationMarkerSql(sql`length(${value})`, maxInlineOutputChars)}`,
    );
  }

  return sql<string>`CASE
    WHEN length(${events.data}) <= ${maxInlineOutputChars} THEN ${events.data}
    ELSE json_replace(${events.data}, ${sql.join(pairs, sql`, `)})
  END`;
}
