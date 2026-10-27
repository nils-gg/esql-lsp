/**
 * ESQL completion.
 *
 * Context-sensitive completion (ported from joaquinvulcano/esql-vscode, MIT —
 * see ATTRIBUTION.md) plus variables declared in the current document.
 *
 * Contexts:
 *   <root>.          -> parser domains (JSON, XMLNSC, MRM, ...)
 *   <root>.JSON.     -> Data
 *   <root>.XMLNSC.   -> (XML root element — schema-driven in Phase 3)
 *   <LE root>.       -> common LocalEnvironment fields
 *   Database.        -> (datasource placeholder)
 *   DECLARE name /   -> data types
 *   RETURNS          -> data types
 *   mid-clause       -> NEXT WORDS: when the masked line prefix matches a
 *                       clause position in NEXT_WORD_RULES (e.g. just typed
 *                       `PROPAGATE TO `), the list narrows to the words that
 *                       can legally continue the clause — the ESQL analogue
 *                       of “only valid next words after a command”.
 *   anything else    -> keywords + functions + tree vars + types +
 *                       declared vars in scope + snippets, one item per
 *                       label, filtered by the word currently being typed
 */

import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import {
  ESQL_KEYWORDS,
  ESQL_TYPES,
  ESQL_MESSAGE_TREE_VARS,
  ESQL_DOMAINS,
  ESQL_LOCAL_ENVIRONMENT_FIELDS,
  ESQL_FUNCTIONS,
  EsqlDomainDoc,
} from './data/esqlData';
import { NEXT_WORD_RULES } from './data/nextWords';
import type { NextWordRule } from './data/nextWords';
import { ESQL_SNIPPETS } from './data/snippets';
import { declarationsFromSource, routinesFromSource, visibleDeclarationsAt } from './definitions';
import { scan } from './scanner';
import type { DeclaredName, RoutineInfo } from './parser';

export type CompletionContextKind =
  | 'domains'
  | 'local-env'
  | 'json-data'
  | 'xmlns-root'
  | 'datasource'
  | 'types'
  | 'general';

/** Determine which completion context the cursor is in. */
export function detectCompletionContext(linePrefix: string): CompletionContextKind {
  // `<root>.JSON.` — dot after the domain already typed.
  if (/\b(InputRoot|OutputRoot)\.JSON\s*\.\s*$/i.test(linePrefix)) {
    return 'json-data';
  }
  // `<root>.XMLNSC.` — dot after the domain already typed.
  if (/\b(InputRoot|OutputRoot)\.XMLNSC\s*\.\s*$/i.test(linePrefix)) {
    return 'xmlns-root';
  }
  // `<root>.` or `<root>.<partial-domain>` — offer parser domains,
  // filtered by whatever has been typed so far.
  const domainPrefix = linePrefix.match(/\b(InputRoot|OutputRoot)\s*\.\s*([A-Za-z0-9_]*)$/i);
  if (domainPrefix) {
    const partial = domainPrefix[2].toLowerCase();
    if (
      partial === '' ||
      ESQL_DOMAINS.some((d) => d.name.toLowerCase().startsWith(partial))
    ) {
      return 'domains';
    }
  }

  if (/\b(InputLocalEnvironment|OutputLocalEnvironment|LocalEnvironment|Environment)\s*\.\s*$/i.test(linePrefix)) {
    return 'local-env';
  }
  if (/\bDatabase\s*\.\s*$/i.test(linePrefix)) {
    return 'datasource';
  }
  if (
    /\bRETURNS\s*$/i.test(linePrefix) ||
    /\bDECLARE\s+[A-Za-z_]\w*\s+(?:CONSTANT\s+)?\s*$/i.test(linePrefix)
  ) {
    return 'types';
  }
  return 'general';
}

function markdown(value: string): { kind: 'markdown'; value: string } {
  return { kind: 'markdown' as const, value };
}

function ci(label: string, kind: CompletionItemKind): CompletionItem {
  const item = CompletionItem.create(label);
  item.kind = kind;
  return item;
}

/**
 * `sortText` ranks for C-3: the server stopped pruning the general list by
 * prefix, so ranking is the client's job — and a client that ranks by plain
 * string comparison at least sees the RIGHT things on top: clause-rule words
 * (`0:`), then the user's own names — declared, own routines, workspace
 * facts (`1:`). Digits sort before letters, so both prefixes float those
 * groups above the unranked built-ins and snippets (whose sortText defaults
 * to their label). The label suffix keeps each group alphabetical inside
 * itself.
 */
function rankClause(item: CompletionItem): CompletionItem {
  item.sortText = `0:${item.label}`;
  return item;
}

function rankUser(item: CompletionItem): CompletionItem {
  item.sortText = `1:${item.label}`;
  // The label IS the text a matcher should score (quoted declare names are
  // stored bare; a client must never score the detail or the snippet body).
  item.filterText = item.label;
  return item;
}

function domainItems(doc: EsqlDomainDoc[]): CompletionItem[] {
  return doc.map((d) => {
    const item = ci(d.name, CompletionItemKind.Module);
    item.detail = d.detail;
    item.documentation = markdown(d.description);
    return item;
  });
}

function typeItems(): CompletionItem[] {
  return ESQL_TYPES.map((t) => {
    const item = ci(t.name, CompletionItemKind.TypeParameter);
    item.detail = 'ESQL data type';
    item.documentation = markdown(t.description);
    return item;
  });
}

function functionItems(): CompletionItem[] {
  return ESQL_FUNCTIONS.map((fn) => {
    const item = ci(fn.name, CompletionItemKind.Function);
    item.detail = fn.signature;
    item.documentation = markdown(
      `**${fn.name}**\n\n${fn.description}` +
        (fn.returnType ? `\n\n**Returns:** \`${fn.returnType}\`` : '') +
        (fn.example ? `\n\n**Example:**\n\n\`\`\`esql\n${fn.example}\n\`\`\`` : '')
    );
    return item;
  });
}

function keywordItems(): CompletionItem[] {
  return ESQL_KEYWORDS.map((kw) => {
    const item = ci(kw, CompletionItemKind.Keyword);
    item.detail = 'ESQL keyword';
    return item;
  });
}

function treeVarItems(): CompletionItem[] {
  return ESQL_MESSAGE_TREE_VARS.map((v) => {
    const item = ci(v.name, CompletionItemKind.Variable);
    item.detail = 'ESQL message tree variable';
    item.documentation = markdown(v.description);
    return item;
  });
}

/**
 * Strip LSP snippet syntax down to text that is valid ESQL as typed:
 * `${N:placeholder}` → its placeholder, `${N|choice1,choice2|}` → the FIRST
 * choice (it is the body's own suggested default — `DECLARE x CHARACTER …`,
 * `PROPAGATE TO TERMINAL 'out'` compile), `${N}`/`$N`/`$0` → nothing.
 * Innermost-first iteration so the nested `${3: DEFAULT ${4:''}}` resolves.
 * Used only for clients that never declared `completionItem.snippetSupport`
 * — for them, `insertText` defaults to PlainText, and shipping raw `${1:…}`
 * would type placeholders straight into the buffer (CODE_REVIEW.md C-4).
 */
export function plainSnippetText(body: string): string {
  const innermost = /\$\{\d+(?::([^{}]*)|\|([^|{}]*)\|)?\}|\$\d+/g;
  let text = body;
  for (let pass = 0; pass < 8; pass++) {
    const next = text.replace(innermost, (_m, placeholder, choices) =>
      choices !== undefined ? String(choices).split(',')[0] : placeholder ?? ''
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

function snippetItems(snippetSupport: boolean): CompletionItem[] {
  return ESQL_SNIPPETS.map((s) => {
    const item = ci(s.label, CompletionItemKind.Snippet);
    item.detail = s.description;
    // Match on the TRIGGER, never on the expanded body (C-3): a client that
    // would otherwise score `insertText` must still find `throw` by typing
    // `throw`, not by typing the code it expands to.
    item.filterText = s.label;
    if (snippetSupport) {
      // The client asked for snippets, so the placeholder bodies are honest
      // to send (ISSUES.md-style one-liner: without the flag, spec-correct
      // clients still insert them as literal text — C-4).
      item.insertText = s.insertText;
      item.insertTextFormat = InsertTextFormat.Snippet;
    } else {
      item.insertText = plainSnippetText(s.insertText);
      item.insertTextFormat = InsertTextFormat.PlainText;
    }
    return item;
  });
}

/**
 * Declared names → completion items, from either source of declarations: the
 * parse tree, or the shared regex extractor (`declarationsFromSource`). Both
 * modes come through here, so they offer the same shape — including multi-name
 * DECLAREs, parameters of a multi-line routine header, and quoted `EXTERNAL`
 * names.
 */
function declaredItemsFromTree(declarations: DeclaredName[]): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const d of declarations) {
    const upper = d.name.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const item = ci(d.name, CompletionItemKind.Variable);
    item.detail = `Declared: ${d.detail}`;
    rankUser(item);
    items.push(item);
  }
  return items;
}

/**
 * A name the workspace knows from ANOTHER file (CODE_REVIEW.md C-1/C-2),
 * already reduced to what a completion detail needs. `server.ts` excludes the
 * current document's own entries — those are offered as the file's own
 * declarations/routines — and pre-renders `detail` (variable type, or the
 * routine's full signature).
 */
export interface WorkspaceNamedFact {
  /** Declared spelling (ESQL names are case-insensitive; keep the original). */
  name: string;
  /** Human-readable kind: the variable's type, or the routine's signature. */
  detail: string;
  /** Base name of the declaring file, for display. */
  file: string;
}

/** What the general list may offer beyond built-ins and declared names. */
export interface CompletionFacts {
  /** The current file's own routines; default: `routinesFromSource(source)`. */
  routines?: RoutineInfo[];
  /** `DECLARE … SHARED` variables declared in sibling files (C-2). */
  sharedVars?: WorkspaceNamedFact[];
  /** Routines declared in sibling files, the `CALL` targets (C-1). */
  workspaceRoutines?: WorkspaceNamedFact[];
}

/** `FUNCTION Main() RETURNS BOOLEAN` / `PROCEDURE CopyHeader(IN amount INTEGER)`. */
function routineSignature(r: RoutineInfo): string {
  const params = r.params.replace(/\s+/g, ' ').trim();
  const head = `${r.kind} ${r.name}(${params})`;
  return r.kind === 'FUNCTION' && r.returnType ? `${head} RETURNS ${r.returnType}` : head;
}

/**
 * The current file's own `CREATE FUNCTION|PROCEDURE` names (C-1): a `CALL`
 * target is a completion, and until now the general list only knew the
 * built-in function table. Unlike declared names these are NOT scope-filtered
 * — a routine is callable from anywhere in the file (and from sibling files,
 * where they arrive through `workspaceRoutines` instead).
 */
function routineItems(routines: RoutineInfo[]): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const r of routines) {
    const upper = r.name.toUpperCase();
    if (seen.has(upper)) continue; // a re-creation declares the name once
    seen.add(upper);
    const item = ci(r.name, CompletionItemKind.Function);
    item.detail = routineSignature(r);
    rankUser(item);
    items.push(item);
  }
  return items;
}

/**
 * Sibling-file routines and SHARED variables (C-1/C-2), from the server's one
 * merged workspace view. `in <file> · <signature>` / `SHARED, declared in
 * <file>` marks the provenance the same way cross-file hover does — the
 * client shows where the name really lives.
 */
function workspaceFactItems(facts: CompletionFacts): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const r of facts.workspaceRoutines ?? []) {
    const key = `R|${r.name.toUpperCase()}`;
    if (seen.has(key)) continue; // one row per name; the first (live-first merge) wins
    seen.add(key);
    const item = ci(r.name, CompletionItemKind.Function);
    item.detail = `in ${r.file} · ${r.detail}`;
    rankUser(item);
    items.push(item);
  }
  for (const v of facts.sharedVars ?? []) {
    const key = `V|${v.name.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = ci(v.name, CompletionItemKind.Variable);
    item.detail = `SHARED, declared in ${v.file}`;
    if (v.detail) item.documentation = markdown(`Type: ${v.detail}`);
    rankUser(item);
    items.push(item);
  }
  return items;
}

function filterByPrefix(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (!prefix) return items;
  const p = prefix.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(p));
}

/** The word currently being typed (may be empty). */
export function wordBeingTyped(linePrefix: string): string {
  const m = linePrefix.match(/[A-Za-z_]\w*$/);
  return m ? m[0] : '';
}

/**
 * The next-word rule that holds at the cursor, or undefined.
 *
 * Rules are tested against the MASKED line prefix with the word currently
 * being typed removed (same string/comment blanking as all pattern analysis —
 * a `'END '` inside a string literal does not open an END clause). The masked
 * prefix keeps offsets identical to the raw text, so removing the trailing
 * word afterwards is exact. FIRST MATCH WINS: the table is ordered specific
 * to general.
 *
 * C-6: callers holding a parse tree also pass the clause prefix it read
 * (`clausePrefixAt` — masked and whitespace-collapsed, so it needs no second
 * mask). A rule matched on that TRUE prefix wins outright: a continuation
 * line `DELETE ` inside a PROPAGATE would otherwise pick the line-anchored
 * `delete-statement` instead of `propagate-delete`. When the clause prefix
 * matches no rule the line prefix still decides, which is how a line-anchored
 * clause whose statement text sits further back (typing `END ` inside a long
 * IF body, where the clause prefix is the whole IF) keeps narrowing as it
 * always did. The WORDS never come from the tree — one table, both modes.
 */
export function nextWordRuleFor(
  linePrefix: string,
  clausePrefix?: string
): NextWordRule | undefined {
  if (clausePrefix) {
    const rule = ruleForMaskedPrefix(clausePrefix);
    if (rule) return rule;
  }
  return ruleForMaskedPrefix(scan(linePrefix).masked);
}

/** One prefix — already masked — through the table, trailing word removed. */
function ruleForMaskedPrefix(maskedPrefix: string): NextWordRule | undefined {
  const word = wordBeingTyped(maskedPrefix);
  const beforeWord = word ? maskedPrefix.slice(0, maskedPrefix.length - word.length) : maskedPrefix;
  return NEXT_WORD_RULES.find((r) => r.pattern.test(beforeWord));
}

/**
 * Completion items for one clause position: the rule's clause keywords
 * (with the rule's shared detail), then its datatypes carrying their
 * ESQL_TYPES documentation, so a narrowed list documents its types exactly
 * like the general list does.
 */
function nextWordItems(rule: NextWordRule): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const w of rule.words) {
    const item = ci(
      w,
      w === '=' ? CompletionItemKind.Operator : CompletionItemKind.Keyword
    );
    item.detail = rule.detail;
    rankClause(item);
    items.push(item);
  }
  for (const t of rule.types ?? []) {
    const item = ci(t, CompletionItemKind.TypeParameter);
    item.detail = 'ESQL data type';
    const doc = ESQL_TYPES.find((d) => d.name === t)?.description;
    if (doc) item.documentation = markdown(doc);
    rankClause(item);
    items.push(item);
  }
  return items;
}

/**
 * One item per label. The lists the `general` context concatenates overlap: the
 * same word is a keyword *and* a data type (`INTEGER`), a keyword *and* a
 * function (`EXISTS`), and a declared variable can shadow a built-in (`FLOOR`
 * in a file that declares `DECLARE floor CHARACTER`). A client shows each of
 * those as its own row with identical text, which is pure noise
 * (ISSUES.md I-17). Merging keeps the form that says the most about what will be
 * inserted.
 *
 * Matching is on the exact label, *not* case-folded: `IF` (keyword, inserts
 * `IF`) and `if` (snippet, expands a block) are two different completions that
 * merely look alike at a glance, and folding them made one of them vanish. They
 * stay.
 */
const KIND_PREFERENCE: ReadonlyMap<CompletionItemKind, number> = new Map([
  [CompletionItemKind.Variable, 0], // declared names and message tree variables
  [CompletionItemKind.Snippet, 2], // snippets expand into real text
  [CompletionItemKind.Function, 3],
  [CompletionItemKind.TypeParameter, 4], // the data types are TypeParameter kind
  [CompletionItemKind.Keyword, 5], // "ESQL keyword" says the least
]);

function dedupeByLabel(
  items: CompletionItem[],
  preferred: ReadonlySet<CompletionItem> = new Set()
): CompletionItem[] {
  const rankOf = (item: CompletionItem): number =>
    preferred.has(item)
      ? -1 // this document's own declared names beat any built-in of the same kind
      : KIND_PREFERENCE.get(item.kind ?? CompletionItemKind.Keyword) ?? 9;
  const best = new Map<string, CompletionItem>();
  for (const item of items) {
    const held = best.get(item.label);
    if (!held) {
      best.set(item.label, item);
      continue;
    }
    if (rankOf(item) < rankOf(held)) best.set(item.label, item);
  }
  const kept = new Set(best.values());
  const out: CompletionItem[] = [];
  for (const item of items) {
    if (!kept.has(item)) continue;
    kept.delete(item); // keep exactly one, at its first position
    out.push(item);
  }
  return out;
}

/**
 * Declared names a position may actually use. Every entry carries the `scope`
 * the parser computed for it (routine body / module / file), and offering the
 * ones that are not in scope makes the list grow with the number of routines in
 * the file rather than shrink to what is legal here: one real file offered all
 * 20 names declared anywhere, at a position inside a routine that could see none
 * of them (ISSUES.md I-16). Without a position (no caller context) nothing is
 * filtered, which is the pre-I-16 behaviour.
 */
export function declarationsInScope(
  declarations: DeclaredName[],
  scope?: { line: number; character: number }
): DeclaredName[] {
  if (!scope) return declarations;
  return visibleDeclarationsAt(declarations, scope.line, scope.character);
}

export function buildCompletionItems(
  context: CompletionContextKind,
  linePrefix: string,
  source: string,
  declarations?: DeclaredName[],
  position?: { line: number; character: number },
  /** Whether the client declared `completionItem.snippetSupport`. Default
   * true (what direct callers and tests expect); `server.ts` passes the real
   * capability so snippetless clients get de-placeholdered PlainText. */
  snippetSupport = true,
  /** The file's own routines and the workspace's SHARED names for the
   * GENERAL list (C-1/C-2). They never enter a clause-narrowed list. */
  facts?: CompletionFacts,
  /** C-6: the clause prefix the parse tree read at the cursor (masked,
   * collapsed; `clausePrefixAt`). Grammar mode only; it re-anchors BOTH the
   * clause narrowing and the dotted/DECLARE contexts onto the full clause
   * when the cursor's own line is only part of it. */
  clausePrefix?: string
): CompletionItem[] {
  // C-6 context remap: the cursor line can end in `.JSON.` or `DECLARE x `
  // just as truly when the clause began on an earlier line. Only the GENERAL
  // line verdict is overridden, and the clause prefix then serves as the
  // linePrefix of that call so the branch's own position tests — and the
  // prefix filter — read the clause, not the fragment.
  if (context === 'general' && clausePrefix) {
    const clauseContext = detectCompletionContext(clausePrefix);
    if (clauseContext !== 'general') {
      return buildCompletionItems(
        clauseContext,
        clausePrefix,
        source,
        declarations,
        position,
        snippetSupport,
        facts,
        clausePrefix
      );
    }
  }
  const prefix = wordBeingTyped(linePrefix);

  switch (context) {
    case 'json-data': {
      const data = ci('Data', CompletionItemKind.Property);
      data.detail = 'JSON payload container';
      data.documentation = markdown('Continue with `.Data.<field>` to address the JSON payload.');
      // PLAN task 18: the list carries a second item teaching the single
      // most common JSON-output bug — building `JSON.Data` while leaving the
      // message-level Properties behind (the `output-root-properties` check
      // publishes that hint; the item doc points at the same line). The doc
      // states where the properties actually live instead of asserting a
      // `JSON.Properties` folder — the ACE page for the JSON tree structure
      // could not be re-read in this build environment (network egress
      // blocked), and a completion doc must not claim structure it could not
      // verify.
      const props = ci('Properties', CompletionItemKind.Property);
      props.detail = 'Copy the incoming message properties (the usual bug)';
      props.documentation = markdown(
        'Properties do not live under `JSON.` — the properties that travel with a ' +
          'message live at `<root>.Properties`, and ACE does not carry them into the ' +
          'reply by itself. When building JSON output, copy them at the routine head:\n\n' +
          '```esql\nSET OutputRoot.Properties = InputRoot.Properties;\n```\n\n' +
          'The `output-root-properties` hint flags a `SET OutputRoot.JSON.Data` line ' +
          'whose routine never copies them.'
      );
      return filterByPrefix([data, props], prefix);
    }
    case 'xmlns-root': {
      const item = ci('Root', CompletionItemKind.Property);
      item.detail = 'XML root element';
      item.documentation = markdown(
        'Replace with your XML root element name. ' +
          'Model-driven (XSD/MRM) completion is planned for a later phase.'
      );
      return [item];
    }
    case 'domains':
      return filterByPrefix(domainItems(ESQL_DOMAINS), prefix);
    case 'local-env':
      return filterByPrefix(domainItems(ESQL_LOCAL_ENVIRONMENT_FIELDS), prefix);
    case 'datasource': {
      // Static placeholder, honestly labelled: datasource names are runtime
      // configuration, and the server has no Integration Server to ask.
      const item = ci('DS_YOUR_DATASOURCE', CompletionItemKind.Reference);
      item.detail = 'Database datasource';
      item.documentation = markdown(
        'Replace with the datasource name configured in the Integration Server ' +
          '(JDBC/ODBC configurable service), e.g. `DS_ORACLE_PROD`.\n\n' +
          '**Example:**\n\n```esql\nSET Connection = myDatasource;\n```\n\n' +
          'or per statement, e.g. `PASSTHRU ... TO Database.myDatasource` / ' +
          '`SELECT ... AT myDatasource`.'
      );
      return [item];
    }
    case 'types': {
      const items = typeItems();
      if (/\bDECLARE\s+[A-Za-z_]\w*\s+$/i.test(linePrefix)) {
        const c = ci('CONSTANT', CompletionItemKind.TypeParameter);
        c.detail = 'Declares the variable as a constant (use before the type)';
        items.unshift(c);
      }
      return filterByPrefix(items, prefix);
    }
    case 'general': {
      // Clause-aware narrowing: a clause prefix that ends at a clause
      // position in the next-words table offers only the words that legally
      // continue it (additive rules keep the general list alongside them).
      // The table is the same in both parse modes; grammar mode additionally
      // hands it the clause the tree read, so a wrapped clause narrows like
      // its single-line form (C-6).
      const rule = nextWordRuleFor(linePrefix, clausePrefix);
      const generalItems = (): CompletionItem[] => {
        const declared = declarations
          ? declarationsInScope(declarations, position)
          : declarationsInScope(declarationsFromSource(source), position);
        const declaredItems = declaredItemsFromTree(declared);
        // C-1/C-2: the file's own routines and the workspace's SHARED names
        // join the GENERAL list only — the closed clause lists (`= `, TYPE,
        // VALUE…) stay closed, and additive rules carry them alongside the
        // narrowed words exactly like every other general item.
        const ownRoutines = routineItems(facts?.routines ?? routinesFromSource(source));
        const wsItems = facts ? workspaceFactItems(facts) : [];
        return dedupeByLabel(
          [
            ...functionItems(),
            ...keywordItems(),
            ...treeVarItems(),
            ...typeItems(),
            ...declaredItems,
            ...ownRoutines,
            ...wsItems,
            ...snippetItems(snippetSupport),
          ],
          // This document's own names — declared OR routine — beat any
          // built-in and any same-named workspace fact: a file that declares
          // `Counter` itself completes its own type, not a sibling's.
          new Set([...declaredItems, ...ownRoutines])
        );
      };
      if (rule) {
        // Clause narrowing is CONTEXT, not prefix: it stays, and the clause
        // words keep their own prefix pruning (a `DELETE F` still means F).
        const narrowed = nextWordItems(rule);
        if (!rule.additive) return filterByPrefix(narrowed, prefix);
        const head = filterByPrefix(narrowed, prefix);
        return dedupeByLabel([...head, ...generalItems()], new Set(head));
      }
      // C-3: the general list ships WHOLE. `startsWith` server-side was
      // deleting the candidates the client's fuzzy/subsequence matcher could
      // have matched (`datetype` → `DATETIME` never arrived); the protocol's
      // intent is to send the context-relevant set and let the client
      // filter — items carry filterText/sortText for that contract, and the
      // clause table above is the context cut instead of the prefix.
      return generalItems();
    }
  }
}
