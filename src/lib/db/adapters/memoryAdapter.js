import { TABLES } from "../schema.js";

if (!global._memorySqlStore) {
  global._memorySqlStore = {
    tables: {},
    nextRowId: 1,
  };
}

const store = global._memorySqlStore;

for (const tableName of Object.keys(TABLES)) {
  if (!store.tables[tableName]) {
    store.tables[tableName] = [];
  }
}

function parseVal(str, params, paramIdx) {
  str = str.trim();
  if (str === "?") {
    return { val: params[paramIdx.val++], usedParam: true };
  }
  if (str.startsWith("'") && str.endsWith("'")) {
    return { val: str.slice(1, -1).replace(/''/g, "'"), usedParam: false };
  }
  if (str.startsWith('"') && str.endsWith('"')) {
    return { val: str.slice(1, -1).replace(/""/g, '"'), usedParam: false };
  }
  if (/^-?\d+(\.\d+)?$/.test(str)) return { val: Number(str), usedParam: false };
  if (/^null$/i.test(str)) return { val: null, usedParam: false };
  if (/^true$/i.test(str)) return { val: 1, usedParam: false };
  if (/^false$/i.test(str)) return { val: 0, usedParam: false };
  return { val: str, usedParam: false };
}

function matchCondition(row, cond, params, paramIdx) {
  cond = cond.trim();
  if (!cond) return true;
  if (cond.startsWith("(") && cond.endsWith(")")) cond = cond.slice(1, -1).trim();
  const inMatch = cond.match(/^(\w+)\s+(NOT\s+)?IN\s*\((.*)\)$/i);
  if (inMatch) {
    const [, col, not, rawItems] = inMatch;
    const rowVal = row[col];
    if (rawItems.includes("SELECT")) return true;
    const parts = rawItems.split(",").map((s) => s.trim());
    const items = parts.map((p) => parseVal(p, params, paramIdx).val);
    const found = items.includes(rowVal);
    return not ? !found : found;
  }
  const opMatch = cond.match(/^(\w+)\s*(>=|<=|!=|<>|=|>|<)\s*(.+)$/);
  if (opMatch) {
    const [, col, op, rawRhs] = opMatch;
    const { val: rhs } = parseVal(rawRhs, params, paramIdx);
    const lhs = row[col];
    switch (op) {
      case "=": return String(lhs) === String(rhs);
      case "!=": case "<>": return String(lhs) !== String(rhs);
      case ">=": return lhs >= rhs;
      case "<=": return lhs <= rhs;
      case ">": return lhs > rhs;
      case "<": return lhs < rhs;
      default: return true;
    }
  }
  const isNullMatch = cond.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
  if (isNullMatch) {
    const [, col, not] = isNullMatch;
    const isNull = row[col] === null || row[col] === undefined;
    return not ? !isNull : isNull;
  }
  return true;
}

function filterRows(rows, whereClause, params) {
  if (!whereClause || !whereClause.trim()) return rows;
  const conds = whereClause.split(/\s+AND\s+/i);
  return rows.filter((row) => {
    const rowParamIdx = { val: 0 };
    for (const cond of conds) {
      if (!matchCondition(row, cond, params, rowParamIdx)) return false;
    }
    return true;
  });
}

function applyOrderBy(rows, orderClause) {
  if (!orderClause) return rows;
  const parts = orderClause.trim().split(/\s*,\s*/);
  const orders = parts.map((p) => {
    const m = p.trim().match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    return m ? { col: m[1], desc: m[2] && m[2].toUpperCase() === "DESC" } : null;
  }).filter(Boolean);
  if (orders.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { col, desc } of orders) {
      const av = a[col], bv = b[col];
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return 0;
  });
}

function applyLimit(rows, limitClause) {
  if (!limitClause) return rows;
  const n = parseInt(limitClause.trim(), 10);
  return isNaN(n) ? rows : rows.slice(0, n);
}



export function createMemoryAdapter() {
  function getTable(name) {
    name = name.replace(/[`"']/g, "").trim();
    if (!store.tables[name]) store.tables[name] = [];
    return store.tables[name];
  }

  function run(sql, params = []) {
    sql = sql.trim().replace(/;$/, "");
    if (/^CREATE\s+(TABLE|INDEX)/i.test(sql)) return { changes: 0, lastInsertRowid: null };
    if (/^PRAGMA/i.test(sql)) return { changes: 0, lastInsertRowid: null };
    if (/^DROP\s+INDEX/i.test(sql)) return { changes: 0, lastInsertRowid: null };
    if (/^(SAVEPOINT|RELEASE|ROLLBACK)/i.test(sql)) return { changes: 0, lastInsertRowid: null };

    const insertMatch = sql.match(/^INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*\((.+?)\)(.*)$/is);
    if (insertMatch) {
      const [, rawTable, rawCols, rawVals, suffix] = insertMatch;
      const tableName = rawTable.replace(/[`"']/g, "").trim();
      const cols = rawCols.split(",").map((c) => c.replace(/[`"']/g, "").trim());
      const valParts = rawVals.split(",").map((v) => v.trim());
      const rows = getTable(tableName);
      const paramIdx = { val: 0 };
      const newRow = { _rowid: store.nextRowId++ };
      cols.forEach((col, idx) => {
        newRow[col] = parseVal(valParts[idx] ?? "?", params, paramIdx).val;
      });
      const conflictMatch = suffix.match(/ON\s+CONFLICT\s*(?:\(([^)]+)\))?\s*DO\s+UPDATE\s+SET\s+(.+)$/is);
      const isOrReplace = /^INSERT\s+OR\s+REPLACE/i.test(sql);
      let conflictCols = [];
      if (conflictMatch && conflictMatch[1]) {
        conflictCols = conflictMatch[1].split(",").map((c) => c.trim().replace(/[`"']/g, ""));
      } else if (isOrReplace) {
        if (newRow.id !== undefined) conflictCols = ["id"];
        else if (newRow.key !== undefined && newRow.scope !== undefined) conflictCols = ["scope", "key"];
        else if (newRow.key !== undefined) conflictCols = ["key"];
        else if (newRow.dateKey !== undefined) conflictCols = ["dateKey"];
      }
      let existingIdx = -1;
      if (conflictCols.length > 0) {
        existingIdx = rows.findIndex((r) => conflictCols.every((c) => String(r[c]) === String(newRow[c])));
      }
      if (existingIdx !== -1) {
        if (conflictMatch) {
          for (const assign of conflictMatch[2].split(",").map((a) => a.trim())) {
            const m = assign.match(/^(\w+)\s*=\s*(.+)$/);
            if (m) {
              const [, col, expr] = m;
              if (/^excluded\.(\w+)$/i.test(expr)) {
                rows[existingIdx][col] = newRow[expr.match(/^excluded\.(\w+)$/i)[1]];
              } else {
                rows[existingIdx][col] = parseVal(expr, params, paramIdx).val;
              }
            }
          }
        } else {
          rows[existingIdx] = { ...rows[existingIdx], ...newRow };
        }
      } else {
        rows.push(newRow);
      }
      return { changes: 1, lastInsertRowid: newRow.id ?? newRow._rowid };
    }

    const updateMatch = sql.match(/^UPDATE\s+([^\s]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
    if (updateMatch) {
      const [, rawTable, rawSets, rawWhere] = updateMatch;
      const rows = getTable(rawTable.replace(/[`"']/g, "").trim());
      const paramIdx = { val: 0 };
      const updates = rawSets.split(",").map((s) => {
        const m = s.trim().match(/^(\w+)\s*=\s*(.+)$/);
        return m ? { col: m[1], val: parseVal(m[2], params, paramIdx).val } : null;
      }).filter(Boolean);
      const matched = filterRows(rows, rawWhere, params.slice(paramIdx.val));
      for (const row of matched) for (const { col, val } of updates) row[col] = val;
      return { changes: matched.length, lastInsertRowid: null };
    }

    const deleteMatch = sql.match(/^DELETE\s+FROM\s+([^\s]+)(?:\s+WHERE\s+(.+))?$/is);
    if (deleteMatch) {
      const [, rawTable, rawWhere] = deleteMatch;
      const tableName = rawTable.replace(/[`"']/g, "").trim();
      const rows = getTable(tableName);
      if (!rawWhere) {
        const count = rows.length;
        store.tables[tableName] = [];
        return { changes: count, lastInsertRowid: null };
      }
      const matched = new Set(filterRows(rows, rawWhere, params));
      store.tables[tableName] = rows.filter((r) => !matched.has(r));
      return { changes: matched.size, lastInsertRowid: null };
    }
    return { changes: 0, lastInsertRowid: null };
  }


  function get(sql, params = []) {
    sql = sql.trim().replace(/;$/, "");
    if (/^PRAGMA\s+table_info/i.test(sql)) return undefined;
    if (/^PRAGMA\s+index_list/i.test(sql)) return undefined;
    const countMatch = sql.match(/^SELECT\s+COUNT\(\*\)\s+as\s+(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
    if (countMatch) {
      const [, alias, tbl, rawWhere] = countMatch;
      return { [alias]: filterRows(getTable(tbl), rawWhere, params).length };
    }
    if (/last_insert_rowid/i.test(sql)) return { id: store.nextRowId - 1 };
    const results = all(sql, params);
    return results.length > 0 ? results[0] : undefined;
  }

  function all(sql, params = []) {
    sql = sql.trim().replace(/;$/, "");
    if (/^PRAGMA\s+table_info/i.test(sql)) return [];
    if (/^PRAGMA\s+index_list/i.test(sql)) return [];
    const countMatch = sql.match(/^SELECT\s+COUNT\(\*\)\s+as\s+(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
    if (countMatch) {
      const [, alias, tbl, rawWhere] = countMatch;
      return [{ [alias]: filterRows(getTable(tbl), rawWhere, params).length }];
    }
    const selectMatch = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is);
    if (selectMatch) {
      const [, rawCols, rawTable, rawWhere, rawOrder, rawLimit] = selectMatch;
      let result = filterRows(getTable(rawTable.replace(/[`"']/g, "").trim()), rawWhere, params);
      result = applyOrderBy(result, rawOrder);
      result = applyLimit(result, rawLimit);
      const colStr = rawCols.trim();
      if (colStr === "*") return result.map((r) => { const o = { ...r }; delete o._rowid; return o; });
      const cols = colStr.split(",").map((c) => c.trim());
      return result.map((r) => {
        const out = {};
        for (const col of cols) {
          const asM = col.match(/^(\w+)\s+as\s+(\w+)$/i);
          out[asM ? asM[2] : col] = r[asM ? asM[1] : col];
        }
        return out;
      });
    }
    return [];
  }

  function exec(sql) {
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) run(stmt);
  }

  function transaction(fn) {
    return fn();
  }

  function close() {}

  return { driver: "memory", run, get, all, exec, transaction, close };
}
