/**
 * ESQL hover documentation.
 *
 * Built-in functions, message tree variables, parser domains and data types
 * are documented from `src/data/` (ported from joaquinvulcano/esql-vscode,
 * MIT — see ATTRIBUTION.md — and extended with types and domains).
 *
 * On top of that, hover explains the document's OWN symbols: user-declared
 * variables and constants, routine parameters and user-defined
 * functions/procedures with their signature. Those come from the parse tree
 * when the grammar is loaded, otherwise from the same pattern fallback the
 * definitions module uses (less precise ownership information, never empty).
 *
 * Word lookup runs on masked lines, so hovering inside a string literal or
 * comment yields nothing.
 */

import { Hover, Range } from 'vscode-languageserver';
import { scan } from './scanner';
import {
  ESQL_FUNCTIONS,
  ESQL_MESSAGE_TREE_VARS,
  ESQL_DOMAINS,
  ESQL_TYPES,
} from './data/esqlData';
import {
  declarationsFromSource,
  routinesFromSource,
  rangeContains,
  wordAtPosition,
  modulesFromSource,
  schemaFromSource,
  matchesSchemaName,
  declarationAt,
  routineTargetsFor,
  enclosingRoutine,
  callTargetAt,
  qualifierMatchesModule,
} from './definitions';
import type { DocAnalysis, DeclaredName, RoutineInfo } from './parser';

function markdown(value: string): Hover {
  return { contents: { kind: 'markdown', value } };
}

/** `CREATE FUNCTION f(IN a INT) RETURNS BOOLEAN` — the hover signature. */
export function routineSignature(r: RoutineInfo): string {
  const returns = r.returnType ? ` RETURNS ${r.returnType}` : '';
  return `CREATE ${r.kind} ${r.name}(${r.params})${returns}`;
}

/** Where a routine body lives, in words ('' when unknown). */
function routineOwnerLine(r: RoutineInfo): string {
  return r.moduleName ? `\n\n*in module \`${r.moduleName}\`*` : '\n\n*at document level*';
}

function routineHover(r: RoutineInfo): Hover {
  return markdown(
    `### \`${r.name}\`\n\n**ESQL ${r.kind.toLowerCase()}**${routineOwnerLine(r)}` +
      `\n\n\`\`\`esql\n${routineSignature(r)}\n\`\`\`` +
      (r.kind === 'FUNCTION' && !r.returnType
        ? '\n\n_No RETURNS clause — ACE cannot use its value._'
        : '')
  );
}

/**
 * Hover for an unqualified name that several modules own and none of them is
 * the cursor's — genuinely ambiguous (Enh 36: shown, not silently chosen).
 * Listing every candidate is what definition/references/rename answer for the
 * same position, so the three features can no longer disagree about it.
 */
function ambiguousRoutineHover(targets: RoutineInfo[]): Hover {
  const list = targets
    .map(
      (r) =>
        `- ${routineSignature(r)} — ${
          r.moduleName ? `module \`${r.moduleName}\`` : 'document level'
        }, line ${r.range.start.line + 1}`
    )
    .join('\n');
  return markdown(
    `### \`${targets[0].name}\`\n\n**Ambiguous name** — ${targets.length} routines share it ` +
      `and the cursor's module declares none:\n\n${list}\n\n` +
      '_Go to definition lists all of them; rename refuses on ambiguity._'
  );
}

/** Where a declaration belongs, in words ('' when the scope is unknown). */
function declarationOwnerLine(
  d: DeclaredName,
  routines: RoutineInfo[],
  modules: { name: string; range: Range }[]
): string {
  // Parameters sit in the routine's header (outside BEGIN..END), so the whole
  // CREATE..END statement is the containment test that works for both. The
  // innermost enclosing one: with two `Main()` routines in one file, `find`
  // blamed the first for the second's variables (I-15).
  const owner = enclosingRoutine(routines, d.range.start.line, d.range.start.character);
  if (owner) return `\n\n*in \`${owner.name}()\`*`;
  const mod = modules.find((m) =>
    rangeContains(m.range, d.range.start.line, d.range.start.character)
  );
  if (mod) return `\n\n*in module \`${mod.name}\`*`;
  return '\n\n*at document level*';
}

function declarationHover(
  d: DeclaredName,
  routines: RoutineInfo[],
  modules: { name: string; range: Range }[]
): Hover {
  const what = d.kind === 'parameter' ? 'Routine parameter' : 'Declared variable';
  // Parameter details are prefixed with the kind by the parser
  // ('parameter INTEGER'); do not repeat it in the heading.
  const type = d.detail.replace(/^parameter\s*/i, '');
  const typePart = type ? ` — \`${type}\`` : '';
  return markdown(
    `### \`${d.name}\`\n\n**${what}**${typePart}` +
      declarationOwnerLine(d, routines, modules) +
      (d.constant ? '\n\n_Constant: cannot be reassigned._' : '')
  );
}

export function hoverAt(
  source: string,
  line: number,
  character: number,
  doc?: DocAnalysis
): Hover | null {
  const { lines, rawLines, quotedTokens } = scan(source);
  // Shared with go-to-definition/references, so a quoted declare name hovers
  // exactly where it is navigable (and vice versa).
  const w = wordAtPosition(lines, rawLines, line, character, quotedTokens);
  if (!w) return null;

  const upper = w.word.toUpperCase();
  const eq = (name: string) => name.toUpperCase() === upper;

  // ── this document's own symbols first: they shadow nothing a reader
  //    cares about more than the declaration right in front of them ──
  // Resolved *at the cursor*, never "the first match in file order": a name
  // declared in two routines must hover the one the cursor is inside, or hover
  // and go-to-definition describe different things at the same position
  // (ISSUES.md I-15).
  const routines: RoutineInfo[] = doc
    ? doc.routines
    : routinesFromSource(source);

  // Issue 3 / issue 5: a qualified CALL (`CALL Sales.Helper(`) names the
  // OWNER module as well as the routine — a local same-named routine living
  // in a different module is a different symbol and must not answer. Null
  // sends the server to the (equally filtered) workspace half.
  const call = callTargetAt(source, line, character);
  if (call && call.cursorOnName && call.qualifier.length) {
    const modules = doc ? doc.modules : modulesFromSource(source);
    const owned = routines.filter(
      (r) =>
        eq(r.name) &&
        modules.some(
          (m) =>
            qualifierMatchesModule(call.qualifier, m.name) &&
            rangeContains(m.range, r.range.start.line, r.range.start.character)
        )
    );
    return owned.length ? routineHover(owned[0]) : null;
  }

  // Issue 3 / issue 5 / Enh 36, the hover side: resolved through the SAME
  // routineTargetsFor that definition, references and rename use — module-local
  // resolution for an unqualified use, the declaration itself when the cursor
  // sits on one. `routineByNameAt` here used to fall back to the FIRST
  // same-named routine in file order, so hovering a call into an ambiguous name
  // silently picked one module while definition listed them all (correctness
  // review 2026-10-30). An ambiguous name now says so, like definition shows
  // them.
  // `RoutineDecl` is the resolver's narrowed view; the objects themselves are
  // full `RoutineInfo`s from the shared extractors (the same cast
  // `routineDecls()` performs in the other direction).
  const targets = routineTargetsFor(source, line, character, w.word, w.range, doc) as RoutineInfo[];
  if (targets.length === 1) return routineHover(targets[0]);
  if (targets.length > 1) return ambiguousRoutineHover(targets);

  const declarations: DeclaredName[] = doc
    ? doc.declaredNames
    : declarationsFromSource(source);
  const declaration = declarationAt(declarations, w.word, line, character);
  if (declaration) {
    return declarationHover(
      declaration,
      routines,
      doc
        ? doc.modules.map((m) => ({ name: m.name, range: m.range }))
        : // The pattern fallback knows the module spans too, so the owner line
          // reads the same in both modes (I-15).
          modulesFromSource(source)
    );
  }

  // ── module and schema names: someone hovering these is orienting themselves,
  //    so say what kind of thing it is and what it holds ──
  const modules = doc ? doc.modules : modulesFromSource(source);
  const module = modules.find((m) => eq(m.name));
  if (module) {
    const inside = routines
      .filter(
        (r) =>
          r.range.start.line >= module.range.start.line &&
          r.range.start.line <= module.range.end.line
      )
      .map((r) => r.name);
    const routinesText = inside.length
      ? `Contains ${inside.length} routine${inside.length === 1 ? '' : 's'}: ${inside
          .map((n) => `\`${n}\``)
          .join(', ')}.`
      : 'Contains no routines.';
    return markdown(
      `### \`${module.name}\`\n\n**${module.kind} MODULE** — declared at line ${
        module.nameRange.start.line + 1
      }. ${routinesText}\n\n_A message centre: the routines of one message flow._`
    );
  }

  let schema: { name: string; range: Range } | undefined;
  if (doc) {
    schema = doc.schemas.find((s) => matchesSchemaName(s.name, w.word));
  } else {
    const declared = schemaFromSource(source);
    if (declared && matchesSchemaName(declared.name, w.word)) schema = declared;
  }
  if (schema) {
    return markdown(
      `### \`${schema.name}\`\n\n**BROKER SCHEMA** — the application schema this file belongs to.` +
        '\n\n_One per file; it names the deployable application the flow is part of._'
    );
  }

  // Built-in function
  const fn = ESQL_FUNCTIONS.find((f) => eq(f.name));
  if (fn) {
    let md = `### \`${fn.name}\`\n\nESQL built-in function\n\n\`\`\`esql\n${fn.signature}\n\`\`\`\n\n${fn.description}`;
    if (fn.returnType) {
      md += `\n\n**Returns:** \`${fn.returnType}\``;
    }
    if (fn.example) {
      md += `\n\n**Example:**\n\n\`\`\`esql\n${fn.example}\n\`\`\``;
    }
    return markdown(md);
  }

  // Message tree variable (case-insensitive, shown in canonical case)
  const treeVar = ESQL_MESSAGE_TREE_VARS.find((v) => eq(v.name));
  if (treeVar) {
    return markdown(
      `### \`${treeVar.name}\`\n\n**ESQL message tree variable**\n\n${treeVar.description}`
    );
  }

  // Parser / domain
  const domain = ESQL_DOMAINS.find((d) => eq(d.name));
  if (domain) {
    return markdown(
      `### \`${domain.name}\`\n\n**ESQL parser / message domain** — ${domain.detail}\n\n${domain.description}`
    );
  }

  // Data type
  const type = ESQL_TYPES.find((t) => eq(t.name));
  if (type) {
    return markdown(`### \`${type.name}\`\n\n**ESQL data type**\n\n${type.description}`);
  }

  return null;
}
